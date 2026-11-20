import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { PARENT_AGENT_LABEL } from "../shared/role-runs";
import { ROLE_LABEL, providerModel, type Role } from "../shared/roles";
import { getRoles } from "./roles";
import { EMPTY_SCHEMA, PAUSE_LOOP_DESCRIPTION, RESUME_LOOP_DESCRIPTION, pauseByAgent, resumeByAgent } from "./loop-control";
import {
  allowedChildRoles,
  launchRole,
  type LaunchRequest,
  type ParentContext,
} from "./role-launch";

export type McpServerEntry = PluginSessionOpenRequest["mcpServers"][string];

export const SERVER_KEY = "roles";
/** MCP server key and endpoint path of the single `message_parent` tool given to restricted workers. */
export const WORKER_SERVER_KEY = "parent";
const WORKER_MCP_PATH = "/worker-mcp";
/** Endpoint of the `pause_loop` and `resume_loop` tools every role-launched agent is given. */
const LOOP_MCP_PATH = "/loop-mcp";
const PROTOCOL_VERSION = "2025-06-18";

/**
 * Providers whose contract declares `supportsExactMcpPreapproval`. Paseo does not expose
 * that capability to plugins, and agent creation fails with `tool_policy_unsupported`
 * when `toolPolicy` reaches a provider without it. Plugin-contributed ACP providers also
 * support it; they are omitted here only because they cannot be enumerated, which costs
 * preapproval convenience and nothing else.
 * See packages/server/src/server/agent/provider-registry.ts (PROVIDER_CONTRACTS).
 */
const EXACT_MCP_PREAPPROVAL_PROVIDERS = new Set(["claude", "codex", "opencode"]);

const stateFile = join(
  process.env.PASEO_HOME || join(homedir(), ".paseo"),
  "plugin-data",
  "role-orchestrator-tools.json",
);

interface Grant {
  /** Empty until the launched agent's ID is known; bound immediately after creation. */
  parentAgentId: string;
  parentRoleId: string;
  createdAt: string;
}

interface StoredState {
  version: 1;
  port: number | null;
  grants: Record<string, Grant>;
  /** Signs worker and loop-tool credentials, so they need no per-agent storage and survive reopen and reload. */
  workerSecret: string;
}

function emptyState(): StoredState {
  return { version: 1, port: null, grants: {}, workerSecret: randomBytes(32).toString("base64url") };
}

export async function loadState(): Promise<StoredState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as Partial<StoredState>;
    if (!parsed || typeof parsed !== "object") return emptyState();
    return {
      version: 1,
      port: typeof parsed.port === "number" ? parsed.port : null,
      grants: parsed.grants && typeof parsed.grants === "object" ? parsed.grants : {},
      workerSecret: typeof parsed.workerSecret === "string" && parsed.workerSecret ? parsed.workerSecret : randomBytes(32).toString("base64url"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

async function saveState(state: StoredState): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, stateFile);
}

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

export const LAUNCH_DESCRIPTION = [
  "Delegate a task to one of your configured child roles. This is the correct way to delegate; prefer it",
  "over the generic create_agent tool for every child.",
  "",
  "Unlike generic create_agent, one call applies all of this server-side and verified:",
  "1. the child's complete role operating contract as its system prompt,",
  "2. the role's provider, default model, reasoning level and mode, with optional per-launch model and reasoning overrides,",
  "3. the role label Paseo needs to track and judge it as a role run,",
  "4. the parent/child link, so its final result is reported back to you,",
  "5. placement in your own workspace and working tree (never a new workspace, worktree or branch),",
  "6. whatever parent-session context that role pair is configured to inherit, and",
  "7. the child's own delegation tools when that role may delegate further.",
  "",
  "The model override is an ID within the role's provider, not a different Paseo provider. Use list_models to discover model IDs and their thinking options. Overrides affect only this launch and do not change the saved role.",
  "Your permitted roles are enforced here: an unlisted role is rejected with the list you may use.",
  "Follow up with send_agent_prompt to the returned agentId; launch a new child only for new work.",
].join("\n");

export const LAUNCH_SCHEMA = {
  type: "object",
  properties: {
    role: {
      type: "string",
      description:
        'Which child role to launch. Accepts the role ID or the exact role name (for example "Coder"). Call list_roles if unsure.',
    },
    prompt: {
      type: "string",
      description:
        "The complete assigned task: objective, scope boundary, constraints, deliverables and acceptance criteria. Do NOT paste the role's operating contract here; it is applied automatically as the child's system prompt.",
    },
    title: {
      type: "string",
      description:
        'Short session title for the child, for example "Repair buyer session expiry". Defaults to the role name.',
    },
    parentContext: {
      type: "string",
      enum: ["none", "full"],
      description:
        'How much of your own session the child inherits. Defaults to the configured value for this role pair. "full" attaches your complete timeline unedited. To pass along only part of it, leave this "none" and write the context the child needs into `prompt` yourself.',
    },
    model: {
      type: "string",
      minLength: 1,
      maxLength: 240,
      description: "Optional model ID within the role's provider, as returned by list_models (for example openai/gpt-6.1-terra for Pi). Omit to use the role's configured model.",
    },
    thinkingOptionId: {
      type: ["string", "null"],
      minLength: 1,
      maxLength: 160,
      description: "Optional reasoning option ID for the selected model, as returned by list_models. Omit to use the role's configured level, or pass null to use the provider default.",
    },
  },
  required: ["role", "prompt"],
  additionalProperties: false,
} as const;

