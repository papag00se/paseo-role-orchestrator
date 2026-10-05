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

const { ROLE_LABEL, systemPromptForRole } = await import('../shared/roles.ts');
const coderId = '11111111-1111-4111-8111-111111111111';
const reviewerId = '22222222-2222-4222-8222-222222222222';
const parent = {
 id: '33333333-3333-4333-8333-333333333333', name: 'Supervisor', description: '', provider: 'pi', model: 'supervisor',
 thinkingOptionId: 'high', modeId: null, systemPrompt: 'Supervise delivery.',
 delegation: { enabled: true, allowedRoleIds: [coderId], childContexts: {}, completionGateEnabled: true },
 createdAt: 'now', updatedAt: 'now'
};
const coder = {
 id: coderId, name: 'Coder', description: 'Implement a bounded outcome.', provider: 'pi', model: 'coder',
 thinkingOptionId: 'medium', modeId: 'auto', systemPrompt: 'Own the implementation through acceptance.',
 delegation: { enabled: false, allowedRoleIds: [], childContexts: {}, completionGateEnabled: false },
 createdAt: 'now', updatedAt: 'now'
};
const reviewer = {
 ...coder, id: reviewerId, name: 'Reviewer', model: 'reviewer', systemPrompt: 'Review independently.'
};

test('parent prompt directs delegation to launch_role over generic create_agent', () => {
 const prompt = systemPromptForRole(parent, [parent, coder, reviewer]);
 assert.ok(prompt);
 assert.match(prompt, /Delegate with the `launch_role` tool/);
 assert.match(prompt, /do not hand-assemble a child with generic `create_agent` while `launch_role` is available/);
 // The fallback must stay, and stay clearly subordinate, for sessions without the tool.
 const tool = prompt.indexOf('Delegate with the `launch_role` tool');
 const fallback = prompt.indexOf('Only if `launch_role` is unavailable');
 assert.ok(tool >= 0 && fallback > tool);
});

test('parent prompt gives an exact role-equivalent create_agent fallback recipe', () => {
 const prompt = systemPromptForRole(parent, [parent, coder, reviewer]);
 assert.ok(prompt);
 assert.match(prompt, /Only if `launch_role` is unavailable in this session, fall back to generic `create_agent`/);
 assert.match(prompt, /Prefer the most specific fitting role; use General Purpose only when no specialist role fits/);
 assert.match(prompt, new RegExp(`Role ID: ${coderId}`));
 assert.match(prompt, /Provider: pi\/coder/);
 assert.match(prompt, /Settings: \{"modeId":"auto","thinkingOptionId":"medium"\}/);
 assert.match(prompt, new RegExp(`${ROLE_LABEL.replaceAll('.', '\\.')}.*${coderId}`));
 assert.match(prompt, /<role-operating-contract>\nOwn the implementation through acceptance/);
 assert.doesNotMatch(prompt, new RegExp(reviewerId));
 assert.doesNotMatch(prompt, /Review independently/);
 assert.match(prompt, /Never create an unlabeled child/);
});

// Regression: the placement instruction was silently dropped in the 2026-09-15 recipe
// rewrite, after which a Supervisor cut one git worktree per delegated role.
test('parent prompt keeps children in the parent workspace and forbids worktrees', () => {
 const prompt = systemPromptForRole(parent, [parent, coder, reviewer]);
 assert.ok(prompt);
 assert.match(prompt, /`launch_role` already places the child beside you/);
 assert.match(prompt, /Do not call `create_workspace`/);
 assert.match(prompt, /do not create a git worktree, branch, or separate checkout for a child role/);
 // The create_agent fallback must carry the placement instruction too.
 assert.match(prompt, /fall back to generic `create_agent`: pass your own `workspaceId`/);
});

test('non-parent role receives no delegation recipe', () => {
 assert.equal(systemPromptForRole(coder, [parent, coder]), coder.systemPrompt);
});
