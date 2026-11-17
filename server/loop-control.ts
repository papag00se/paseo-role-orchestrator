import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { LOOP_ROW_KIND, type LoopState } from "../shared/loop-pause";
import { ROLE_LABEL } from "../shared/roles";
import { forget, pause, readPauses, resume } from "./loop-pause";
import { PERIODIC_MESSAGE_PREFIX, restartInterval } from "./periodic-prompts";
import type { RoleToolsRuntime } from "./role-tools";

/** MCP server key of the loop tools given to every role-launched agent. */
export const LOOP_SERVER_KEY = "loop";

export const PAUSE_LOOP_DESCRIPTION = [
  "Say there is nothing for you to do right now. Your periodic prompts stop until you are woken.",
  "You are woken, and the periodic prompts resume, as soon as you receive any real prompt: a message from the user or from another agent, or a notification that a child finished.",
  "Call this when a periodic prompt arrives and you have no work, are waiting on others, or are done. Do not use it to skip work you could do.",
].join("\n");

export const RESUME_LOOP_DESCRIPTION = [
  "Turn your periodic prompts back on after you paused them with pause_loop.",
  "You rarely need this: any real prompt resumes them by itself. A pause the user set with /roles-pause-agent-loop cannot be resumed from here.",
].join("\n");

export const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;

/** Fewer than this many recent rows is enough to find the user message that started a turn. */
const TAIL_ROWS = 10;

/**
 * A visible marker row where a loop was paused or resumed. Only a marker: a failure to draw it never undoes the change.
 * Appending a timeline row bumps the agent's updatedAt (the daemon touches it), so markers are written only for the
 * events themselves and never on a schedule: a recurring row would keep an idle agent "fresh" for the retention plugin forever.
 */
const announce = async (paseo: PaseoApi, agentId: string, text: string) => {
  try {
    await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: `loop-${randomUUID()}`, kind: LOOP_ROW_KIND, version: 1, data: { text } });
  } catch (error) {
    console.error("Loop marker failed", { agentId, error });
  }
};

const state = (paused: boolean, kind: LoopState["kind"], message: string): LoopState => ({ paused, kind, message });

/** The agent says it has nothing to do: a soft pause that any real prompt ends. */
export async function pauseByAgent(paseo: PaseoApi, agentId: string): Promise<LoopState> {
  const { entry, changed } = await pause(agentId, "agent");
  if (changed) await announce(paseo, agentId, "Periodic prompts paused: the agent has nothing to do. Any real prompt resumes them.");
  if (entry.kind === "user") return state(true, "user", "The user has paused your loop. It stays paused until they resume it; no prompt resumes it.");
  return state(true, "agent", changed
    ? "Loop paused. No periodic prompts until you receive a real prompt (from the user or another agent)."
    : "Loop was already paused. No periodic prompts until you receive a real prompt.");
}

/** The agent turns its own loop back on. It cannot lift the user's hard pause. */
export async function resumeByAgent(paseo: PaseoApi, agentId: string): Promise<LoopState> {
  const { resumed, remaining } = await resume(agentId, "agent");
  if (resumed) {
    await restartInterval(agentId);
    await announce(paseo, agentId, "Periodic prompts resumed by the agent.");
    return state(false, null, "Loop resumed. Periodic prompts will continue.");
  }
  return remaining
    ? state(true, "user", "The user paused your loop. Only they can resume it (/roles-resume-agent-loop).")
    : state(false, null, "Your loop was not paused.");
}

/** The user's `/roles-pause-agent-loop` and `/roles-resume-agent-loop`. A pause here is hard. */
export async function setByUser(paseo: PaseoApi, agentId: string, paused: boolean): Promise<LoopState> {
  const labels = (await paseo.agents.ref(agentId).refresh())?.agent.labels;
  if (!labels?.[ROLE_LABEL]) throw new Error("This agent was not launched from a role, so it has no periodic loop.");
  if (paused) {
    const { changed } = await pause(agentId, "user");
    if (changed) await announce(paseo, agentId, "Periodic prompts paused by the user. Only /roles-resume-agent-loop resumes them.");
    return state(true, "user", changed ? "Loop paused. Only /roles-resume-agent-loop resumes it." : "Loop was already paused by you.");
  }
  const { resumed } = await resume(agentId, "user");
  if (resumed) {
    await restartInterval(agentId);
    await announce(paseo, agentId, "Periodic prompts resumed by the user.");
  }
  return state(false, null, resumed ? "Loop resumed." : "Loop was not paused.");
}

/** Whether the newest user message of the agent's timeline is one this plugin's periodic prompt sent. */
export async function startedByPeriodicPrompt(paseo: PaseoApi, agentId: string): Promise<boolean> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", projection: "canonical", limit: TAIL_ROWS });
  if (page.error) throw new Error(page.error);
  for (let index = page.entries.length - 1; index >= 0; index--) {
    const item = page.entries[index].item as { type: string; messageId?: string };
    if (item.type === "user_message") return item.messageId?.startsWith(PERIODIC_MESSAGE_PREFIX) ?? false;
  }
  return false;
}

/**
 * Lifecycle wiring: a soft-paused agent wakes on a real prompt (never on its own periodic ping);
 * archived and closed agents lose their pause; every role-launched agent gets the loop tools.
 */
export function installLoopControl(server: PluginServerContext, tools: Promise<RoleToolsRuntime>): () => void {
  const removeTurnStarted = server.on("agent.turn_started", async (event, { paseo }) => {
    const agentId = event.agent.id;
    try {
      const current = (await readPauses())[agentId];
      // A hard pause ignores prompts. Only a pause that exists when this turn begins can be ended by it.
      if (current?.kind !== "agent") return;
      const periodic = await startedByPeriodicPrompt(paseo, agentId).catch((error) => {
        console.error("Could not tell what started the turn; treating it as a real prompt", { agentId, error });
        return false;
      });
      if (periodic) return;
      const { resumed } = await resume(agentId, "prompt", current.at);
      if (!resumed) return;
      await restartInterval(agentId);
      await announce(paseo, agentId, "Periodic prompts resumed: a prompt arrived.");
    } catch (error) {
      console.error("Loop resume check failed", { agentId, error });
    }
  });
  const forgetAgent = async (event: { agent: { id: string } }) => forget([event.agent.id]).catch((error) => console.error("Loop cleanup failed", { error }));
  const removeArchived = server.on("agent.archived", forgetAgent);
  const removeClosed = server.on("agent.closed", forgetAgent);
  const removeSessionOpen = server.before("agent.session_open", async ({ request }, { paseo }) => {
    if (request.purpose !== "interactive" || !request.labels[ROLE_LABEL]) return;
    const runtime = await tools;
    runtime.connect(paseo);
    return { ...request, mcpServers: { ...request.mcpServers, [LOOP_SERVER_KEY]: runtime.loopMcpServer(request.agentId) } };
  });
  return () => {
    removeTurnStarted();
    removeArchived();
    removeClosed();
    removeSessionOpen();
  };
}
