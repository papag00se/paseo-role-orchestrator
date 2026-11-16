// Restricted parents: refusal of other providers at session open, the worker's single tool and
// its credential, one-time passes for the plugin's own helpers, and the launch-time label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

registerHooks({resolve(specifier, context, next) {
 try { return next(specifier, context); }
 catch (error) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier+'.ts',context);
  throw error;
 }
}});
const home = mkdtempSync(join(tmpdir(), 'child-policy-'));
mkdirSync(join(home, 'plugin-data'), { recursive: true });
process.env.PASEO_HOME = home;

const strict = '33333333-3333-4333-8333-333333333333';
const worker = '11111111-1111-4111-8111-111111111111';
const plain = '22222222-2222-4222-8222-222222222222';
const role = (id, name, provider, delegation = {}) => ({ id, name, description: name, provider, model: 'm', thinkingOptionId: null, modeId: null, systemPrompt: `${name} prompt`,
 delegation: { enabled: false, allowedRoleIds: [], childContexts: {}, completionGateEnabled: false, restrictChildCommunication: false, ...delegation }, createdAt: 'now', updatedAt: 'now' });
writeFileSync(join(home, 'plugin-data', 'role-orchestrator.json'), JSON.stringify({ version: 1, roles: [
 role(strict, 'Strict', 'pi', { enabled: true, allowedRoleIds: [worker, plain], restrictChildCommunication: true }),
 role(worker, 'Worker', 'pi-worker'),
 role(plain, 'Plain', 'pi'),
]}));

const { installRoleTools } = await import('./role-tools.ts');
const { installChildPolicy, sanctionedLaunchLabels } = await import('./child-policy.ts');
const { PARENT_AGENT_LABEL } = await import('../shared/role-runs.ts');

const agents = {
 strictParent: { id: 'strict-parent', title: 'Strict', labels: { 'paseo-role-orchestrator.child-policy': 'parent-only' } },
 openParent: { id: 'open-parent', title: 'Open', labels: {} },
 child: { id: 'child-1', title: 'Worker child', labels: { [PARENT_AGENT_LABEL]: 'strict-parent' } },
};
const sent = [];
const paseo = { agents: { ref: (id) => ({ refresh: async () => ({ agent: agents[Object.keys(agents).find((k) => agents[k].id === id)] }), send: async (text) => sent.push({ id, text }) }) } };

let hook;
const runtimePromise = installRoleTools();
installChildPolicy({ before: (name, fn) => { assert.equal(name, 'agent.session_open'); hook = fn; return () => {}; } }, runtimePromise);
const runtime = await runtimePromise;
test.after(async () => { await runtime.close(); rmSync(home, { recursive: true, force: true }); });

const open = (overrides) => hook({ request: { agentId: 'new-agent', workspaceId: 'w', provider: 'pi', cwd: '/r', reason: 'create', purpose: 'interactive', title: 't', labels: {}, tools: [], env: {}, mcpServers: {}, ...overrides } }, { paseo });
const REFUSAL = /must use provider pi-worker; relaunch with that provider/;

test('a restricted parent cannot create a subagent on another provider, and nothing is attached', async () => {
 await assert.rejects(open({ labels: { [PARENT_AGENT_LABEL]: 'strict-parent' } }), REFUSAL);
});

test('only creation is refused: a non-worker child of a restricted parent reopens untouched', async () => {
 for (const reason of ['resume', 'refresh', 'import']) assert.equal(await open({ reason, labels: { [PARENT_AGENT_LABEL]: 'strict-parent' } }), undefined);
});

test('agents without a parent, with an unrestricted parent, or opened for history are untouched', async () => {
 assert.equal(await open({}), undefined);
 assert.equal(await open({ labels: { [PARENT_AGENT_LABEL]: 'open-parent' } }), undefined);
 assert.equal(await open({ purpose: 'history', labels: { [PARENT_AGENT_LABEL]: 'strict-parent' } }), undefined);
});

