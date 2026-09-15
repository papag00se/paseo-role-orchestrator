import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { ROLE_LABEL, providerModel, type Role } from "../shared/roles";
import { getRoles } from "./roles";
import {
  allowedChildRoles,
  launchRole,
  type LaunchRequest,
  type ParentContext,
} from "./role-launch";

export const SERVER_KEY = "roles";
const PROTOCOL_VERSION = "2025-06-18";

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
}

function emptyState(): StoredState {
  return { version: 1, port: null, grants: {} };
}

export async function loadState(): Promise<StoredState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as Partial<StoredState>;
    if (!parsed || typeof parsed !== "object") return emptyState();
    return {
      version: 1,
      port: typeof parsed.port === "number" ? parsed.port : null,
      grants: parsed.grants && typeof parsed.grants === "object" ? parsed.grants : {},
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
  "2. the role's exact provider, model, reasoning level and mode,",
  "3. the role label Paseo needs to track and judge it as a role run,",
  "4. the parent/child link, so its final result is reported back to you,",
  "5. placement in your own workspace and working tree (never a new workspace, worktree or branch),",
  "6. whatever parent-session context that role pair is configured to inherit, and",
  "7. the child's own delegation tools when that role may delegate further.",
  "",
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
      enum: ["none", "summary", "full"],
      description:
        'How much of your own session the child inherits. Defaults to the configured value for this role pair. "summary" costs one short helper run; "full" attaches your complete timeline unedited.',
    },
  },
  required: ["role", "prompt"],
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

  const mintToken = (parentRoleId: string): string => {
    const token = randomBytes(24).toString("base64url");
    state.grants[token] = { parentAgentId: "", parentRoleId, createdAt: new Date().toISOString() };
    return token;
  };

  const configFragment = (token: string): Record<string, unknown> | undefined => {
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
      toolPolicy: {
        preapproved: [
          { kind: "mcp", server: SERVER_KEY, tool: "launch_role" },
          { kind: "mcp", server: SERVER_KEY, tool: "list_roles" },
        ],
      },
    };
  };

  const launch = async (paseo: PaseoApi, request: LaunchRequest) => {
    // The credential must be inside the child's config at creation, but it identifies an
    // agent that does not exist yet. Mint first, bind to the real ID immediately after.
    let issued: string | null = null;
    const result = await launchRole(paseo, request, (child, canDelegate) => {
      if (!canDelegate) return undefined;
      issued = mintToken(child.id);
      return configFragment(issued);
    });
    if (issued) {
      const grant = state.grants[issued];
      if (grant) grant.parentAgentId = result.agentId;
    }
    await saveState(state);
    return result;
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
      const parentContext =
        args.parentContext === "none" || args.parentContext === "summary" || args.parentContext === "full"
          ? (args.parentContext as ParentContext)
          : undefined;

      const result = await launch(requirePaseo(), {
        parent: { agentId: grant.parentAgentId, roleId: grant.parentRoleId },
        role,
        title: typeof args.title === "string" ? args.title : undefined,
        prompt,
        parentContext,
      });
      return {
        agentId: result.agentId,
        role: result.role.name,
        roleId: result.role.id,
        provider: providerModel(result.role),
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

  const handle = async (request: IncomingMessage, body: string): Promise<unknown | null> => {
    const message = JSON.parse(body) as {
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    };
    const id = message.id ?? null;
    const respond = (result: unknown) => ({ jsonrpc: "2.0", id, result });

    if (message.method === "initialize") {
      return respond({
        protocolVersion:
          typeof message.params?.protocolVersion === "string"
            ? message.params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "paseo-role-orchestrator", version: "1.0.0" },
        instructions:
          "Delegate every child of a configured role with launch_role. It applies the role contract, provider, label, parent link and workspace placement that generic create_agent cannot.",
      });
    }
    if (message.method?.startsWith("notifications/")) return null;
    if (message.method === "ping") return respond({});
    if (message.method === "tools/list") {
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
      const grant = grantFor(request);
      const name = String(message.params?.name ?? "");
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await callTool(grant, name, args);
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
