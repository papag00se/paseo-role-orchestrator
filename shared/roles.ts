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
  context: z.enum(["full", "summary"]),
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

export const deleteRole = defineRpc({
  name: "roles.delete",
  input: z.object({ id: roleId }),
  output: z.object({ deleted: z.boolean() }),
});

export const ROLE_LABEL = "paseo-role-orchestrator.role-id";

export function providerModel(role: Pick<Role, "provider" | "model">): string {
  return `${role.provider}/${role.model}`;
}

/** The parent alone receives this appendix; a child's description is not persona text. */
export function systemPromptForRole(role: Role, roles: readonly Role[]): string | undefined {
  const base = role.systemPrompt.trim();
  const children = role.delegation.allowedRoleIds
    .map((id) => roles.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Role => Boolean(candidate));
  const childCatalog = children.length
    ? children
        .map(
          (child) =>
            `- ${child.name}\n  - Description: ${child.description || "No delegation description has been provided."}\n  - Provider/model: ${providerModel(child)}\n  - Reasoning level: ${child.thinkingOptionId ?? "Provider default"}`,
        )
        .join("\n")
    : "- No child roles are currently configured.";
  const delegation = role.delegation.enabled
    ? `## Delegating work\nYou are a parent role and may delegate only to the configured child roles below. Choose a child based on its delegation description; that description is selection guidance, not part of the child's persona.\n\n${childCatalog}\n\nPaseo child-management tools available to you: \`create_agent\` to delegate, \`list_agents\` and \`get_agent_status\` to monitor, \`send_agent_prompt\` to follow up, and \`cancel_agent\`, \`archive_agent\`, or \`update_agent\` to manage an existing child. Create agents in your current workspace so Paseo records them as your children. Do not delegate to roles not listed above.`
    : "";
  return [base, delegation].filter(Boolean).join("\n\n") || undefined;
}
