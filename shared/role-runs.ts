import { ROLE_LABEL, type Role } from "./roles";

export interface RoleRunAgent {
  id: string;
  workspaceId: string;
  parentAgentId: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  title: string | null;
  labels: Record<string, string>;
  createdAt?: string;
  archivedAt?: string | null;
}

export interface RoleRunRow {
  agent: RoleRunAgent;
  depth: number;
}

export interface RoleRunTree {
  rows: RoleRunRow[];
  /** Role runs that exist, but under a different workspace than the panel is showing. */
  elsewhere: number;
}

/** A page of agents as returned by the daemon; only the fields the panel reads. */
interface AgentPage {
  entries: readonly RoleRunAgent[];
  pageInfo?: { nextCursor?: string | null };
}

export interface RoleRunSource {
  list(options: {
    filter: { labels: Record<string, string>; includeArchived: boolean };
    page: { limit: number; cursor?: string };
  }): Promise<AgentPage>;
}

export const MAX_RUN_PAGES = 20;

/**
 * Role runs carry an exact label value, so the daemon can filter them. The panel used to
 * request one daemon-wide page of 200 agents and filter in the client, which silently lost
 * runs once the daemon held more agents than that.
 */
export async function fetchRoleAgents(
  source: RoleRunSource,
  roles: readonly Role[],
  includeArchived: boolean,
): Promise<RoleRunAgent[]> {
  const byId = new Map<string, RoleRunAgent>();
  await Promise.all(
    roles.map(async (role) => {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_RUN_PAGES; page += 1) {
        const result = await source.list({
          filter: { labels: { [ROLE_LABEL]: role.id }, includeArchived },
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        for (const entry of result.entries) byId.set(entry.id, entry);
        cursor = result.pageInfo?.nextCursor ?? undefined;
        if (!cursor) break;
      }
    }),
  );
  return [...byId.values()];
}

/**
 * A role run is a tree. An agent whose parent lives in another workspace is a local root,
 * so a delegated child is never hidden just because its parent is displayed elsewhere.
 */
export function buildRoleRunTree(
  agents: readonly RoleRunAgent[],
  workspaceId: string,
): RoleRunTree {
  const here = agents.filter((agent) => agent.workspaceId === workspaceId);
  const present = new Set(here.map((agent) => agent.id));
  const childrenByParent = new Map<string, RoleRunAgent[]>();
  const roots: RoleRunAgent[] = [];
  for (const agent of here) {
    const parentId =
      agent.parentAgentId && present.has(agent.parentAgentId) ? agent.parentAgentId : null;
    if (!parentId) roots.push(agent);
    else childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), agent]);
  }

  const oldestFirst = (a: RoleRunAgent, b: RoleRunAgent) =>
    (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  roots.sort(oldestFirst);
  for (const siblings of childrenByParent.values()) siblings.sort(oldestFirst);

  const rows: RoleRunRow[] = [];
  const seen = new Set<string>();
  const walk = (agent: RoleRunAgent, depth: number) => {
    // Stored labels are user-editable data; a cycle must not hang the panel.
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    rows.push({ agent, depth });
    for (const child of childrenByParent.get(agent.id) ?? []) walk(child, depth + 1);
  };
  for (const agent of roots) walk(agent, 0);
  // A cycle among non-roots would otherwise drop those agents from the panel entirely.
  for (const agent of here) if (!seen.has(agent.id)) walk(agent, 0);

  return { rows, elsewhere: agents.length - here.length };
}
