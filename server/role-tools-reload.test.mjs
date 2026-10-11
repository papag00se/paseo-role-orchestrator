// After a plugin reload nothing has launched yet, so the agent-facing tools have no daemon
// connection until a hook hands one over. launch_role must work once any hook connects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

registerHooks({resolve(specifier, context, next) {
 try { return next(specifier, context); }
 catch (error) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier+'.ts',context);
  throw error;
 }
}});
const home = mkdtempSync(join(tmpdir(), 'role-tools-reload-'));
mkdirSync(join(home, 'plugin-data'), { recursive: true });
process.env.PASEO_HOME = home;
const sup = '33333333-3333-4333-8333-333333333333', rev = '11111111-1111-4111-8111-111111111111';
const role = (id, name, delegation = {}) => ({ id, name, description: name, provider: 'pi', model: name.toLowerCase(), thinkingOptionId: null, modeId: null, systemPrompt: name,
 delegation: { enabled: false, allowedRoleIds: [], childContexts: {}, completionGateEnabled: false, ...delegation }, createdAt: 'now', updatedAt: 'now' });
writeFileSync(join(home, 'plugin-data', 'role-orchestrator.json'), JSON.stringify({ version: 1, roles: [role(sup, 'Supervisor', { enabled: true, allowedRoleIds: [rev], childContexts: { [rev]: 'none' } }), role(rev, 'Reviewer')] }));
writeFileSync(join(home, 'plugin-data', 'role-orchestrator-tools.json'), JSON.stringify({ version: 1, port: null, grants: { tok: { parentAgentId: 'sup-agent', parentRoleId: sup, createdAt: 'now' } } }));
const { installRoleTools } = await import('./role-tools.ts');
const created = [];
const paseo = {
 agents: { ref: (id) => ({ refresh: async () => ({ agent: { id, workspaceId: 'w', cwd: '/r', provider: 'pi', model: 'm' } }) }) },
 workspaces: { ref: () => ({ agents: { create: async (o) => { created.push(o); return { id: 'child' }; } } }) },
};
const runtime = await installRoleTools();
test.after(() => runtime.close());
const launch = () => fetch(`http://127.0.0.1:${runtime.port()}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
 body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'launch_role', arguments: { role: 'Reviewer', prompt: 'Review it.' } } }) }).then((r) => r.json());

test('launch_role fails honestly before any connection, then works after connect()', async () => {
 assert.match(JSON.stringify(await launch()), /not connected to Paseo/);
 runtime.connect(paseo);
 const result = await launch();
 assert.ok(!result.error && !result.result?.isError, JSON.stringify(result));
 assert.equal(created.length, 1);
});
