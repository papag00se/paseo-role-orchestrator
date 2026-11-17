import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { ROLE_LABEL } from "../shared/roles";
import { getRoles } from "./roles";

const file = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "role-orchestrator-periodic.json");
export const TICK_MS = 15_000;

/** Per agent: when the interval last started (discovery or last send), epoch ms. Due = since + minutes. */
type Since = Record<string, number>;

async function load(): Promise<Since> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function save(since: Since): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(since, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * One scheduling pass. A live agent whose role has a periodic prompt is due `minutes` after its
 * interval started. A due agent that is idle gets the prompt and its interval restarts; a busy one
 * stays due (that is the single pending prompt) and is sent when it goes idle. Only the interval
 * start is persisted, so reloads lose nothing and no pass can send twice for one interval.
 */
export async function runPass(paseo: PaseoApi, now = Date.now()): Promise<void> {
  const [{ roles }, { entries }, since] = await Promise.all([getRoles(), paseo.agents.list(), load()]);
  const next: Since = {};
  let changed = false;
  for (const { agent } of entries) {
    const role = roles.find((candidate) => candidate.id === agent.labels?.[ROLE_LABEL]);
    const schedule = role?.periodicPrompt;
    const live = !agent.archivedAt && agent.status !== "closed";
    if (!schedule?.enabled || !schedule.prompt.trim() || !live) continue;
    let start = since[agent.id];
    if (start === undefined) { start = now; changed = true; }
    if (now >= start + schedule.minutes * 60_000 && agent.status === "idle") {
      try {
        await paseo.agents.ref(agent.id).send(schedule.prompt);
        start = now;
        changed = true;
      } catch (error) {
        console.error("Periodic prompt failed", { agentId: agent.id, error });
      }
    }
    next[agent.id] = start;
  }
  if (changed || Object.keys(since).length !== Object.keys(next).length) await save(next);
}

/** Runs a pass on a timer once any lifecycle event or RPC has handed over a daemon connection. */
export function installPeriodicPrompts() {
  let paseo: PaseoApi | undefined;
  let running = false;
  const timer = setInterval(async () => {
    if (!paseo || running) return;
    running = true;
    try { await runPass(paseo); } catch (error) { console.error("Periodic prompt pass failed", { error }); } finally { running = false; }
  }, TICK_MS);
  timer.unref?.();
  return { connect: (api: PaseoApi) => { paseo = api; }, close: () => clearInterval(timer) };
}
