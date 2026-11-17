// Re-read after compaction: detection of a new completed compaction row on turn end, one follow-up
// per compaction (also across turns and plugin reloads), no loop from the follow-up's own turn.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

registerHooks({resolve(specifier, context, next) {
 try { return next(specifier, context); }
 catch (error) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier+'.ts',context);
  throw error;
 }
}});
const home = mkdtempSync(join(tmpdir(), 'compaction-reread-'));
mkdirSync(join(home, 'plugin-data'), { recursive: true });
process.env.PASEO_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const on = '11111111-1111-4111-8111-111111111111';
const off = '22222222-2222-4222-8222-222222222222';
const role = (id, reread) => ({ id, name: reread ? 'On' : 'Off', description: '', provider: 'p', model: 'm', thinkingOptionId: null, modeId: null, systemPrompt: 'Read AGENTS.md first.',
 rereadAfterCompaction: reread, delegation: { enabled: false, allowedRoleIds: [], childContexts: {}, completionGateEnabled: false, restrictChildCommunication: false }, createdAt: 'now', updatedAt: 'now' });
writeFileSync(join(home, 'plugin-data', 'role-orchestrator.json'), JSON.stringify({ version: 1, roles: [role(on, true), role(off, false)] }));
const { installCompactionReread, REREAD_HEADER } = await import('./compaction-reread.ts');

const row = (seq, item) => ({ seqStart: seq, seqEnd: seq, item });
const compaction = (seq, status = 'completed') => row(seq, { type: 'compaction', status });
const text = (seq) => row(seq, { type: 'assistant_message', text: 'x' });

function load(roleId, rows) {
 const hooks = new Map(), sent = [];
 const server = { on: (name, fn) => { hooks.set(name, fn); return () => hooks.delete(name); } };
 const unload = installCompactionReread(server);
 // Serves rows newest-first pages of 2 so older rows need paging back.
 const refetch = async (o) => {
  const end = o.direction === 'tail' ? rows.length : o.cursor;
  const start = Math.max(0, end - 2);
  return { entries: rows.slice(start, end), hasOlder: start > 0, startCursor: start };
 };
 const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: roleId ? { 'paseo-role-orchestrator.role-id': roleId } : {} } }), timeline: { refetch }, send: async (t) => { sent.push(t); } }) } };
 return { sent, unload, end: () => hooks.get('agent.turn_ended')({ agent: { id: 'a1' } }, { paseo }) };
}

test('a new completed compaction sends the role contract once; later turns and reloads do not repeat it', async () => {
 const rows = [text(1), compaction(2), text(3), text(4), text(5)];
 const first = load(on, rows);
 await first.end();
 assert.equal(first.sent.length, 1);
 assert.ok(first.sent[0].startsWith(REREAD_HEADER));
 assert.match(first.sent[0], /Read AGENTS\.md first\./);
 await first.end(); // the follow-up's own turn ending
 assert.equal(first.sent.length, 1);
 first.unload();
 const reloaded = load(on, rows);
 await reloaded.end();
 assert.equal(reloaded.sent.length, 0);
 rows.push(compaction(6, 'loading'));
 await reloaded.end();
 assert.equal(reloaded.sent.length, 0, 'an unfinished compaction is not acted on');
 rows[5] = compaction(6);
 await reloaded.end();
 assert.equal(reloaded.sent.length, 1, 'a second compaction triggers a second re-read');
 reloaded.unload();
});

test('roles without the setting, agents without a role, and histories without compaction are left alone', async () => {
 for (const [roleId, rows] of [[off, [compaction(1)]], [undefined, [compaction(1)]], [on, [text(1), text(2)]]]) {
  const h = load(roleId, rows);
  await h.end();
  assert.equal(h.sent.length, 0);
  h.unload();
 }
});
