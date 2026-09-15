import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

registerHooks({resolve(specifier, context, next) {
 try { return next(specifier, context); }
 catch (error) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier+'.ts',context);
  throw error;
 }
}});

const home = mkdtempSync(join(tmpdir(), 'role-tools-'));
mkdirSync(join(home, 'plugin-data'), { recursive: true });
process.env.PASEO_HOME = home;

const supervisor = '33333333-3333-4333-8333-333333333333';
const coder = '11111111-1111-4111-8111-111111111111';
const secret = '99999999-9999-4999-8999-999999999999';
const role = (id, name, systemPrompt, delegation) => ({
 id, name, description: `${name} role`, provider: 'pi', model: name.toLowerCase(),
 thinkingOptionId: 'medium', modeId: null, systemPrompt,
 delegation: { enabled: false, allowedRoleIds: [], childContexts: {}, completionGateEnabled: false, ...delegation },
 createdAt: 'now', updatedAt: 'now',
});
writeFileSync(join(home, 'plugin-data', 'role-orchestrator.json'), JSON.stringify({ version: 1, roles: [
 role(supervisor, 'Supervisor', 'Supervise delivery.', { enabled: true, allowedRoleIds: [coder], childContexts: { [coder]: 'none' } }),
 role(coder, 'Coder', 'Own the implementation through acceptance.'),
 role(secret, 'Secret', 'Not delegatable.'),
]}));

const { installRoleTools } = await import('./role-tools.ts');

const created = [];
const fakePaseo = {
 agents: { ref: (id) => ({ refresh: async () => ({ agent: { id, workspaceId: 'wks_1', cwd: '/repo', provider: 'pi', model: 'supervisor' } }) }) },
 workspaces: { ref: (workspaceId) => ({ agents: { create: async (options) => { created.push({ workspaceId, ...options }); return { id: `agent_${created.length}` }; } } }) },
};

const runtime = await installRoleTools();
test.after(() => runtime.close());

const rpc = (body, headers = {}) => fetch(`http://127.0.0.1:${runtime.port()}/mcp`, {
 method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
}).then((response) => response.json());

const grantToken = () => {
 const state = JSON.parse(readFileSync(join(home, 'plugin-data', 'role-orchestrator-tools.json'), 'utf8'));
 return Object.entries(state.grants).find(([, grant]) => grant.parentAgentId)?.[0];
};

test('initialize advertises tools and instructs the parent to delegate through launch_role', async () => {
 const result = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
 assert.equal(result.result.protocolVersion, '2025-06-18');
 assert.equal(result.result.capabilities.tools.listChanged, false);
 assert.match(result.result.instructions, /launch_role/);
});

test('tools/list explains what generic create_agent cannot do', async () => {
 const { result } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
 const names = result.tools.map((tool) => tool.name).sort();
 assert.deepEqual(names, ['launch_role', 'list_roles']);
 const launch = result.tools.find((tool) => tool.name === 'launch_role');
 assert.match(launch.description, /role operating contract/);
 assert.match(launch.description, /never a new workspace, worktree or branch/);
 assert.match(launch.description, /send_agent_prompt/);
 assert.deepEqual(launch.inputSchema.required, ['role', 'prompt']);
 // The task prompt must not be confused with the contract the tool applies itself.
 assert.match(launch.inputSchema.properties.prompt.description, /Do NOT paste the role's operating contract/);
});

test('an unauthenticated tool call is rejected', async () => {
 const response = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_roles', arguments: {} } });
 assert.equal(response.error.code, -32001);
});

test('a root launch applies the role config and mints a delegation credential', async () => {
 const result = await runtime.launch(fakePaseo, { workspaceId: 'wks_1', role: 'Supervisor', prompt: 'Ship it.' });
 assert.equal(result.role.id, supervisor);
 const agent = created.at(-1);
 assert.equal(agent.workspaceId, 'wks_1');
 assert.equal(agent.config.provider, 'pi/supervisor');
 assert.equal(agent.labels['paseo-role-orchestrator.role-id'], supervisor);
 assert.match(agent.config.systemPrompt, /## Delegating work/);
 // A delegating parent is handed the tool, preapproved so permission friction cannot push it back to create_agent.
 assert.equal(agent.config.mcpServers.roles.type, 'http');
 assert.match(agent.config.mcpServers.roles.headers.authorization, /^Bearer /);
 assert.equal(agent.config.mcpServers.roles.alwaysLoad, true);
 assert.deepEqual(agent.config.toolPolicy.preapproved.map((ref) => ref.tool).sort(), ['launch_role', 'list_roles']);
});

test('list_roles returns only the permitted children', async () => {
 const { result } = await rpc(
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_roles', arguments: {} } },
  { authorization: `Bearer ${grantToken()}` },
 );
 assert.equal(result.isError, false);
 assert.deepEqual(result.structuredContent.roles.map((entry) => entry.name), ['Coder']);
 assert.equal(result.structuredContent.roles[0].id, coder);
 assert.equal(result.structuredContent.roles[0].inheritsParentContext, 'none');
});

test('launch_role places the child in the parent workspace with the role contract and label', async () => {
 const { result } = await rpc(
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'launch_role', arguments: { role: 'coder', prompt: 'Fix the parser.', title: 'Parser repair' } } },
  { authorization: `Bearer ${grantToken()}` },
 );
 assert.equal(result.isError, false);
 const child = created.at(-1);
 assert.equal(child.workspaceId, 'wks_1');
 assert.equal(child.parent, 'agent_1');
 assert.equal(child.title, 'Parser repair');
 assert.equal(child.config.provider, 'pi/coder');
 assert.equal(child.config.systemPrompt, 'Own the implementation through acceptance.');
 assert.equal(child.labels['paseo-role-orchestrator.role-id'], coder);
 // A non-delegating child gets no delegation credential.
 assert.equal(child.config.mcpServers, undefined);
 assert.equal(result.structuredContent.workspaceId, 'wks_1');
});

test('a role outside the parent checklist is refused with the roles it may use', async () => {
 const { result } = await rpc(
  { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'launch_role', arguments: { role: 'Secret', prompt: 'Do it.' } } },
  { authorization: `Bearer ${grantToken()}` },
 );
 assert.equal(result.isError, true);
 assert.match(result.content[0].text, /not-permitted role "Secret"/);
 assert.match(result.content[0].text, /may delegate to: Coder/);
});

test('a task prompt is required and the failure explains the fix', async () => {
 const { result } = await rpc(
  { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'launch_role', arguments: { role: 'Coder', prompt: '  ' } } },
  { authorization: `Bearer ${grantToken()}` },
 );
 assert.equal(result.isError, true);
 assert.match(result.content[0].text, /describe the complete assigned task/);
});
