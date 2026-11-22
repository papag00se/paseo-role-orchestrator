import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MODEL_LABEL, ROLE_LABEL, type Role } from "../shared/roles";
import { getRoles } from "./roles";

/** Providers whose launch command is Pi, which reads PI_CACHE_RETENTION and its settings directory. */
const PI_PROVIDERS = new Set(["pi", "pi-worker"]);

export type CacheRetention = "short" | "long";

/** Coordinators run long, so their cache is worth keeping; everything else defaults to the short lifetime. */
export function effectiveCacheRetention(role: Pick<Role, "promptCacheRetention" | "delegation">): CacheRetention {
  return role.promptCacheRetention ?? (role.delegation.enabled ? "long" : "short");
}

/**
 * Environment that gives a launch the role's prompt-cache lifetime. Pi maps `long` to one hour on
 * Anthropic and 24 hours on OpenAI. Other providers expose no such switch: codex has no setting for
 * it, so the option does nothing there.
 */
export function cacheEnv(provider: string, retention: CacheRetention): Record<string, string> {
  return PI_PROVIDERS.has(provider) && retention === "long" ? { PI_CACHE_RETENTION: "long" } : {};
}

/** Tokens Pi keeps free before it compacts: the window minus the trigger. Null when normal compaction applies. */
export function compactionReserve(windowTokens: number | null, triggerTokens: number | null): number | null {
  if (!windowTokens || !triggerTokens || triggerTokens >= windowTokens) return null;
  return windowTokens - triggerTokens;
}

const piHome = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

/** Pi's own catalog of context windows. Model ids look like `provider/model`; a bare id searches every provider. */
export async function piContextWindow(model: string): Promise<number | null> {
  const slash = model.indexOf("/");
  const providerName = slash > 0 ? model.slice(0, slash) : null;
  const id = slash > 0 ? model.slice(slash + 1) : model;
  const windows: number[] = [];
  const collect = (provider: string | null, models: unknown) => {
    if (!Array.isArray(models) || (providerName && provider !== providerName)) return;
    for (const entry of models) {
      if (entry && entry.id === id && Number.isInteger(entry.contextWindow)) windows.push(entry.contextWindow);
    }
  };
  try {
    const store = JSON.parse(await readFile(join(piHome(), "models-store.json"), "utf8")) as Record<string, { models?: unknown }>;
    for (const [provider, value] of Object.entries(store)) collect(provider, value?.models);
  } catch { /* no catalog */ }
  try {
    const custom = JSON.parse(await readFile(join(piHome(), "models.json"), "utf8")) as { providers?: Record<string, { models?: unknown }> };
    for (const [provider, value] of Object.entries(custom.providers ?? {})) collect(provider, value?.models);
  } catch { /* no custom models */ }
  return windows[0] ?? null;
}

/**
 * Pi has no per-session switch for compaction, only settings files, so a launch with a trigger gets
 * its own agent directory: every entry of the user's Pi directory linked in (credentials, sessions,
 * packages stay shared) except `settings.json`, which is the user's file plus a per-model reserve.
 * The directory is keyed by its content, so agents with the same setting share one.
 */
export async function piAgentDirWithReserve(model: string, reserveTokens: number): Promise<string> {
  const base = piHome();
  const key = createHash("sha256").update(`${base}\n${model}\n${reserveTokens}`).digest("hex").slice(0, 16);
  const dir = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "role-orchestrator-pi-agent", key);
  await mkdir(dir, { recursive: true });
  let settings: Record<string, any> = {};
  try { settings = JSON.parse(await readFile(join(base, "settings.json"), "utf8")); } catch { /* no user settings */ }
  const compaction = { ...(settings.compaction ?? {}) };
  compaction.modelOverrides = { ...(compaction.modelOverrides ?? {}), [model]: { ...(compaction.modelOverrides?.[model] ?? {}), reserveTokens } };
  await writeFile(join(dir, "settings.json"), `${JSON.stringify({ ...settings, compaction }, null, 2)}\n`);
  const existing = new Set(await readdir(dir));
  for (const name of await readdir(base)) {
    if (name === "settings.json" || existing.has(name) || /\.(tmp|bak.*)$/.test(name)) continue;
    await symlink(join(base, name), join(dir, name)).catch(() => undefined);
  }
  return dir;
}

/** Environment a role adds to its agent's launch: cache lifetime and, on Pi, the compaction trigger. */
export async function roleLaunchEnv(role: Role, provider: string, launchedModel: string): Promise<Record<string, string>> {
  const env = cacheEnv(provider, effectiveCacheRetention(role));
  if (!PI_PROVIDERS.has(provider)) return env;
  const window = role.compaction.contextWindowTokens ?? (await piContextWindow(launchedModel));
  const reserve = compactionReserve(window, role.compaction.triggerTokens);
  if (reserve !== null) env.PI_CODING_AGENT_DIR = await piAgentDirWithReserve(launchedModel, reserve);
  return env;
}

/** Applies the role's options to a session open. Agents without a role label are untouched. */
export async function applyRoleLaunchOptions<R extends { provider: string; labels: Readonly<Record<string, string>>; env: Record<string, string> }>(request: R): Promise<R> {
  const roleId = request.labels[ROLE_LABEL];
  if (!roleId) return request;
  const role = (await getRoles()).roles.find((candidate) => candidate.id === roleId);
  if (!role) return request;
  const env = await roleLaunchEnv(role, request.provider, request.labels[MODEL_LABEL] ?? role.model);
  return Object.keys(env).length ? { ...request, env: { ...request.env, ...env } } : request;
}
