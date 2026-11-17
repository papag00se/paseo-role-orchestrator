import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ROLE_LABEL, systemPromptForRole } from "../shared/roles";
import { getRoles } from "./roles";

const file = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "role-orchestrator-compaction.json");
const PAGE_LIMIT = 200;

export const REREAD_HEADER =
  "Your context was just compacted. Before anything else, re-read your role contract below and the files it tells you to read at start, then continue.";

/** Highest compaction timeline sequence number already answered, per agent. */
type Handled = Record<string, number>;

async function loadHandled(): Promise<Handled> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function saveHandled(handled: Handled): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(handled, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * Sequence number of the newest completed compaction row newer than `after`, or null.
 * Rows are fetched from the tail and paged back only while they are newer than `after`.
 */
export async function newestCompaction(paseo: PaseoApi, agentId: string, after: number): Promise<number | null> {
  const timeline = paseo.agents.ref(agentId).timeline;
  let page = await timeline.refetch({ direction: "tail", projection: "canonical", limit: PAGE_LIMIT });
  for (let pages = 0; ; pages++) {
    if (page.error) throw new Error(page.error);
    for (let index = page.entries.length - 1; index >= 0; index--) {
      const entry = page.entries[index];
      if (entry.seqStart <= after) return null;
      const item = entry.item as { type: string; status?: string };
      if (item.type === "compaction" && item.status === "completed") return entry.seqStart;
    }
    if (!page.hasOlder || !page.startCursor) return null;
    page = await timeline.refetch({ direction: "before", cursor: page.startCursor, projection: "canonical", limit: PAGE_LIMIT });
  }
}

/**
 * Roles with `rereadAfterCompaction` get their role contract re-sent after a context compaction.
 * Paseo has no compaction event, so this runs when a turn ends and looks for a new compaction row.
 */
export function installCompactionReread(server: PluginServerContext) {
  let stopped = false;
  const running = new Set<string>();
  let handled: Promise<Handled> | undefined;
  let writes: Promise<void> = Promise.resolve();

  const removeTurnEnded = server.on("agent.turn_ended", async (event, { paseo }) => {
    const agentId = event.agent.id;
    // One check per agent at a time: the follow-up we send ends its own turn and re-enters here.
    if (stopped || running.has(agentId)) return;
    running.add(agentId);
    try {
      const snapshot = await paseo.agents.ref(agentId).refresh();
      const roleId = snapshot?.agent.labels?.[ROLE_LABEL];
      if (!roleId) return;
      const { roles } = await getRoles();
      const role = roles.find((candidate) => candidate.id === roleId);
      if (!role?.rereadAfterCompaction) return;
      const state = await (handled ??= loadHandled());
      const seq = await newestCompaction(paseo, agentId, state[agentId] ?? 0);
      if (seq === null) return;
      const contract = systemPromptForRole(role, roles);
      // Record before sending: a failed send must not become a retry loop on every later turn.
      state[agentId] = seq;
      writes = writes.then(() => saveHandled(state));
      await writes;
      if (!contract) return;
      await paseo.agents.ref(agentId).send(`${REREAD_HEADER}\n\n${contract}`);
    } catch (error) {
      console.error("Compaction re-read failed", { agentId, error });
    } finally {
      running.delete(agentId);
    }
  });
  return () => {
    stopped = true;
    removeTurnEnded();
  };
}