test('a worker gets message_parent as its only MCP server, a refusing paseo shim first on PATH, and keeps both on resume', async () => {
 for (const reason of ['create', 'resume']) {
  const result = await open({ reason, provider: 'pi-worker', agentId: 'child-1', labels: { [PARENT_AGENT_LABEL]: 'strict-parent' } });
  assert.deepEqual(Object.keys(result.mcpServers), ['parent']);
  assert.match(result.mcpServers.parent.url, /\/worker-mcp$/);
  assert.equal(result.env.PATH.split(':')[0], join(home, 'plugin-data', 'role-orchestrator-worker-bin'));
  assert.ok(statSync(join(result.env.PATH.split(':')[0], 'paseo')).mode & 0o100);
 }
});

test('a pass lets the plugin create its own helper under a restricted parent once; reusing the label is refused', async () => {
 const labels = { [PARENT_AGENT_LABEL]: 'strict-parent', ...sanctionedLaunchLabels() };
 assert.equal(await open({ labels }), undefined);
 await assert.rejects(open({ labels }), REFUSAL);
 await assert.rejects(open({ labels: { [PARENT_AGENT_LABEL]: 'strict-parent', 'paseo-role-orchestrator.sanctioned-launch': 'guess' } }), REFUSAL);
});

const call = (path, auth, body) => fetch(`http://127.0.0.1:${runtime.port()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) }).then((r) => r.json());
const credential = async () => (await open({ provider: 'pi-worker', agentId: 'child-1', labels: { [PARENT_AGENT_LABEL]: 'strict-parent' } })).mcpServers.parent.headers.authorization.slice(7);

test('the worker endpoint lists only message_parent and delivers it to the parent from the agent the credential names', async () => {
 const token = await credential();
 const list = await call('/worker-mcp', token, { method: 'tools/list' });
 assert.deepEqual(list.result.tools.map((tool) => tool.name), ['message_parent']);
 const result = await call('/worker-mcp', token, { method: 'tools/call', params: { name: 'message_parent', arguments: { message: 'Need the schema decision.' } } });
 assert.equal(result.result.isError, false);
 assert.equal(sent.length, 1);
 assert.equal(sent[0].id, 'strict-parent');
 assert.match(sent[0].text, /Worker child.*child-1[\s\S]*Need the schema decision\./);
 const other = await call('/worker-mcp', token, { method: 'tools/call', params: { name: 'launch_role', arguments: { role: 'Plain', prompt: 'x' } } });
 assert.equal(other.result.isError, true);
});

test('worker credentials are not interchangeable: forged, other-agent, missing, and role-tool credentials are rejected', async () => {
 const token = await credential();
 const [agentId, signature] = [token.slice(0, token.lastIndexOf('.')), token.slice(token.lastIndexOf('.') + 1)];
 const message = { method: 'tools/call', params: { name: 'message_parent', arguments: { message: 'x' } } };
 for (const bad of [`${agentId}.AAAA`, `other-agent.${signature}`, agentId, '']) assert.equal((await call('/worker-mcp', bad, message)).error?.code, -32001, bad);
 assert.equal((await call('/mcp', token, message)).error?.code, -32001);
 assert.equal(sent.length, 1);
});

test('a launch stamps the policy label from the role and refuses a non-worker child before creating anything', async () => {
 const created = [];
 const launcher = { agents: paseo.agents, workspaces: { ref: () => ({ agents: { create: async (o) => { created.push(o); return { id: `a${created.length}` }; } } }) } };
 const root = await runtime.launch(launcher, { workspaceId: 'w', role: 'Strict', prompt: 'go' });
 assert.equal(created[0].labels['paseo-role-orchestrator.child-policy'], 'parent-only');
 assert.match(created[0].config.systemPrompt, /Subagent communication restriction[\s\S]*pi-worker/);
 await runtime.launch(launcher, { workspaceId: 'w', role: 'Worker', prompt: 'go' });
 assert.equal(created[1].labels['paseo-role-orchestrator.child-policy'], undefined);
 const refusing = { ...launcher, agents: { ref: () => ({ refresh: async () => ({ agent: { ...agents.strictParent, workspaceId: 'w', cwd: '/r', provider: 'pi', model: 'm' } }) }) } };
 await assert.rejects(runtime.launch(refusing, { parent: { agentId: 'strict-parent', roleId: strict }, role: 'Plain', prompt: 'go' }), REFUSAL);
 assert.equal(created.length, 2);
 await runtime.launch(refusing, { parent: { agentId: 'strict-parent', roleId: strict }, role: 'Worker', prompt: 'go' });
 assert.equal(created.length, 3);
});
