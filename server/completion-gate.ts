import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CompletionGateSettingsSchema, ROLE_LABEL, type CompletionGateSettings } from "../shared/roles";
import { getRoles } from "./roles";

const file = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "role-orchestrator-completion-gate.json");
const GATE_LABEL = "paseo-role-orchestrator.completion-gate";
const QUIESCENCE_DELAY_MS = 1_000;
const defaults: CompletionGateSettings = {
  provider: "",
  model: "",
  thinkingOptionId: null,
  modeId: null,
  prompt: "You are a strict completion gate. Judge whether the user’s ask is fully completed from the supplied session context. Return JSON only: {\"verdict\":\"pass\"} when it is complete; otherwise return {\"verdict\":\"continue\",\"remainingTasks\":[\"specific remaining task\"]}. Use {\"verdict\":\"blocked\",\"remainingTasks\":[\"specific required user input or external blocker\"]} only when progress cannot continue without it.",
  context: "full",
};

type Verdict = { verdict: "pass" } | { verdict: "continue" | "blocked"; remainingTasks: string[] };

export async function getCompletionGateSettings(): Promise<CompletionGateSettings> {
  try {
    return CompletionGateSettingsSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw error;
  }
}

export async function saveCompletionGateSettings(input: CompletionGateSettings): Promise<CompletionGateSettings> {
  const settings = CompletionGateSettingsSchema.parse(input);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return settings;
}

function verdict(text: string): Verdict {
  const parsed: unknown = JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, ""));
  if (!parsed || typeof parsed !== "object") throw new Error("Completion gate returned invalid JSON");
  const value = parsed as { verdict?: unknown; remainingTasks?: unknown };
  if (value.verdict === "pass") return { verdict: "pass" };
  if ((value.verdict !== "continue" && value.verdict !== "blocked") || !Array.isArray(value.remainingTasks) || !value.remainingTasks.every((task) => typeof task === "string" && task.trim())) {
    throw new Error("Completion gate must return pass, or a non-empty remainingTasks list");
  }
  return { verdict: value.verdict, remainingTasks: value.remainingTasks };
}

