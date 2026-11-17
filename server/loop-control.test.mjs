// Pause/resume of the periodic loop: a soft (agent) pause stops pings and ends on any real prompt but
// never on the plugin's own ping; a hard (user) pause ends only on the resume command; both persist
// on disk; archived agents lose theirs; the agent tools are served on their own signed endpoint.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

registerHooks({resolve(specifier, context, next) {
 try { return next(specifier, context); }
 catch (error) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier+'.ts',context);
  throw error;
 }
}});
const home = mkdtempSync(join(tmpdir(), 'loop-pause-'));
mkdirSync(join(home, 'plugin-data'), { recursive: true });
process.env.PASEO_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const ROLE = '11111111-1111-4111-8111-111111111111';
const delegation = { enabled: false, allowedRoleIds: [], childContexts: {}, completionGateEnabled: false, restrictChildCommunication: false };
writeFileSync(join(home, 'plugin-data', 'role-orchestrator.json'), JSON.stringify({ version: 1, roles: [{
 id: ROLE, name: 'Looper', description: '', provider: 'p', model: 'm', thinkingOptionId: null, modeId: null, systemPrompt: '', rereadAfterCompaction: false,
 periodicPrompt: { enabled: true, minutes: 30, prompt: 'check in' }, delegation, createdAt: 'now', updatedAt: 'now' }] }));

const { runPass } = await import('./periodic-prompts.ts');
const { installLoopControl, pauseByAgent, resumeByAgent, setByUser } = await import('./loop-control.ts');
const { readPauses } = await import('./loop-pause.ts');
const { installRoleTools } = await import('./role-tools.ts');

const MIN = 60_000, T0 = 1_000_000_000_000;
// The resume path restarts the interval from the clock, so the test moves the clock along with each pass.
mock.timers.enable({ apis: ['Date'], now: T0 });
const pass = (w, offset) => { mock.timers.setTime(T0 + offset); return runPass(w.paseo, T0 + offset); };
const label = { 'paseo-role-orchestrator.role-id': ROLE };
// A fake daemon: agents with a timeline; send() records the message the way the daemon does (messageId kept on the row).
function world(agentIds) {
 const agents = new Map(agentIds.map((id) => [id, { id, status: 'idle', labels: label, timeline: [], rows: [], items: [] }]));
 const paseo = {
  agents: {
   list: async () => ({ entries: [...agents.values()].map((agent) => ({ agent })) }),
   ref: (id) => ({
    refresh: async () => ({ agent: agents.get(id) }),
    send: async (text, options = {}) => { agents.get(id).timeline.push({ item: { type: 'user_message', text, messageId: options.messageId } }); },
    timeline: {
     refetch: async () => ({ entries: agents.get(id).timeline, hasOlder: false }),
     append: async (item) => { agents.get(id).rows.push(item.data.text); agents.get(id).items.push([item.id, item.data.text]); },
    },
   }),
  },
 };
 const userPrompt = (id, text = 'please look at this') => agents.get(id).timeline.push({ item: { type: 'user_message', text, messageId: 'ui-1' } });
 return { agents, paseo, userPrompt };
}
function hooks() {
 const registered = {}; let before;
 const server = { on: (name, fn) => { registered[name] = fn; return () => {}; }, before: (name, fn) => { before = fn; return () => {}; } };
 return { server, startTurn: (paseo, id) => registered['agent.turn_started']({ agent: { id }, turnId: 't' }, { paseo }), archive: (paseo, id) => registered['agent.archived']({ agent: { id } }, { paseo }), sessionOpen: (paseo, request) => before({ request }, { paseo }) };
}
const runtime = await installRoleTools();
after(() => runtime.close());
const loop = hooks();
installLoopControl(loop.server, Promise.resolve(runtime));
const pings = (w, id) => w.agents.get(id).timeline.filter(({ item }) => item.messageId?.startsWith('role-orchestrator-periodic:') && !item.messageId.endsWith(':late')).length;

test('a soft pause stops pings; a real prompt resumes them; the ping itself does not', async () => {
 const w = world(['a']);
 await pass(w, 0);
 await pass(w, 30 * MIN);
 assert.equal(pings(w, 'a'), 1, 'an unpaused agent is pinged when due');
 await pauseByAgent(w.paseo, 'a');
 assert.deepEqual(w.agents.get('a').rows, ['Periodic prompts paused: the agent has nothing to do. Any real prompt resumes them.'], 'a visible marker is left in the timeline');
 await pass(w, 90 * MIN);
 await pass(w, 150 * MIN);
 assert.equal(pings(w, 'a'), 1, 'no pings while paused, however long');

 // A ping that was already queued behind the agent's turn starts after the pause: its own turn must not wake the loop.
 w.agents.get('a').timeline.push({ item: { type: 'user_message', text: 'check in', messageId: 'role-orchestrator-periodic:late' } });
 await loop.startTurn(w.paseo, 'a');
 assert.equal((await readPauses()).a.kind, 'agent', 'the periodic prompt never resumes a pause');

 w.userPrompt('a');
 await loop.startTurn(w.paseo, 'a');
 assert.equal((await readPauses()).a, undefined, 'any real prompt resumes the loop');
 assert.match(w.agents.get('a').rows.at(-1), /resumed: a prompt arrived/);
 await pass(w, 160 * MIN);
 assert.equal(pings(w, 'a'), 1, 'resuming restarts the interval instead of pinging at once');
 await pass(w, 190 * MIN);
 assert.equal(pings(w, 'a'), 2, 'and pings continue after a full interval');
});

