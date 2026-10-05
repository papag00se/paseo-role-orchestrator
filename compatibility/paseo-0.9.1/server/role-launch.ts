import type { PaseoApi } from "@getpaseo/client";
import { ROLE_LABEL, providerModel, systemPromptForRole, type Role } from "../shared/roles";
import { getRoles } from "./roles";

export type ParentContext = "none" | "full" | "summary";

export const CONTEXT_HELPER_LABEL = "paseo-role-orchestrator.context-helper";

const SUMMARY_SYSTEM_PROMPT =
  "You prepare accurate delegation context. Return only a concise, faithful summary of the supplied timeline. Do not use tools, modify files, or attempt implementation.";

export interface LaunchRequest {
  /** Present for delegation; absent for a root role launched from the workspace panel. */
  parent?: { agentId: string; roleId: string };
  /** Required for a root launch; a delegated child always inherits the parent's workspace. */
  workspaceId?: string;
  role: string;
  title?: string;
  prompt: string;
  parentContext?: ParentContext;
}

export interface LaunchResult {
  agentId: string;
  role: Role;
  workspaceId: string;
  cwd: string | null;
  parentContext: ParentContext;
  canDelegate: boolean;
}

/** Attaches delegation tools to a child that may itself delegate. */
export type AttachTools = (child: Role, canDelegate: boolean) => Record<string, unknown> | undefined;

/** Resolve by ID first, then by exact name, then case-insensitively: models retype names, not UUIDs. */
export function resolveRole(candidates: readonly Role[], value: string): Role | undefined {
  const wanted = value.trim();
  return (
    candidates.find((role) => role.id === wanted) ??
    candidates.find((role) => role.name === wanted) ??
    candidates.find((role) => role.name.toLowerCase() === wanted.toLowerCase())
  );
}

export function allowedChildRoles(parent: Role, roles: readonly Role[]): Role[] {
  if (!parent.delegation.enabled) return [];
  return parent.delegation.allowedRoleIds
    .map((id) => roles.find((role) => role.id === id))
    .filter((role): role is Role => Boolean(role));
}

async function completeParentTimeline(paseo: PaseoApi, parentAgentId: string): Promise<string> {
  const timeline = paseo.agents.ref(parentAgentId).timeline;
  let page = await timeline.refetch({ direction: "tail", projection: "canonical" });
  if (page.error) throw new Error(page.error);
  const entries = [...page.entries];
  while (page.hasOlder) {
    if (!page.startCursor) throw new Error("Could not fetch the complete parent timeline");
    page = await timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      projection: "canonical",
    });
    if (page.error) throw new Error(page.error);
    entries.unshift(...page.entries);
  }
  return JSON.stringify(entries);
}

async function summarizeParentTimeline(
  paseo: PaseoApi,
  workspaceId: string,
  parentAgentId: string,
  parent: { provider: string; model: string | null; thinkingOptionId?: string | null; currentModeId?: string | null },
  timeline: string,
): Promise<string> {
  if (!parent.model) {
    throw new Error("The parent agent has no current model to use for a context summary");
  }
  const helper = await paseo.workspaces.ref(workspaceId).agents.create({
    parent: parentAgentId,
    title: "Preparing child context",
    prompt: `Summarize this complete parent-agent timeline for a child agent. Preserve the user's goal, requirements, constraints, relevant repository paths, decisions, findings, work already completed, current state, and explicit acceptance criteria. Do not perform the task or add assumptions.\n\n## Complete parent timeline\n\n${timeline}`,
    labels: { [CONTEXT_HELPER_LABEL]: "true" },
    config: {
      provider: `${parent.provider}/${parent.model}`,
      ...(parent.thinkingOptionId ? { thinkingOptionId: parent.thinkingOptionId } : {}),
      ...(parent.currentModeId ? { modeId: parent.currentModeId } : {}),
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
    },
  });
  try {
    const result = await helper.waitForFinish();
    if (result.status !== "idle" || !result.lastMessage) {
      throw new Error(result.error || `Context summary agent ended with status: ${result.status}`);
    }
    return result.lastMessage;
  } finally {
    await helper.archive().catch(() => undefined);
  }
}

/**
 * The one server-side role launch. The workspace panel, the child-roles panel and the
 * `launch_role` tool all route here, so a role run is identical however it was started:
 * role contract, provider, settings, label, parent link, and the parent's own workspace.
 */
export async function launchRole(
  paseo: PaseoApi,
  request: LaunchRequest,
  attach?: AttachTools,
): Promise<LaunchResult> {
  const { roles } = await getRoles();
  let candidates: readonly Role[] = roles;
  let parentRole: Role | undefined;

  if (request.parent) {
    parentRole = roles.find((role) => role.id === request.parent!.roleId);
    if (!parentRole) throw new Error("This agent's role no longer exists, so it cannot delegate.");
    candidates = allowedChildRoles(parentRole, roles);
    if (candidates.length === 0) {
      throw new Error(`The ${parentRole.name} role is not permitted to delegate to any child role.`);
    }
  }

  const child = resolveRole(candidates, request.role);
  if (!child) {
    const names = candidates.map((role) => `${role.name} (${role.id})`).join(", ");
    throw new Error(
      parentRole
        ? `Unknown or not-permitted role "${request.role}". The ${parentRole.name} role may delegate to: ${names}.`
        : `Unknown role "${request.role}". Configured roles: ${names}.`,
    );
  }
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error("A child role needs an assigned task prompt.");

  let workspaceId = request.workspaceId;
  let cwd: string | null = null;
  let parentSnapshot:
    | { provider: string; model: string | null; thinkingOptionId?: string | null; currentModeId?: string | null }
    | undefined;
  if (request.parent) {
    const snapshot = await paseo.agents.ref(request.parent.agentId).refresh();
    const agent = snapshot?.agent;
    if (!agent?.workspaceId) {
      throw new Error("The parent agent has no workspace, so a child cannot be placed beside it.");
    }
    workspaceId = agent.workspaceId;
    cwd = agent.cwd;
    parentSnapshot = agent;
  }
  if (!workspaceId) throw new Error("A workspace is required to launch a role.");

  const parentContext: ParentContext = request.parent
    ? (request.parentContext ?? parentRole!.delegation.childContexts[child.id] ?? "none")
    : "none";
  let childPrompt = prompt;
  if (request.parent && parentContext !== "none") {
    const timeline = await completeParentTimeline(paseo, request.parent.agentId);
    childPrompt +=
      parentContext === "full"
        ? `\n\n## Parent session context (complete and unedited)\n\n${timeline}`
        : `\n\n## Parent session context summary\n\n${await summarizeParentTimeline(paseo, workspaceId, request.parent.agentId, parentSnapshot!, timeline)}`;
  }

  const systemPrompt = systemPromptForRole(child, roles);
  const canDelegate = allowedChildRoles(child, roles).length > 0;
  const extraConfig = attach?.(child, canDelegate) ?? {};
  const agent = await paseo.workspaces.ref(workspaceId).agents.create({
    ...(request.parent ? { parent: request.parent.agentId } : {}),
    title: request.title?.trim() || child.name,
    prompt: childPrompt,
    labels: { [ROLE_LABEL]: child.id },
    config: {
      provider: providerModel(child),
      ...(child.thinkingOptionId ? { thinkingOptionId: child.thinkingOptionId } : {}),
      ...(child.modeId ? { modeId: child.modeId } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...extraConfig,
    },
  });

  return { agentId: agent.id, role: child, workspaceId, cwd, parentContext, canDelegate };
}