/** Plugin-only completion enforcement through the public v0.8 lifecycle API. */
export function installCompletionGate(server: PluginServerContext): () => void {
  const pending = new Set<string>();
  const parentByChildId = new Map<string, string>();
  const childIdsByParentId = new Map<string, Set<string>>();
  const activeChildIds = new Set<string>();
  const gateGenerationByAgentId = new Map<string, number>();

  const invalidateGate = (agentId: string) => {
    const next = (gateGenerationByAgentId.get(agentId) ?? 0) + 1;
    gateGenerationByAgentId.set(agentId, next);
    return next;
  };
  const recordChild = (childId: string, parentId: string) => {
    parentByChildId.set(childId, parentId);
    const children = childIdsByParentId.get(parentId) ?? new Set<string>();
    children.add(childId);
    childIdsByParentId.set(parentId, children);
    activeChildIds.add(childId);
  };
  const markChildIdle = (childId: string) => activeChildIds.delete(childId);
  const hasActiveDescendant = (agentId: string, visited = new Set<string>()): boolean => {
    if (visited.has(agentId)) return false;
    visited.add(agentId);
    for (const childId of childIdsByParentId.get(agentId) ?? []) {
      if (activeChildIds.has(childId) || hasActiveDescendant(childId, visited)) return true;
    }
    return false;
  };
  const forgetAgent = (agentId: string) => {
    markChildIdle(agentId);
    const parentId = parentByChildId.get(agentId);
    if (parentId) childIdsByParentId.get(parentId)?.delete(agentId);
    parentByChildId.delete(agentId);
    childIdsByParentId.delete(agentId);
  };

  const removeCreated = server.on("agent.created", ({ agent }) => {
    if (!agent.parentAgentId) return;
    recordChild(agent.id, agent.parentAgentId);
    // Creating a child is progress, never a completion candidate for the parent.
    invalidateGate(agent.parentAgentId);
  });
  const removeStarted = server.on("agent.turn_started", ({ agent }) => {
    if (agent.parentAgentId) recordChild(agent.id, agent.parentAgentId);
    else if (parentByChildId.has(agent.id)) activeChildIds.add(agent.id);
    invalidateGate(agent.id);
  });
  const removeArchived = server.on("agent.archived", ({ agent }) => {
    forgetAgent(agent.id);
    invalidateGate(agent.id);
  });
  const removeTurnEnded = server.on("agent.turn_ended", async (event, { paseo, signal }) => {
    // A finished child can wake its parent. Wait for that coordination turn to settle.
    markChildIdle(event.agent.id);
    const generation = invalidateGate(event.agent.id);
    if (event.outcome.kind !== "completed" || pending.has(event.agent.id)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, QUIESCENCE_DELAY_MS));
    if (gateGenerationByAgentId.get(event.agent.id) !== generation || hasActiveDescendant(event.agent.id)) {
      return;
    }
    const snapshot = await paseo.agents.ref(event.agent.id).refresh();
    const agent = snapshot?.agent;
    if (!agent || agent.labels[GATE_LABEL]) return;
    const roleId = agent.labels[ROLE_LABEL];
    if (!roleId || !event.agent.workspaceId) return;
    const [{ roles }, settings] = await Promise.all([getRoles(), getCompletionGateSettings()]);
    if (!roles.find((role) => role.id === roleId)?.delegation.completionGateEnabled || !settings.provider || !settings.model) return;
    pending.add(event.agent.id);
    try {
      let context = JSON.stringify(event.timeline);
      const workspace = paseo.workspaces.ref(event.agent.workspaceId);
      if (settings.context === "summary") {
        if (!agent.model) throw new Error("The checked agent has no current model for context summary");
        const helper = await workspace.agents.create({ parent: event.agent.id, title: "Preparing completion context", prompt: context, labels: { [GATE_LABEL]: "summary" }, config: { provider: `${agent.provider}/${agent.model}`, ...(agent.thinkingOptionId ? { thinkingOptionId: agent.thinkingOptionId } : {}), ...(agent.currentModeId ? { modeId: agent.currentModeId } : {}), systemPrompt: "Return only a faithful summary of this complete session for a completion judge: user ask, completed work, validation, remaining work, blockers, and evidence. Do not use tools or modify files." } });
        try {
          const result = await helper.waitForFinish();
          if (result.status !== "idle" || !result.lastMessage) throw new Error(result.error || "Context summary failed");
          context = result.lastMessage;
        } finally { await helper.archive().catch(() => undefined); }
      }
      const gate = await workspace.agents.create({ parent: event.agent.id, title: "Completion gate", prompt: `Evaluate this complete session. Return JSON only: {"verdict":"pass"} when the user ask is fully complete, or {"verdict":"continue"|"blocked","remainingTasks":["specific task"]} when it is not.\n\n${context}`, labels: { [GATE_LABEL]: "judge" }, config: { provider: `${settings.provider}/${settings.model}`, ...(settings.thinkingOptionId ? { thinkingOptionId: settings.thinkingOptionId } : {}), ...(settings.modeId ? { modeId: settings.modeId } : {}), systemPrompt: settings.prompt } });
      let result;
      try { result = await gate.waitForFinish(); } finally { await gate.archive().catch(() => undefined); }
      if (result.status !== "idle" || !result.lastMessage) throw new Error(result.error || "Completion gate failed");
      const judged = verdict(result.lastMessage);
      if (judged.verdict === "pass" || judged.verdict === "blocked" || signal.aborted) return;
      pending.delete(event.agent.id);
      await paseo.agents.ref(event.agent.id).run(`The completion gate judged that you didn't complete the user ask. The remaining or incomplete task(s) are as follows:\n\n${judged.remainingTasks.map((task) => `- ${task}`).join("\n")}`);
    } catch (error) {
      console.error("Completion gate failed", { agentId: event.agent.id, error });
    } finally { pending.delete(event.agent.id); }
  });
  return () => {
    removeCreated();
    removeStarted();
    removeArchived();
    removeTurnEnded();
  };
}
