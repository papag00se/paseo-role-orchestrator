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
  }),
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

export const CompletionGateSettingsSchema = z.object({
  provider: z.string().trim().max(160),
  model: z.string().trim().max(240),
  thinkingOptionId: z.string().trim().max(160).nullable(),
  modeId: z.string().trim().max(160).nullable(),
  prompt: z.string().max(32_000),
});
export type CompletionGateSettings = z.infer<typeof CompletionGateSettingsSchema>;

export const getCompletionGateSettings = defineRpc({
  name: "completion-gate.get",
  input: z.object({}),
  output: CompletionGateSettingsSchema,
});
export const saveCompletionGateSettings = defineRpc({
  name: "completion-gate.save",
  input: CompletionGateSettingsSchema,
  output: CompletionGateSettingsSchema,
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
  }),
  output: z.object({ agentId: z.string(), roleId, roleName: z.string() }),
});

export const deleteRole = defineRpc({
  name: "roles.delete",
  input: z.object({ id: roleId }),
  output: z.object({ deleted: z.boolean() }),
});

export const ROLE_LABEL = "paseo-role-orchestrator.role-id";

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
    ? `## Delegating work\nYou are a parent role and may delegate only to the configured child roles below. Prefer the most specific fitting role; use General Purpose only when no specialist role fits.\n\nDelegate with the \`launch_role\` tool. Give it the role and the complete assigned task; it applies the child's role operating contract, exact provider and settings, the required role label, the parent/child link that reports the result back to you, placement in your own workspace, and any configured inherited context. Generic \`create_agent\` does none of that and produces a roleless child that is invisible to role tracking and completion judging. Use \`list_roles\` when choosing an owner, and \`launch_role\` for every child; do not hand-assemble a child with generic \`create_agent\` while \`launch_role\` is available.\n\n\`launch_role\` already places the child beside you. Do not call \`create_workspace\`, and do not create a git worktree, branch, or separate checkout for a child role. If isolation is genuinely required, ask the user first.\n\nOnly if \`launch_role\` is unavailable in this session, fall back to generic \`create_agent\`: pass your own \`workspaceId\`, the catalog entry's exact provider and settings, its required label, and an \`initialPrompt\` that begins with the complete role operating contract followed by a clear \`## Assigned task\` section. Never create an unlabeled child, substitute another provider, omit the operating contract, or delegate to a role not listed here.\n\n${childCatalog}\n\nUse \`list_agents\` and \`get_agent_status\` to monitor, \`send_agent_prompt\` to keep the same owner through its acceptance cohort, and \`cancel_agent\`, \`archive_agent\`, or \`update_agent\` to manage an existing child.`
    : "";
  return [base, delegation].filter(Boolean).join("\n\n") || undefined;
}
