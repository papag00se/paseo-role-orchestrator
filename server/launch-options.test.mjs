// Role launch options: prompt-cache lifetime per provider, compaction trigger to Pi reserve, and the
// per-agent Pi settings directory that leaves the user's own settings and credentials alone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, existsSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

registerHooks({resolve(specifier, context, next) {
 try { return next(specifier, context); }
 catch (error) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier+'.ts',context);
  throw error;
 }
}});
process.umask(0o022); // a typical host: new files would be world-readable
const home = mkdtempSync(join(tmpdir(), 'launch-options-'));
const pi = join(home, 'pi');
mkdirSync(join(home, 'plugin-data'), { recursive: true });
mkdirSync(pi);
process.env.PASEO_HOME = home;
process.env.PI_CODING_AGENT_DIR = pi;
after(() => rmSync(home, { recursive: true, force: true }));
writeFileSync(join(pi, 'settings.json'), JSON.stringify({ theme: 'x', compaction: { keepRecentTokens: 5, modelOverrides: { 'a/other': { reserveTokens: 9 } } } }));
writeFileSync(join(pi, 'auth.json'), '{"secret":true}');
writeFileSync(join(pi, 'models-store.json'), JSON.stringify({ anthropic: { models: [{ id: 'claude-big', contextWindow: 1000000 }] } }));

const ID = '11111111-1111-4111-8111-111111111111';
const role = (over = {}) => ({ id: ID, name: 'R', description: '', provider: 'pi', model: 'anthropic/claude-big', thinkingOptionId: null, modeId: null, systemPrompt: '',
 promptCacheRetention: null, compaction: { triggerTokens: null, contextWindowTokens: null },
 delegation: { enabled: false, allowedRoleIds: [], childContexts: {}, completionGateEnabled: false, restrictChildCommunication: false }, createdAt: 'now', updatedAt: 'now', ...over });
const store = (r) => writeFileSync(join(home, 'plugin-data', 'role-orchestrator.json'), JSON.stringify({ version: 1, roles: [r] }));
const { cacheEnv, compactionReserve, effectiveCacheRetention, piContextWindow, applyRoleLaunchOptions, securePiAgentDirs } = await import('./launch-options.ts');
const open = (provider, labels) => ({ provider, labels, env: { KEEP: '1' } });

test('cache retention defaults long for delegating roles and short otherwise; explicit choice wins', () => {
 assert.equal(effectiveCacheRetention(role()), 'short');
 assert.equal(effectiveCacheRetention(role({ delegation: { ...role().delegation, enabled: true } })), 'long');
 assert.equal(effectiveCacheRetention(role({ promptCacheRetention: 'short', delegation: { ...role().delegation, enabled: true } })), 'short');
});

test('only Pi providers get PI_CACHE_RETENTION, and only for long', () => {
 assert.deepEqual(cacheEnv('pi', 'long'), { PI_CACHE_RETENTION: 'long' });
 assert.deepEqual(cacheEnv('pi-worker', 'long'), { PI_CACHE_RETENTION: 'long' });
 assert.deepEqual(cacheEnv('pi', 'short'), {});
 assert.deepEqual(cacheEnv('codex', 'long'), {});
});

test('reserve is window minus trigger; at or above the window, or unknown, means normal compaction', () => {
 assert.equal(compactionReserve(1_000_000, 300_000), 700_000);
 assert.equal(compactionReserve(1_000_000, 1_000_000), null);
 assert.equal(compactionReserve(1_000_000, 2_000_000), null);
 assert.equal(compactionReserve(null, 300_000), null);
 assert.equal(compactionReserve(1_000_000, null), null);
});

test('the context window comes from Pi\'s catalog by provider/model', async () => {
 assert.equal(await piContextWindow('anthropic/claude-big'), 1_000_000);
 assert.equal(await piContextWindow('openai/claude-big'), null);
});

test('a role agent gets the cache env; the trigger gives it its own Pi directory with the model reserve', async () => {
 store(role({ promptCacheRetention: 'long', compaction: { triggerTokens: 300_000, contextWindowTokens: 1_000_000 } }));
 const out = await applyRoleLaunchOptions(open('pi', { 'paseo-role-orchestrator.role-id': ID }));
 assert.equal(out.env.KEEP, '1');
 assert.equal(out.env.PI_CACHE_RETENTION, 'long');
 const dir = out.env.PI_CODING_AGENT_DIR;
 assert.notEqual(dir, pi);
 const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
 assert.equal(settings.theme, 'x');
 assert.equal(settings.compaction.keepRecentTokens, 5);
 assert.equal(settings.compaction.modelOverrides['anthropic/claude-big'].reserveTokens, 700_000);
 assert.equal(settings.compaction.modelOverrides['a/other'].reserveTokens, 9);
 assert.equal(readlinkSync(join(dir, 'auth.json')), join(pi, 'auth.json'));
 assert.equal(JSON.parse(readFileSync(join(pi, 'settings.json'), 'utf8')).compaction.modelOverrides['anthropic/claude-big'], undefined);
 // The copy holds the user's private Pi settings, so it is private even when the umask is 022.
 assert.equal(statSync(join(dir, 'settings.json')).mode & 0o777, 0o600);
 assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('a copy an older version made with loose permissions is tightened', async () => {
 const old = join(home, 'plugin-data', 'role-orchestrator-pi-agent', 'old');
 mkdirSync(old, { recursive: true });
 writeFileSync(join(old, 'settings.json'), '{}');
 chmodSync(old, 0o755); chmodSync(join(old, 'settings.json'), 0o644);
 await securePiAgentDirs();
 assert.equal(statSync(join(old, 'settings.json')).mode & 0o777, 0o600);
 assert.equal(statSync(old).mode & 0o777, 0o700);
});

test('the launched model (a per-launch override) is the one that gets the reserve', async () => {
 store(role({ compaction: { triggerTokens: 200_000, contextWindowTokens: 1_000_000 } }));
 const out = await applyRoleLaunchOptions(open('pi', { 'paseo-role-orchestrator.role-id': ID, 'paseo-role-orchestrator.model': 'anthropic/other-model' }));
 const settings = JSON.parse(readFileSync(join(out.env.PI_CODING_AGENT_DIR, 'settings.json'), 'utf8'));
 assert.equal(settings.compaction.modelOverrides['anthropic/other-model'].reserveTokens, 800_000);
});

test('no trigger, a trigger at the window, other providers and unlabeled agents change nothing', async () => {
 store(role({ compaction: { triggerTokens: 1_000_000, contextWindowTokens: 1_000_000 } }));
 const labels = { 'paseo-role-orchestrator.role-id': ID };
 assert.deepEqual((await applyRoleLaunchOptions(open('pi', labels))).env, { KEEP: '1' });
 store(role({ promptCacheRetention: 'long', compaction: { triggerTokens: 1_000, contextWindowTokens: 1_000_000 } }));
 assert.deepEqual((await applyRoleLaunchOptions(open('codex', labels))).env, { KEEP: '1' });
 const plain = open('pi', {});
 assert.equal(await applyRoleLaunchOptions(plain), plain);
});