test('a user pause is hard: real prompts and the agent cannot lift it, only the resume command can', async () => {
 const w = world(['b']);
 await pass(w, 0);
 await pauseByAgent(w.paseo, 'b');
 assert.equal((await setByUser(w.paseo, 'b', true)).kind, 'user', 'the user upgrades an agent pause to hard');
 w.userPrompt('b');
 await loop.startTurn(w.paseo, 'b');
 assert.equal((await readPauses()).b.kind, 'user', 'a real prompt does not resume a hard pause');
 assert.equal((await pauseByAgent(w.paseo, 'b')).kind, 'user', 'the agent cannot soften it');
 const refused = await resumeByAgent(w.paseo, 'b');
 assert.equal(refused.paused, true);
 assert.match(refused.message, /Only they can resume/);
 await pass(w, 500 * MIN);
 assert.equal(pings(w, 'b'), 0, 'a hard pause sends nothing');
 assert.equal(w.agents.get('b').items.filter(([id]) => id.startsWith('loop-reminder-')).length, 0, 'a hard pause never writes a recurring row: appending bumps updatedAt and would keep the agent fresh for retention');
 const resumed = await setByUser(w.paseo, 'b', false);
 assert.equal(resumed.paused, false);
 assert.equal((await readPauses()).b, undefined);
 await pass(w, 520 * MIN);
 assert.equal(pings(w, 'b'), 0, 'the interval restarts at resume');
 await pass(w, 531 * MIN);
 assert.equal(pings(w, 'b'), 1);
 const bare = world(['c']);
 bare.agents.get('c').labels = {};
 await assert.rejects(setByUser(bare.paseo, 'c', true), /not launched from a role/);
});

test('pauses persist on disk and archived or closed agents lose theirs', async () => {
 const w = world(['d', 'e', 'f']);
 await pauseByAgent(w.paseo, 'd'); await setByUser(w.paseo, 'e', true); await pauseByAgent(w.paseo, 'f');
 const onDisk = JSON.parse(readFileSync(join(home, 'plugin-data', 'role-orchestrator-loop-pause.json'), 'utf8'));
 assert.deepEqual([onDisk.d.kind, onDisk.e.kind, onDisk.f.kind], ['agent', 'user', 'agent'], 'state is in plugin-data, so a reload keeps it');
 await loop.archive(w.paseo, 'd');
 w.agents.get('e').archivedAt = 'x';
 w.agents.get('f').status = 'closed';
 await pass(w, 0);
 const left = await readPauses();
 assert.equal(left.d, undefined); assert.equal(left.e, undefined); assert.equal(left.f, undefined);
});

test('role-launched agents get the loop tools on their own signed endpoint', async () => {
 const w = world(['g']);
 const request = { agentId: 'g', purpose: 'interactive', labels: label, mcpServers: { other: { type: 'http', url: 'x' } } };
 const opened = await loop.sessionOpen(w.paseo, request);
 assert.deepEqual(Object.keys(opened.mcpServers).sort(), ['loop', 'other']);
 assert.equal(await loop.sessionOpen(w.paseo, { ...request, labels: {} }), undefined, 'agents without a role get nothing');
 assert.equal(await loop.sessionOpen(w.paseo, { ...request, purpose: 'history' }), undefined);

 const call = (server, body) => fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...server.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) }).then((r) => r.json());
 const server = opened.mcpServers.loop;
 const listed = await call(server, { method: 'tools/list' });
 assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['pause_loop', 'resume_loop']);
 const ok = await call(server, { method: 'tools/call', params: { name: 'pause_loop', arguments: {} } });
 assert.equal(ok.result.structuredContent.paused, true);
 assert.equal((await readPauses()).g.kind, 'agent');
 const back = await call(server, { method: 'tools/call', params: { name: 'resume_loop', arguments: {} } });
 assert.equal(back.result.structuredContent.paused, false);

 const worker = runtime.workerMcpServer('g');
 const crossed = await call({ url: server.url, headers: worker.headers }, { method: 'tools/call', params: { name: 'pause_loop', arguments: {} } });
 assert.equal(crossed.error.code, -32001, 'a worker credential does not work on the loop endpoint');
});
