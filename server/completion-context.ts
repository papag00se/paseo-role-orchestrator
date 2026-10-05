import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export const MAX_COMPLETION_CONTEXT_CHARS = 18_000;
const MAX_ORIGINAL_REQUEST_CHARS = 4_000;
const MAX_TIMELINE_ENTRY_CHARS = 2_000;

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[${text.length - maxChars} characters omitted]`;
}

function toolDetail(detail: unknown): string {
  try {
    return truncate(JSON.stringify(detail), MAX_TIMELINE_ENTRY_CHARS);
  } catch {
    return "[Tool detail could not be serialized]";
  }
}

function describeTimelineItem(item: AgentTimelineItem): string | null {
  switch (item.type) {
    case "user_message":
      return `User:\n${truncate(item.text, MAX_TIMELINE_ENTRY_CHARS)}`;
    case "assistant_message":
      return `Assistant:\n${truncate(item.text, MAX_TIMELINE_ENTRY_CHARS)}`;
    case "tool_call":
      return `Tool (${item.name}, ${item.status}):\n${toolDetail(item.detail)}`;
    case "todo":
      return `Tasks:\n${item.items.map((task) => `- [${task.completed ? "x" : " "}] ${task.text}`).join("\n")}`;
    case "error":
      return `Error:\n${truncate(item.message, MAX_TIMELINE_ENTRY_CHARS)}`;
    case "notification":
      return `Notification (${item.level}):\n${truncate(item.message, MAX_TIMELINE_ENTRY_CHARS)}`;
    // Reasoning, compactions, and plugin rows either duplicate the visible work or can be arbitrarily large.
    case "reasoning":
    case "compaction":
    case "plugin":
      return null;
  }
}

/** A judge needs the request and current evidence, not an unbounded raw provider transcript. */
export function completionContext(timeline: readonly AgentTimelineItem[]): string {
  const originalRequest = timeline.find((item): item is Extract<AgentTimelineItem, { type: "user_message" }> => item.type === "user_message");
  const header = originalRequest
    ? `## Original user request\n${truncate(originalRequest.text, MAX_ORIGINAL_REQUEST_CHARS)}`
    : "## Original user request\n[No user message was available]";
  const recent: string[] = [];
  let length = header.length;
  let omitted = 0;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = describeTimelineItem(timeline[index]);
    if (!entry || timeline[index] === originalRequest) continue;
    const separatorLength = recent.length ? 2 : 0;
    if (length + separatorLength + entry.length > MAX_COMPLETION_CONTEXT_CHARS) {
      omitted += 1;
      continue;
    }
    recent.push(entry);
    length += separatorLength + entry.length;
  }
  const omission = omitted ? `\n\n[${omitted} earlier timeline entries omitted to fit the completion-gate context]` : "";
  return `${header}${omission}${recent.length ? `\n\n## Recent session activity\n${recent.reverse().join("\n\n")}` : ""}`;
}
