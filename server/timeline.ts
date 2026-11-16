import type { PaseoApi } from "@getpaseo/client";

/**
 * The agent's whole conversation, oldest first. Paseo 0.14 and later deliver an empty
 * `timeline` on lifecycle events, so history must be fetched. An incomplete history must
 * never be mistaken for a complete one.
 */
export async function fullTimeline(paseo: PaseoApi, agentId: string) {
  const timeline = paseo.agents.ref(agentId).timeline;
  let page = await timeline.refetch({ direction: "tail", projection: "canonical", limit: 200 });
  const entries = [...page.entries];
  const seen = new Set<string>();
  while (page.hasOlder) {
    if (page.error) throw new Error(page.error);
    const cursor = page.startCursor;
    const key = cursor && JSON.stringify(cursor);
    if (!cursor || !key || seen.has(key)) throw new Error("Incomplete agent timeline");
    seen.add(key);
    page = await timeline.refetch({ direction: "before", cursor, projection: "canonical", limit: 200 });
    entries.unshift(...page.entries);
  }
  if (page.error) throw new Error(page.error);
  return entries.map((entry) => entry.item);
}
