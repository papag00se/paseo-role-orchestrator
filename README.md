# Paseo Role Orchestrator

A trusted local Paseo plugin for reusable, provider-neutral agent roles.

## Included

- Persisted daemon-local role catalog.
- Role settings: provider, model, reasoning level, optional provider mode, a parent-facing delegation description, and system prompt.
- Per-role delegation policy: `Can invoke other roles`, an allowed-child-role checklist, and a mutually exclusive child-context policy: none, the complete unedited parent timeline, or a temporary same-model context summary. Parent roles receive an appended delegation appendix containing only their allowed child names/descriptions and the relevant built-in Paseo child-management tools.
- Root-role launcher in the workspace `Roles` panel.
- Child-role launcher in an agent's `Child roles` panel, restricted to that parent role's checklist.
- Real Paseo parent/child relationships and role labels.
- A live workspace role-agent hierarchy that opens the regular Paseo agent chat on selection.

The task text entered when launching an agent is separate from the role's persistent system prompt. Full-context delegation attaches every canonical timeline entry without truncation; if that exceeds the child model's context window, the provider error is preserved. Summary delegation creates and archives a temporary child agent configured with the parent's current provider/model/reasoning/mode, then attaches its returned summary.

## Permission behavior

This plugin does not modify provider modes, permission prompts, approval policies, or Paseo's permission handling.

## Current delegation boundary

The appended parent prompt tells an agent to use Paseo's built-in `create_agent`, monitoring, follow-up, and lifecycle tools. This requires the daemon's normal MCP tool injection (enabled in this installation) and leaves its existing permission behavior untouched. The plugin's UI enforces the role checklist; a dedicated, policy-enforced `launch_role` MCP tool remains a separate native-daemon phase.

## Development

```bash
npm install
npm run typecheck
```

Install with:

```bash
paseo plugin install /absolute/path/to/paseo-role-orchestrator
```
