import { z, type ZodType } from "zod";

type RpcContract<InputSchema extends ZodType, OutputSchema extends ZodType> = {
  name: string;
  input: InputSchema;
  output: OutputSchema;
};

function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(input: {
  name: string;
  input: InputSchema;
  output: OutputSchema;
}): RpcContract<InputSchema, OutputSchema> {
  return input;
}

const roleId = z.string().uuid();

export const RoleSchema = z.object({
  id: roleId,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  provider: z.string().trim().min(1).max(160),
  model: z.string().trim().min(1).max(240),
  thinkingOptionId: z.string().trim().max(160).nullable(),
  modeId: z.string().trim().max(160).nullable(),
  systemPrompt: z.string().max(32_000),
  delegation: z.object({
    enabled: z.boolean(),
    allowedRoleIds: z.array(roleId).max(64),
    childContexts: z.record(roleId, z.enum(["none", "full", "summary"])).default({}),
    completionGateEnabled: z.boolean().default(false),
    /** Subagents this role's agents create must use the worker provider and may only message their parent. */
    restrictChildCommunication: z.boolean().default(false),
  }),
  /** Prompt-cache lifetime for this role's agents. Null: long for roles that may delegate, short otherwise. */
  promptCacheRetention: z.enum(["short", "long"]).nullable().default(null),
  /**
   * Compact the context once it reaches `triggerTokens`. Null, or a value at or above the model's
   * window, leaves the provider's normal compaction alone. `contextWindowTokens` is the model's window
   * as known when the role was saved, so the launch can turn the trigger into a reserve.
   */
  compaction: z.object({
    triggerTokens: z.number().int().min(1000).max(100_000_000).nullable(),
    contextWindowTokens: z.number().int().min(1000).max(100_000_000).nullable(),
  }).default({ triggerTokens: null, contextWindowTokens: null }),
  /** After a context compaction, send the agent its role contract again. Checked when a turn ends. */
  rereadAfterCompaction: z.boolean().default(false),
  /** Send `prompt` to every live agent of this role every `minutes` minutes, queued while the agent is busy. */
  periodicPrompt: z.object({
    enabled: z.boolean(),
    minutes: z.number().int().min(1).max(10_080),
    prompt: z.string().max(8_000),
  }).default({ enabled: false, minutes: 30, prompt: "" }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Role = z.infer<typeof RoleSchema>;

const RoleDraftSchema = RoleSchema.omit({ id: true, createdAt: true, updatedAt: true });
export type RoleDraft = z.infer<typeof RoleDraftSchema>;

export const listRoles = defineRpc({
  name: "roles.list",
  input: z.object({}),
  output: z.object({ roles: z.array(RoleSchema) }),
});

export const createRole = defineRpc({
  name: "roles.create",
  input: RoleDraftSchema,
  output: z.object({ role: RoleSchema }),
});

export const updateRole = defineRpc({
  name: "roles.update",
  input: RoleDraftSchema.extend({ id: roleId }),
  output: z.object({ role: RoleSchema }),
});

/** The judge Juke uses for roles with completion checking on. Empty provider: the judged agent's own model. */
export const CompletionJudgeSchema = z.object({
  provider: z.string().trim().max(160),
  model: z.string().trim().max(240),
  thinkingOptionId: z.string().trim().max(160).nullable(),
});
export type CompletionJudge = z.infer<typeof CompletionJudgeSchema>;

export const getCompletionJudge = defineRpc({
  name: "completion-judge.get",
  input: z.object({}),
  output: CompletionJudgeSchema,
});

export const saveCompletionJudge = defineRpc({
  name: "completion-judge.save",
  input: CompletionJudgeSchema,
  output: CompletionJudgeSchema,
});

export const launchRoleRpc = defineRpc({
  name: "roles.launch",
  input: z.object({
    parent: z.object({ agentId: z.string().min(1), roleId }).optional(),
    workspaceId: z.string().min(1).optional(),
    role: z.string().min(1),
    title: z.string().trim().max(200).optional(),
    prompt: z.string().min(1),
    parentContext: z.enum(["none", "full", "summary"]).optional(),
    model: z.string().trim().min(1).max(240).optional(),
    thinkingOptionId: z.string().trim().min(1).max(160).nullable().optional(),
  }),
  output: z.object({ agentId: z.string(), roleId, roleName: z.string() }),
});

/** The model's context window in tokens when the plugin can tell (Pi's model catalog); null otherwise. */
export const getContextWindow = defineRpc({
  name: "roles.context-window",
  input: z.object({ provider: z.string().trim().min(1).max(160), model: z.string().trim().min(1).max(240) }),
  output: z.object({ tokens: z.number().int().nullable() }),
});

export const deleteRole = defineRpc({
  name: "roles.delete",
  input: z.object({ id: roleId }),
  output: z.object({ deleted: z.boolean() }),
});

export const ROLE_LABEL = "paseo-role-orchestrator.role-id";
/** The model the agent actually launched with (a launch may override the role's), read when its session opens. */
export const MODEL_LABEL = "paseo-role-orchestrator.model";
/** Stamped on an agent at launch when its role restricts child communication; the value never changes afterwards. */
export const CHILD_POLICY_LABEL = "paseo-role-orchestrator.child-policy";
export const CHILD_POLICY_PARENT_ONLY = "parent-only";
/** Daemon provider (extends `pi`, Paseo tools disabled) that restricted parents must use for their subagents. */
export const WORKER_PROVIDER = "pi-worker";
export const CHILD_PROVIDER_REFUSAL = `This parent's subagents must use provider ${WORKER_PROVIDER}; relaunch with that provider.`;

export function providerModel(role: Pick<Role, "provider" | "model">): string {
  return `${role.provider}/${role.model}`;
}

/** The parent receives exact role-equivalent recipes because generic create_agent cannot apply a role by ID. */
export function systemPromptForRole(role: Role, roles: readonly Role[]): string | undefined {
  const base = role.systemPrompt.trim();
  const children = role.delegation.allowedRoleIds
    .map((id) => roles.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Role => Boolean(candidate));
  const childCatalog = children.length
    ? children
        .map((child) => {
          const settings = {
            ...(child.modeId ? { modeId: child.modeId } : {}),
            ...(child.thinkingOptionId ? { thinkingOptionId: child.thinkingOptionId } : {}),
          };
          return `### ${child.name}\n- Role ID: ${child.id}\n- Description: ${child.description || "No delegation description has been provided."}\n- Provider: ${providerModel(child)}\n- Settings: ${JSON.stringify(settings)}\n- Required label: ${JSON.stringify({ [ROLE_LABEL]: child.id })}\n- Role operating contract to prepend verbatim to the initial task prompt:\n\n<role-operating-contract>\n${child.systemPrompt.trim() || "Follow the assigned task and repository instructions."}\n</role-operating-contract>`;
        })
        .join("\n\n")
    : "No child roles are currently configured.";
  const delegation = role.delegation.enabled
    ? `## Delegating work\nYou are a parent role and may delegate only to the configured child roles below. Prefer the most specific fitting role; use General Purpose only when no specialist role fits.\n\nDelegate with the \`launch_role\` tool. Give it the role and the complete assigned task; it applies the child's role operating contract, provider and default settings, the required role label, the parent/child link that reports the result back to you, placement in your own workspace, and any configured inherited context. Optionally override the model and thinkingOptionId for an individual launch; the provider and role configuration remain unchanged. Use list_models to discover valid model IDs and thinking options. Generic \`create_agent\` does none of that and produces a roleless child that is invisible to role tracking and completion judging. Use \`list_roles\` when choosing an owner, and \`launch_role\` for every child; do not hand-assemble a child with generic \`create_agent\` while \`launch_role\` is available.\n\n\`launch_role\` already places the child beside you. Do not call \`create_workspace\`, and do not create a git worktree, branch, or separate checkout for a child role. If isolation is genuinely required, ask the user first.\n\nOnly if \`launch_role\` is unavailable in this session, fall back to generic \`create_agent\`: pass your own \`workspaceId\`, the catalog entry's exact provider and settings, its required label, and an \`initialPrompt\` that begins with the complete role operating contract followed by a clear \`## Assigned task\` section. Never create an unlabeled child, substitute another provider, omit the operating contract, or delegate to a role not listed here.\n\n${childCatalog}\n\nUse \`list_agents\` and \`get_agent_status\` to monitor, \`send_agent_prompt\` to keep the same owner through its acceptance cohort, and \`cancel_agent\`, \`archive_agent\`, or \`update_agent\` to manage an existing child.`
    : "";
  const restriction = role.delegation.restrictChildCommunication
    ? `## Subagent communication restriction\nEvery subagent you create must use the provider \`${WORKER_PROVIDER}\` (for example \`${WORKER_PROVIDER}/<model id>\`, the same model ids as \`pi\`). Creating a subagent with any other provider is refused. Subagents on \`${WORKER_PROVIDER}\` have no Paseo tools and cannot message other agents or the user; their only channel is a \`message_parent\` tool that sends you a message. Their final report still reaches you normally when they finish. When a child role is listed above, it can only be launched if its provider is \`${WORKER_PROVIDER}\`.`
    : "";
  return [base, delegation, restriction].filter(Boolean).join("\n\n") || undefined;
}
