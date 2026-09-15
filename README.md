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
- Completion checks select user requests, clarification exchanges, and assistant responses—not raw tool output or serialized timelines. Earlier exchanges are retained to interpret follow-ups such as “yes”; the judge is instructed to honor superseding requests and independently inspect workspace evidence. A blocked current or high-priority item does not stop continuation while any safe, authorized work remains elsewhere in the request; `blocked` is reserved for a globally blocked remaining ledger. The judge also treats repeated exhaustive runs with changing or recurring failure classes as a strategy problem: it requests focused root-cause stabilization instead of another generic repair-and-rerun cycle. Known system-notification/plugin prompt envelopes and legacy parent-summary responses are excluded. Paseo’s hook messages lack trusted origin metadata, so this envelope filtering is not a universal origin guarantee.
- Oversized evidence is summarized in successive chunks using the configured judge model in separate, unparented Paseo sessions, archived afterward. No summary prompts go to the Supervisor. These are isolated harness sessions, not direct vendor API calls; tool restrictions are prompt instructions, not a sandbox. Summaries preserve requirements, evidence, unresolved work, contradictions, and uncertainty.
- Budgeting uses conservative UTF-8 byte estimates and reserves half the advertised model window for runtime instructions, tools, and output. When model-window metadata is missing, the judge first receives selected evidence unchanged; actual provider context errors trigger hierarchical summarization with progressively smaller chunk budgets, never truncation. Exact runtime token usage is not exposed by the plugin SDK. Both legacy context settings now use automatic budgeting.

Run extraction, summarization, and lifecycle integration tests with `node --test server/*.test.mjs` on Node with TypeScript stripping and `registerHooks` support (Node 22.18+). Integration tests cover missing model-window metadata, all verdict dispositions, overflow recovery, stale results, and failed parent turns. Provider responses are mocked; these tests do not replace a live model smoke test.

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

Install from GitHub:

```bash
paseo plugin add papag00se/paseo-role-orchestrator
```

Paseo runs the manifest build step (`npm ci`) when installing from GitHub, so the development dependencies needed to bundle the plugin are installed automatically.

For a local checkout:

```bash
paseo plugin install /absolute/path/to/paseo-role-orchestrator
```
