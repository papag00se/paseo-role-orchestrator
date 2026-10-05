import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({resolve(specifier, context, next) {
 try { return next(specifier, context); }
 catch (error) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier+'.ts',context);
  throw error;
 }
}});

const { buildRoleRunTree, COMPLETION_AGENT_KINDS, COMPLETION_AGENT_LABEL, fetchRoleAgents, MAX_RUN_PAGES } = await import('../shared/role-runs.ts');
const { ROLE_LABEL } = await import('../shared/roles.ts');

const supervisor = '33333333-3333-4333-8333-333333333333';
const coder = '11111111-1111-4111-8111-111111111111';
const roles = [{ id: supervisor }, { id: coder }];

const agent = (id, over = {}) => ({
 id, workspaceId: 'wks_1', parentAgentId: null, status: 'idle', title: null,
 labels: { [ROLE_LABEL]: coder }, createdAt: '2026-09-15T00:00:00Z', archivedAt: null, ...over,
});

test('each role is filtered by the daemon and every page is followed', async () => {
 const calls = [];
 const pages = {
  [supervisor]: [{ entries: [agent('s1', { labels: { [ROLE_LABEL]: supervisor } })], pageInfo: { nextCursor: 'c1' } },
                 { entries: [agent('s2', { labels: { [ROLE_LABEL]: supervisor } })], pageInfo: { nextCursor: null } }],
  [coder]: [{ entries: [agent('c1')] }],
 };
 const source = { list: async (options) => {
  const roleId = options.filter.labels[ROLE_LABEL];
  calls.push({ roleId, labels: options.filter.labels, cursor: options.page.cursor, includeArchived: options.filter.includeArchived });
  return pages[roleId]?.shift() ?? { entries: [] };
 } };
 const found = await fetchRoleAgents(source, roles, false);
 assert.deepEqual(found.map((entry) => entry.id).sort(), ['c1', 's1', 's2']);
 // One exact-label query per role; the second supervisor page is followed by cursor.
 assert.equal(calls.filter((call) => call.roleId === supervisor).length, 2);
 assert.equal(calls.find((call) => call.cursor)?.cursor, 'c1');
 assert.ok(calls.every((call) => call.includeArchived === false));
 assert.deepEqual(
  calls
   .filter((call) => call.roleId === undefined)
   .map((call) => call.labels[COMPLETION_AGENT_LABEL])
   .sort(),
  [...COMPLETION_AGENT_KINDS].sort(),
 );
});

test('paging is bounded so a broken cursor cannot spin forever', async () => {
 let requests = 0;
 const source = { list: async (options) => {
  if (options.filter.labels[ROLE_LABEL] !== coder) return { entries: [] };
  requests += 1;
  return { entries: [agent(`a${requests}`)], pageInfo: { nextCursor: 'always' } };
 } };
 await fetchRoleAgents(source, [{ id: coder }], false);
 assert.equal(requests, MAX_RUN_PAGES);
});

test('includeArchived is passed through to the daemon', async () => {
 let seen;
 const source = { list: async (options) => { seen = options.filter.includeArchived; return { entries: [] }; } };
 await fetchRoleAgents(source, [{ id: coder }], true);
 assert.equal(seen, true);
});

test('completion calls are fetched and nest under the role they evaluated', async () => {
 const completion = agent('gate', {
  parentAgentId: 'root',
  labels: { [COMPLETION_AGENT_LABEL]: 'judge' },
  title: 'Completion gate',
 });
 const source = { list: async (options) =>
  options.filter.labels[COMPLETION_AGENT_LABEL] === 'judge' ? { entries: [completion] } : { entries: [] } };
 const found = await fetchRoleAgents(source, [], true);
 assert.deepEqual(found, [completion]);
 const { rows } = buildRoleRunTree([agent('root'), ...found], 'wks_1');
 assert.deepEqual(rows.map((row) => [row.agent.id, row.depth]), [['root', 0], ['gate', 1]]);
});

test('the tree nests children under their parent and orders siblings oldest first', () => {
 const { rows } = buildRoleRunTree([
  agent('child-b', { parentAgentId: 'root', createdAt: '2026-09-15T02:00:00Z' }),
  agent('root', { labels: { [ROLE_LABEL]: supervisor }, createdAt: '2026-09-15T00:00:00Z' }),
  agent('grandchild', { parentAgentId: 'child-a', createdAt: '2026-09-15T03:00:00Z' }),
  agent('child-a', { parentAgentId: 'root', createdAt: '2026-09-15T01:00:00Z' }),
 ], 'wks_1');
 assert.deepEqual(rows.map((row) => [row.agent.id, row.depth]), [
  ['root', 0], ['child-a', 1], ['grandchild', 2], ['child-b', 1],
 ]);
});

test('agents in other workspaces are excluded but counted', () => {
 const { rows, elsewhere } = buildRoleRunTree([
  agent('here'),
  agent('there', { workspaceId: 'wks_2' }),
  agent('also-there', { workspaceId: 'wks_3' }),
 ], 'wks_1');
 assert.deepEqual(rows.map((row) => row.agent.id), ['here']);
 assert.equal(elsewhere, 2);
});

test('a child whose parent sits in another workspace still renders as a local root', () => {
 // This is the exact shape that emptied the panel: a Supervisor in one workspace whose
 // children were launched into worktree workspaces of their own.
 const { rows } = buildRoleRunTree([
  agent('orphan', { parentAgentId: 'supervisor-elsewhere' }),
 ], 'wks_1');
 assert.deepEqual(rows.map((row) => [row.agent.id, row.depth]), [['orphan', 0]]);
});

test('archived runs are returned with their marker intact', () => {
 const { rows } = buildRoleRunTree([
  agent('done', { status: 'closed', archivedAt: '2026-09-15T22:38:00Z' }),
 ], 'wks_1');
 assert.equal(rows[0].agent.archivedAt, '2026-09-15T22:38:00Z');
});

test('a parent cycle neither hangs nor drops agents', () => {
 const { rows } = buildRoleRunTree([
  agent('a', { parentAgentId: 'b' }),
  agent('b', { parentAgentId: 'a' }),
 ], 'wks_1');
 assert.deepEqual(rows.map((row) => row.agent.id).sort(), ['a', 'b']);
});
