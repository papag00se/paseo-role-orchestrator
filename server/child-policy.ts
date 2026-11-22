import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { PARENT_AGENT_LABEL } from "../shared/role-runs";
import { CHILD_POLICY_LABEL, CHILD_POLICY_PARENT_ONLY, CHILD_PROVIDER_REFUSAL, WORKER_PROVIDER } from "../shared/roles";
import { applyRoleLaunchOptions } from "./launch-options";
import { WORKER_SERVER_KEY, type RoleToolsRuntime } from "./role-tools";

/**
 * One-time passes for children the plugin itself creates under a restricted parent (context
 * summaries, completion judges). They are the plugin's own helpers, not the parent's subagents, so
 * they may use any provider. A pass is spent on first use: copying the label from a listing onto a
 * later create_agent call does not work.
 */
export const SANCTIONED_LABEL = "paseo-role-orchestrator.sanctioned-launch";
const passes = new Set<string>();

export function sanctionedLaunchLabels(): Record<string, string> {
  const pass = randomUUID();
  passes.add(pass);
  return { [SANCTIONED_LABEL]: pass };
}

const shimDirectory = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "role-orchestrator-worker-bin");
const SHIM = `#!/bin/sh
echo "The paseo CLI is disabled for this agent. Your only channel to another agent is the message_parent tool." >&2
exit 1
`;

/** A `paseo` that refuses, first on a worker's PATH. A speed bump: an absolute path to the real CLI still works. */
async function ensureShim(): Promise<string> {
  await mkdir(shimDirectory, { recursive: true });
  const file = join(shimDirectory, "paseo");
  await writeFile(file, SHIM, { mode: 0o755 });
  await chmod(file, 0o755);
  return shimDirectory;
}

/**
 * Restricted parents (their agent carries CHILD_POLICY_LABEL, stamped at launch) may only create
 * subagents on the worker provider. The check runs before the provider session is created, so a
 * refusal starts no process. A worker gets one tool, `message_parent`, and a `paseo` that refuses.
 * Only creation is enforced: an existing child reopens as it was, with its tool and shim re-attached.
 */
export function installChildPolicy(server: PluginServerContext, tools: Promise<RoleToolsRuntime>): () => void {
  return server.before("agent.session_open", async ({ request }, { paseo }) => {
    const restricted = (await restrictChildren(request, paseo, tools)) ?? request;
    // The role's launch options (cache lifetime, compaction trigger) apply on top of the policy's result.
    const result = request.purpose === "interactive" ? await applyRoleLaunchOptions(restricted) : restricted;
    return result === request ? undefined : result;
  });
}

async function restrictChildren(request: PluginSessionOpenRequest, paseo: PaseoApi, tools: Promise<RoleToolsRuntime>) {
  const parentId = request.labels[PARENT_AGENT_LABEL];
  if (request.purpose !== "interactive" || !parentId) return;
  const pass = request.labels[SANCTIONED_LABEL];
  if (request.reason === "create" && pass && passes.delete(pass)) return;

  const runtime = await tools;
  runtime.connect(paseo);
  const parent = (await paseo.agents.ref(parentId).refresh())?.agent;
  if (parent?.labels[CHILD_POLICY_LABEL] !== CHILD_POLICY_PARENT_ONLY) return;

  if (request.provider !== WORKER_PROVIDER) {
    if (request.reason === "create") throw new Error(CHILD_PROVIDER_REFUSAL);
    return;
  }
  const binDirectory = await ensureShim();
  return {
    ...request,
    env: { ...request.env, PATH: [binDirectory, process.env.PATH].filter(Boolean).join(delimiter) },
    mcpServers: { ...request.mcpServers, [WORKER_SERVER_KEY]: runtime.workerMcpServer(request.agentId) },
  };
}