export const MESSAGE_PARENT_DESCRIPTION = [
  "Send a message to the agent that launched you. This is your only channel to any other agent: you have no other Paseo tools.",
  "Use it for a blocking question, a decision you need, or an important finding before you finish.",
  "Your final report reaches your parent automatically when you finish, so do not repeat it here.",
].join("\n");

export const MESSAGE_PARENT_SCHEMA = {
  type: "object",
  properties: { message: { type: "string", minLength: 1, description: "The message for your parent agent." } },
  required: ["message"],
  additionalProperties: false,
} as const;

export const LIST_DESCRIPTION = [
  "List the child roles you may delegate to, with the exact ID, description, provider/model, reasoning",
  "settings, inherited-context default, and whether that role may delegate further.",
  "Call this when choosing an owner for a task, or if launch_role rejects a role name.",
].join("\n");

export function describeRole(role: Role, parent: Role, roles: readonly Role[]) {
  return {
    id: role.id,
    name: role.name,
    description: role.description || null,
    provider: providerModel(role),
    thinkingOptionId: role.thinkingOptionId,
    modeId: role.modeId,
    inheritsParentContext: parent.delegation.childContexts[role.id] ?? "none",
    canDelegateFurther: allowedChildRoles(role, roles).length > 0,
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface RoleToolsRuntime {
  /** Launch a role, attaching delegation tools to the child when that role may delegate. */
  /** Remember the daemon API so agent-called tools work after a plugin reload. */
  connect(paseo: PaseoApi): void;
  /** MCP server entry (launch-only) giving one restricted worker its `message_parent` tool. */
  workerMcpServer(agentId: string): McpServerEntry;
  /** MCP server entry (launch-only) giving one role-launched agent its `pause_loop` and `resume_loop` tools. */
  loopMcpServer(agentId: string): McpServerEntry;
  launch(paseo: PaseoApi, request: LaunchRequest): ReturnType<typeof launchRole>;
  port(): number | null;
  close(): Promise<void>;
}

class JsonRpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export async function installRoleTools(): Promise<RoleToolsRuntime> {
  const state = await loadState();
  await saveState(state); // persists a newly minted worker secret before any credential is signed with it

  const mintToken = (parentRoleId: string): string => {
    const token = randomBytes(24).toString("base64url");
    state.grants[token] = { parentAgentId: "", parentRoleId, createdAt: new Date().toISOString() };
    return token;
  };

  const configFragment = (token: string, provider: string): Record<string, unknown> | undefined => {
    if (!state.port) return undefined;
    return {
      mcpServers: {
        [SERVER_KEY]: {
          type: "http",
          url: `http://127.0.0.1:${state.port}/mcp`,
          headers: { authorization: `Bearer ${token}` },
          alwaysLoad: true,
        },
      },
      // Paseo rejects agent creation outright when a provider cannot preapprove exact MCP
      // tools, so this is sent only to the providers that can. Everywhere else the tools
      // still work, they just follow the session's normal permission behaviour.
      ...(EXACT_MCP_PREAPPROVAL_PROVIDERS.has(provider)
        ? {
            toolPolicy: {
              preapproved: [
                { kind: "mcp", server: SERVER_KEY, tool: "launch_role" },
                { kind: "mcp", server: SERVER_KEY, tool: "list_roles" },
              ],
            },
          }
        : {}),
    };
  };

  const launch = async (paseo: PaseoApi, request: LaunchRequest) => {
    // The credential must be inside the child's config at creation, but it identifies an
    // agent that does not exist yet. Mint first, bind to the real ID immediately after.
    let issued: string | null = null;
    const result = await launchRole(paseo, request, (child, canDelegate) => {
      if (!canDelegate) return undefined;
      issued = mintToken(child.id);
      return configFragment(issued, child.provider);
    });
    if (issued) {
      const grant = state.grants[issued];
      if (grant) grant.parentAgentId = result.agentId;
    }
    await saveState(state);
    return result;
  };

  // One signing key, one domain per tool family, so a worker credential cannot be used on the loop endpoint or the reverse.
  const signature = (domain: string, agentId: string) => createHmac("sha256", state.workerSecret).update(`${domain}:${agentId}`).digest("base64url");
  const signedServer = (path: string, domain: string, agentId: string, what: string): McpServerEntry => {
    if (!state.port) throw new Error(`The role plugin has no MCP port, so ${what} cannot be attached.`);
    return {
      type: "http",
      url: `http://127.0.0.1:${state.port}${path}`,
      headers: { authorization: `Bearer ${agentId}.${signature(domain, agentId)}` },
      alwaysLoad: true,
    };
  };
  const workerMcpServer = (agentId: string) => signedServer(WORKER_MCP_PATH, "worker", agentId, "message_parent");
  const loopMcpServer = (agentId: string) => signedServer(LOOP_MCP_PATH, "loop", agentId, "pause_loop");
  const signedAgent = (request: IncomingMessage, domain: string): string => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const split = token.lastIndexOf(".");
    const agentId = split > 0 ? token.slice(0, split) : "";
    const expected = Buffer.from(agentId ? signature(domain, agentId) : "");
    const given = Buffer.from(split > 0 ? token.slice(split + 1) : "");
    if (!agentId || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new JsonRpcError(-32001, `Unrecognized ${domain} credential.`);
    }
    return agentId;
  };

  const grantFor = (request: IncomingMessage): Grant => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const grant = token ? state.grants[token] : undefined;
    if (!grant?.parentAgentId) throw new JsonRpcError(-32001, "Unrecognized delegation credential.");
    return grant;
  };

  let paseoApi: PaseoApi | null = null;
  const requirePaseo = (): PaseoApi => {
    if (!paseoApi) throw new Error("The role plugin is not connected to Paseo yet.");
    return paseoApi;
  };

  const callTool = async (grant: Grant, name: string, args: Record<string, unknown>) => {
    const { roles } = await getRoles();
    const parent = roles.find((role) => role.id === grant.parentRoleId);
    if (!parent) throw new Error("This agent's role no longer exists, so it cannot delegate.");

    if (name === "list_roles") {
      const allowed = allowedChildRoles(parent, roles);
      return {
        parentRole: parent.name,
        roles: allowed.map((role) => describeRole(role, parent, roles)),
        ...(allowed.length === 0
          ? { note: `The ${parent.name} role is not permitted to delegate to any child role.` }
          : {}),
      };
    }

    if (name === "launch_role") {
      const role = typeof args.role === "string" ? args.role : "";
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      if (!role) throw new Error("`role` is required: pass a role ID or exact role name from list_roles.");
      if (!prompt.trim()) throw new Error("`prompt` is required: describe the complete assigned task.");
      if (args.model !== undefined && (typeof args.model !== "string" || !args.model.trim() || args.model.trim().length > 240)) {
        throw new Error("`model` must be a non-empty model ID of at most 240 characters.");
      }
      if (args.thinkingOptionId !== undefined && args.thinkingOptionId !== null &&
          (typeof args.thinkingOptionId !== "string" || !args.thinkingOptionId.trim() || args.thinkingOptionId.trim().length > 160)) {
        throw new Error("`thinkingOptionId` must be a non-empty option ID of at most 160 characters, or null for the provider default.");
      }
      const parentContext =
        args.parentContext === "none" || args.parentContext === "full"
          ? (args.parentContext as ParentContext)
          : undefined;

      const result = await launch(requirePaseo(), {
        parent: { agentId: grant.parentAgentId, roleId: grant.parentRoleId },
        role,
        title: typeof args.title === "string" ? args.title : undefined,
        prompt,
        parentContext,
        model: args.model as string | undefined,
        thinkingOptionId: args.thinkingOptionId as string | null | undefined,
      });
      return {
        agentId: result.agentId,
        role: result.role.name,
        roleId: result.role.id,
        provider: result.provider,
        thinkingOptionId: result.thinkingOptionId,
        workspaceId: result.workspaceId,
        cwd: result.cwd,
        parentContextAttached: result.parentContext,
        label: { [ROLE_LABEL]: result.role.id },
        canDelegateFurther: result.canDelegate,
        followUp:
          "Send further instructions for this work to this same agentId with send_agent_prompt; its result is reported back to you when it finishes.",
      };
    }

    throw new JsonRpcError(-32601, `Unknown tool: ${name}`);
  };

  const messageParent = async (childId: string, args: Record<string, unknown>) => {
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (!message) throw new Error("`message` is required: say what your parent needs to know.");
    const paseo = requirePaseo();
    const child = (await paseo.agents.ref(childId).refresh())?.agent;
    const parentId = child?.labels[PARENT_AGENT_LABEL];
    if (!parentId) throw new Error("This agent has no parent to message.");
    await paseo.agents.ref(parentId).send(`Message from your subagent "${child.title || childId}" (agent ${childId}):\n\n${message}`);
    return { delivered: true, parentAgentId: parentId };
  };

  const handle = async (request: IncomingMessage, body: string): Promise<unknown | null> => {
    const message = JSON.parse(body) as {
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    };
    const id = message.id ?? null;
    const respond = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const path = request.url?.split("?")[0];
    // Each endpoint is its own tool family with its own credential: workers, the loop tools, and delegating parents.
    const family = path === WORKER_MCP_PATH ? "worker" : path === LOOP_MCP_PATH ? "loop" : "roles";

    if (message.method === "initialize") {
      return respond({
        protocolVersion:
          typeof message.params?.protocolVersion === "string"
            ? message.params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "paseo-role-orchestrator", version: "1.0.0" },
        instructions: {
          worker: "Use message_parent to reach the agent that launched you.",
          loop: "Use pause_loop when a periodic prompt arrives and you have nothing to do; any real prompt resumes your periodic prompts.",
          roles: "Delegate every child of a configured role with launch_role. It applies the role contract, provider, label, parent link and workspace placement that generic create_agent cannot.",
        }[family],
      });
    }
    if (message.method?.startsWith("notifications/")) return null;
    if (message.method === "ping") return respond({});
    if (message.method === "tools/list") {
      if (family === "worker") {
        return respond({ tools: [{ name: "message_parent", description: MESSAGE_PARENT_DESCRIPTION, inputSchema: MESSAGE_PARENT_SCHEMA }] });
      }
      if (family === "loop") {
        return respond({
          tools: [
            { name: "pause_loop", description: PAUSE_LOOP_DESCRIPTION, inputSchema: EMPTY_SCHEMA },
            { name: "resume_loop", description: RESUME_LOOP_DESCRIPTION, inputSchema: EMPTY_SCHEMA },
          ],
        });
      }
      return respond({
        tools: [
          { name: "launch_role", description: LAUNCH_DESCRIPTION, inputSchema: LAUNCH_SCHEMA },
          {
            name: "list_roles",
            description: LIST_DESCRIPTION,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      });
    }
    if (message.method === "tools/call") {
      const name = String(message.params?.name ?? "");
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      // The credential is checked before the call, so a bad one is a protocol error rather than a tool failure.
      const run: () => Promise<unknown> = (() => {
        if (family === "worker") {
          const workerId = signedAgent(request, "worker");
          return async () => {
            if (name !== "message_parent") throw new JsonRpcError(-32601, `Unknown tool: ${name}`);
            return messageParent(workerId, args);
          };
        }
        if (family === "loop") {
          const agentId = signedAgent(request, "loop");
          return async () => {
            if (name === "pause_loop") return pauseByAgent(requirePaseo(), agentId);
            if (name === "resume_loop") return resumeByAgent(requirePaseo(), agentId);
            throw new JsonRpcError(-32601, `Unknown tool: ${name}`);
          };
        }
        const grant = grantFor(request);
        return () => callTool(grant, name, args);
      })();
      try {
        const result = await run();
        return respond({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        });
      } catch (error) {
        // Tool failures are reported in-band with the correction, so the model can retry.
        const text = error instanceof Error ? error.message : String(error);
        return respond({ content: [{ type: "text", text }], isError: true });
      }
    }
    throw new JsonRpcError(-32601, `Unknown method: ${message.method}`);
  };

  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" }).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      let payload: unknown | null;
      try {
        payload = await handle(request, Buffer.concat(chunks).toString("utf8"));
      } catch (error) {
        const code = error instanceof JsonRpcError ? error.code : -32603;
        const text = error instanceof Error ? error.message : String(error);
        payload = { jsonrpc: "2.0", id: null, error: { code, message: text } };
      }
      if (payload === null) {
        response.writeHead(202).end();
        return;
      }
      if ((request.headers.accept ?? "").includes("text/event-stream")) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE" || !state.port) {
        reject(error);
        return;
      }
      // Agents configured against the old port lose the tool until they are relaunched;
      // say so rather than failing the whole plugin.
      console.warn(
        `Role delegation port ${state.port} is unavailable; already-running role agents lose launch_role until relaunched.`,
      );
      state.port = null;
      http.listen(0, "127.0.0.1", resolve);
    };
    http.once("error", onError);
    http.listen(state.port ?? 0, "127.0.0.1", () => {
      http.off("error", onError);
      resolve();
    });
  });

  const address = http.address();
  if (address && typeof address !== "string" && address.port !== state.port) {
    state.port = address.port;
    await saveState(state);
  }
  console.log(`Role delegation tools listening on 127.0.0.1:${state.port}`);

  return {
    connect: (paseo) => {
      paseoApi = paseo;
    },
    workerMcpServer,
    loopMcpServer,
    launch: (paseo, request) => {
      paseoApi = paseo;
      return launch(paseo, request);
    },
    port: () => state.port,
    async close() {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
