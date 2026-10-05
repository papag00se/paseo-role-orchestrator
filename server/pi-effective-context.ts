import { readFile } from "node:fs/promises";

type PiSessionEntry = {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  message?: unknown;
  summary?: unknown;
  firstKeptEntryId?: unknown;
  retainedTail?: unknown;
  content?: unknown;
  customType?: unknown;
  fromId?: unknown;
  tokensBefore?: unknown;
};

type PiContextMessage = Record<string, unknown>;

function parseSession(raw: string): PiSessionEntry[] {
  const entries: PiSessionEntry[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`Pi session contains invalid JSON on line ${index + 1}`);
    }
    if (entry && typeof entry === "object") entries.push(entry as PiSessionEntry);
  }
  return entries;
}

function activeBranch(entries: readonly PiSessionEntry[]): PiSessionEntry[] {
  const indexed = new Map<string, PiSessionEntry>();
  let leaf: PiSessionEntry | undefined;
  for (const entry of entries) {
    if (typeof entry.id !== "string") continue;
    indexed.set(entry.id, entry);
    leaf = entry;
  }
  if (!leaf) throw new Error("Pi session has no entries");
  const branch: PiSessionEntry[] = [];
  const visited = new Set<string>();
  for (let entry: PiSessionEntry | undefined = leaf; entry; ) {
    if (typeof entry.id !== "string" || visited.has(entry.id)) throw new Error("Pi session has an invalid entry chain");
    visited.add(entry.id);
    branch.push(entry);
    entry = typeof entry.parentId === "string" ? indexed.get(entry.parentId) : undefined;
  }
  return branch.reverse();
}

function asMessage(entry: PiSessionEntry): PiContextMessage | null {
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    return entry.message as PiContextMessage;
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return { role: "branchSummary", summary: entry.summary, fromId: entry.fromId };
  }
  if (entry.type === "custom_message") {
    return { role: "custom", customType: entry.customType, content: entry.content };
  }
  return null;
}

function compactedContext(branch: readonly PiSessionEntry[]): PiContextMessage[] {
  let compactionIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index].type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex < 0) return branch.map(asMessage).filter((message): message is PiContextMessage => Boolean(message));

  const compaction = branch[compactionIndex];
  if (typeof compaction.summary !== "string") throw new Error("Pi compaction has no summary");
  const summary: PiContextMessage = {
    role: "compactionSummary",
    summary: compaction.summary,
    tokensBefore: compaction.tokensBefore,
  };
  const afterCompaction = branch.slice(compactionIndex + 1);
  if (Array.isArray(compaction.retainedTail)) {
    return [summary, ...compaction.retainedTail.filter((message): message is PiContextMessage => Boolean(message && typeof message === "object")), ...afterCompaction.map(asMessage).filter((message): message is PiContextMessage => Boolean(message))];
  }
  if (typeof compaction.firstKeptEntryId !== "string") throw new Error("Pi compaction has no retained-context boundary");
  const firstKeptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  if (firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) throw new Error("Pi compaction retained-context boundary is not on the active branch");
  const retained = [...branch.slice(firstKeptIndex, compactionIndex), ...afterCompaction];
  return [summary, ...retained.map(asMessage).filter((message): message is PiContextMessage => Boolean(message))];
}

/** Rebuild the same compacted message context Pi sends from its current session branch. */
export async function piEffectiveContext(nativeHandle: string): Promise<string> {
  const branch = activeBranch(parseSession(await readFile(nativeHandle, "utf8")));
  return JSON.stringify({ source: "Pi effective session context", messages: compactedContext(branch) });
}
