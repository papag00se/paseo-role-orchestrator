import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RoleSchema, type Role, type RoleDraft } from "../shared/roles";

interface StoredRoles {
  version: 1;
  roles: Role[];
}

const file = join(
  process.env.PASEO_HOME || join(homedir(), ".paseo"),
  "plugin-data",
  "role-orchestrator.json",
);

function clean(input: unknown): StoredRoles {
  if (!input || typeof input !== "object" || !("roles" in input) || !Array.isArray(input.roles)) {
    return { version: 1, roles: [] };
  }
  return {
    version: 1,
    roles: input.roles.flatMap((candidate) => {
      const parsed = RoleSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

async function load(): Promise<StoredRoles> {
  try {
    return clean(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, roles: [] };
    throw error;
  }
}

async function save(data: StoredRoles): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

let mutationChain = Promise.resolve();
function mutate<T>(operation: (data: StoredRoles) => T | Promise<T>): Promise<T> {
  const result = mutationChain.then(async () => {
    const data = await load();
    const value = await operation(data);
    await save(data);
    return value;
  });
  mutationChain = result.then(() => undefined, () => undefined);
  return result;
}

export async function getRoles() {
  return { roles: (await load()).roles };
}

export async function addRole(draft: RoleDraft) {
  return mutate((data) => {
    const now = new Date().toISOString();
    const role = RoleSchema.parse({
      ...draft,
      id: randomUUID(),
      thinkingOptionId: draft.thinkingOptionId?.trim() || null,
      modeId: draft.modeId?.trim() || null,
      delegation: {
        enabled: draft.delegation.enabled,
        allowedRoleIds: [...new Set(draft.delegation.allowedRoleIds)],
        childContexts: Object.fromEntries(
          Object.entries(draft.delegation.childContexts).filter(([id]) =>
            draft.delegation.allowedRoleIds.includes(id),
          ),
        ),
        completionGateEnabled: draft.delegation.completionGateEnabled,
      },
      createdAt: now,
      updatedAt: now,
    });
    data.roles.push(role);
    return { role };
  });
}

export async function editRole(input: RoleDraft & { id: string }) {
  return mutate((data) => {
    const index = data.roles.findIndex((role) => role.id === input.id);
    if (index < 0) throw new Error("Role not found");
    const prior = data.roles[index]!;
    const role = RoleSchema.parse({
      ...input,
      thinkingOptionId: input.thinkingOptionId?.trim() || null,
      modeId: input.modeId?.trim() || null,
      delegation: {
        enabled: input.delegation.enabled,
        allowedRoleIds: [...new Set(input.delegation.allowedRoleIds)].filter(
          (id) => id !== input.id,
        ),
        childContexts: Object.fromEntries(
          Object.entries(input.delegation.childContexts).filter(([id]) =>
            input.delegation.allowedRoleIds.includes(id) && id !== input.id,
          ),
        ),
        completionGateEnabled: input.delegation.completionGateEnabled,
      },
      createdAt: prior.createdAt,
      updatedAt: new Date().toISOString(),
    });
    data.roles[index] = role;
    return { role };
  });
}

export async function removeRole(input: { id: string }) {
  return mutate((data) => {
    const before = data.roles.length;
    data.roles = data.roles
      .filter((role) => role.id !== input.id)
      .map((role) => ({
        ...role,
        delegation: {
          ...role.delegation,
          allowedRoleIds: role.delegation.allowedRoleIds.filter((id) => id !== input.id),
        },
      }));
    return { deleted: data.roles.length !== before };
  });
}
