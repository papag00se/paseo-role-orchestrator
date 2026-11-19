import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ROLE_LABEL, type CompletionJudge, type Role } from "../shared/roles";

/**
 * Completion checking is Juke's job. A role with completion checking on is mapped to Juke's
 * "strict" profile through Juke's public profile file, keyed by this plugin's role label. Juke
 * then judges those agents on the whole user ask, including agents launched before the role was
 * switched on. The judge model is this plugin's completion judge setting, passed along in the same
 * entry. Without Juke installed the setting has no effect.
 */
const file = () => join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "juke-profiles.json");

export async function syncJukeProfiles(roles: readonly Role[], judge: CompletionJudge): Promise<void> {
  let current: { labels?: Record<string, Record<string, string>> } = {};
  try {
    current = JSON.parse(await readFile(file(), "utf8"));
  } catch {
    // Missing or unreadable: rewrite it with this plugin's entries only.
  }
  // This plugin's judge setting is passed to Juke; an empty one leaves Juke on the agent's own model.
  const entry = judge.provider && judge.model ? { profile: "strict", judge } : "strict";
  const strict = Object.fromEntries(roles.filter((role) => role.delegation.completionGateEnabled).map((role) => [role.id, entry]));
  // Other plugins' label keys are kept as they are.
  const next = { ...current, labels: { ...(current.labels ?? {}), [ROLE_LABEL]: strict } };
  await mkdir(dirname(file()), { recursive: true });
  const temporary = `${file()}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, file());
}
