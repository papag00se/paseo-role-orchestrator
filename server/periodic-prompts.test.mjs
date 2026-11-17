// Periodic prompts: first interval starts at discovery, due agents get one prompt, busy agents keep
// exactly one pending prompt until idle, archived/closed/other-role agents are skipped, and the
// schedule survives a reload (state is on disk; a fresh pass continues it).
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
const home = mkdtempSync(join(tmpdir(), 'periodic-'));
mkdirSync(join(home, 'plugin-data'), { recursive: true });
process.env.PASEO_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const on = '11111111-1111-4111-8111-111111111111';
const off = '22222222-2222-4222-8222-222222222222';
const role = (id, periodicPrompt) => ({ id, name: id.slice(0, 2), description: '', provider: 'p', model: 'm', thinkingOptionId: null, modeId: null, systemPrompt: '', rereadAfterCompaction: false, periodicPrompt,
 delegation: { enabled: false, allowedRoleIds: [], childContexts: {}, completionGateEnabled: false, restrictChildCommunication: false }, createdAt: 'now', updatedAt: 'now' });
writeFileSync(join(home, 'plugin-data', 'role-orchestrator.json'), JSON.stringify({ version: 1, roles: [
 role(on, { enabled: true, minutes: 30, prompt: '- check mail\n- check build' }), role(off, { enabled: false, minutes: 30, prompt: 'nope' })] }));
const { runPass } = await import('./periodic-prompts.ts');

const agent = (id, status, roleId = on, extra = {}) => ({ agent: { id, status, labels: { 'paseo-role-orchestrator.role-id': roleId }, ...extra } });
const MIN = 60_000;
function world(entries) {
 const sent = [];
 return { sent, entries, paseo: { agents: { list: async () => ({ entries: world.current }), ref: (id) => ({ send: async (t) => { sent.push([id, t]); } }) } } };
}

test('scheduling, no stacking, busy handling, skipped agents, and persistence across reloads', async () => {
 const w = world();
 world.current = [agent('idle', 'idle'), agent('busy', 'idle'), agent('off', 'idle', off), agent('gone', 'idle', on, { archivedAt: 'x' }), agent('closed', 'closed'), agent('norole', 'idle', 'unknown')];
 const t0 = 1_000_000_000_000;
 await runPass(w.paseo, t0);
 assert.equal(w.sent.length, 0, 'the first interval starts at discovery, nothing is sent yet');
 await runPass(w.paseo, t0 + 29 * MIN);
 assert.equal(w.sent.length, 0);
 world.current[1].agent.status = 'running';
 await runPass(w.paseo, t0 + 30 * MIN);
 assert.deepEqual(w.sent, [['idle', '- check mail\n- check build']], 'only the idle, live, enabled-role agent is prompted; the busy one waits');
 await runPass(w.paseo, t0 + 31 * MIN);
 await runPass(w.paseo, t0 + 45 * MIN);
 await runPass(w.paseo, t0 + 59 * MIN);
 assert.equal(w.sent.length, 1, 'no extra prompt while busy or before the next interval, however many intervals pass');
 // A "reload" is just a fresh pass: the busy agent was due long ago, so it gets exactly one when idle.
 world.current[1].agent.status = 'idle';
 await runPass(w.paseo, t0 + 100 * MIN);
 assert.deepEqual(w.sent.map(([id]) => id), ['idle', 'idle', 'busy'], 'one prompt for the long-busy agent, and the idle agent is due again after 30 minutes');
 await runPass(w.paseo, t0 + 101 * MIN);
 assert.equal(w.sent.length, 3, 'sending restarts the interval');
});
