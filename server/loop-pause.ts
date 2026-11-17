import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LoopPauseKind } from "../shared/loop-pause";
import { createExclusive } from "./exclusive";

const file = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "role-orchestrator-loop-pause.json");

export interface PauseEntry {
  kind: LoopPauseKind;
  /** ISO time the pause began; identifies this pause (a later pause of the same agent has a new one). */
  at: string;
}
/** Agent ID -> its pause. An agent that is absent is not paused. */
export type PauseStore = Record<string, PauseEntry>;

/** Who is ending a pause. Only the user's command (`user`) can end a hard pause. */
export type ResumeSource = "agent" | "prompt" | "user";

async function load(): Promise<PauseStore> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function save(store: PauseStore): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

// Every read-modify-write runs one at a time, so a pause, a prompt-triggered resume and a cleanup can never lose each other's write.
const exclusive = createExclusive();

export const readPauses = (): Promise<PauseStore> => exclusive(load);

/**
 * Pause an agent's loop. A hard (`user`) pause is never weakened: an agent's own pause leaves it
 * as it was, while the user's pause upgrades an agent's. Returns the pause now in force and whether this call changed it.
 */
export function pause(agentId: string, kind: LoopPauseKind): Promise<{ entry: PauseEntry; changed: boolean }> {
  return exclusive(async () => {
    const store = await load();
    const current = store[agentId];
    if (current && (current.kind === kind || current.kind === "user")) return { entry: current, changed: false };
    const entry = { kind, at: new Date().toISOString() };
    await save({ ...store, [agentId]: entry });
    return { entry, changed: true };
  });
}

/**
 * End a pause. Soft pauses end for any source; a hard pause only for `user`.
 * With `onlyIfAt`, only that exact pause ends, so a pause begun after the caller looked is left alone.
 * Returns the pause that is still in force when it could not end, or null when nothing is left.
 */
export function resume(agentId: string, source: ResumeSource, onlyIfAt?: string): Promise<{ resumed: boolean; remaining: PauseEntry | null }> {
  return exclusive(async () => {
    const store = await load();
    const current = store[agentId];
    if (!current) return { resumed: false, remaining: null };
    if (onlyIfAt !== undefined && current.at !== onlyIfAt) return { resumed: false, remaining: current };
    if (current.kind === "user" && source !== "user") return { resumed: false, remaining: current };
    const { [agentId]: _ended, ...rest } = store;
    await save(rest);
    return { resumed: true, remaining: null };
  });
}

/** Drop the pauses of agents that are archived, closed or gone. */
export function forget(agentIds: Iterable<string>): Promise<void> {
  const gone = new Set(agentIds);
  return exclusive(async () => {
    const store = await load();
    const rest = Object.fromEntries(Object.entries(store).filter(([id]) => !gone.has(id)));
    if (Object.keys(rest).length !== Object.keys(store).length) await save(rest);
  });
}
