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

## Delegation

Every role launch runs through one server-side path, so a role run is identical whether it was started from the workspace panel, the **Child roles** panel, or by a parent agent: the child receives the role's operating contract as its system prompt, the role's exact provider/model/reasoning/mode, the role label, the Paseo parent/child link, placement in the parent's own workspace and working tree, and any configured inherited parent context.

Parent roles delegate with the plugin's own `launch_role` tool. It is served over MCP from the plugin process and attached per agent, so only agents this plugin launched can see it; the credential in that agent's configuration identifies the calling parent, which is how the allowed-role checklist is enforced in code rather than in prose. `list_roles` returns the permitted catalog with IDs, provider/model, settings and inherited-context defaults. Both tools are preapproved and always loaded so permission friction never pushes a parent back to generic `create_agent`. A child that may itself delegate is issued its own credential during the launch.

Paseo's built-in `create_agent` has no `roleId` or `systemPrompt` argument, so it cannot perform that launch. The appended parent prompt therefore leads with `launch_role`, and retains the exact role-equivalent `create_agent` recipe—role ID, provider, settings, required label, operating contract, and the parent's own `workspaceId`—only as a fallback for sessions where the tool is unavailable.

The remaining gap is honest: a parent can still call generic `create_agent` directly. Preventing that needs a per-agent tool policy. Paseo's `ProviderPaseoToolsPolicy` (`enabled`, `disabledTools`) resolves per provider and daemon-wide, so disabling `create_agent` for one Supervisor would disable it for every agent on that provider. The plugin does not pretend otherwise, and does not race to archive an already-started unauthorized child.

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
