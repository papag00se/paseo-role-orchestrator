# Paseo Role Orchestrator

A trusted local Paseo plugin for reusable, provider-neutral agent roles. Requires Paseo 0.14.x on both the daemon and connected app.

## Paseo 0.14 compatibility

- `@getpaseo/plugin`, `@getpaseo/client`, and `@getpaseo/protocol` development dependencies are pinned to 0.14.0. The manifest excludes older runtimes and the next minor release pending validation.
- The client uses supported settings screens, contextual workspace panels, and a global Command Center action. There are no legacy `addSurface`, `addSidebarItem`, or composer registrations to migrate. `PluginSurfaceProps` remains the documented settings-screen contract in 0.11.2.
- Modal forms use host-provided `TextInput` for native sheet keyboard handling and a single scroll owner (`Modal.Content`). Panel lists use the host-provided `ScrollView`.
- Role catalog, gate settings, failure evidence, and delegation credentials retain their existing storage paths and formats. No settings migration or reset is performed.
- Reload only this installation with `paseo plugin reload paseo-role-orchestrator`; do not remove it or restart the daemon.

Validation on 0.14.0 SDK (2026-10-31): typecheck and all 71 tests passed; live reload is checked after the desktop upgrade.

Validation on 0.11.2: typecheck and all 63 tests passed. Live reload reported `running` with no current load error, and logs recorded `Plugin ready`. Read-only RPC checks returned all four existing roles and configured gate settings; an invalid role launch was correctly rejected without creating an agent. Client contract tests exercise settings navigation and wide/compact role-editor rendering with host primitives, but are not a real-device visual test. Completion tests use mocked providers; no live judge model turn was started during migration.

`npm audit` reports 22 development-tree advisories (5 moderate, 16 high, 1 critical), mainly in the pinned React Native tooling. These dependencies are not shipped as plugin runtime modules: Paseo supplies the UI runtime. Upgrading the host UI stack is outside this plugin migration.

## Included

- Persisted daemon-local role catalog.
- Role settings: provider, model, reasoning level, optional provider mode, a parent-facing delegation description, and system prompt.
- Per-role delegation policy: `Can invoke other roles`, an allowed-child-role checklist, and a mutually exclusive child-context policy: none, the complete unedited parent timeline, or a temporary same-model context summary. Parent roles receive an appended delegation appendix containing only their allowed child names/descriptions and the relevant built-in Paseo child-management tools.
- Root-role launcher in the workspace `Roles` panel.
- Child-role launcher in an agent's `Child roles` panel, restricted to that parent role's checklist.
- Real Paseo parent/child relationships and role labels.
- A live workspace role-agent hierarchy that opens the regular Paseo agent chat on selection, including completion-gate judges and evidence-summary agents. Completion calls are nested beneath the role run they evaluate and remain visible when finished/archived runs are enabled.
- Completion checks select user requests, clarification exchanges, and assistant responses—not raw tool output or serialized timelines. Earlier exchanges are retained to interpret follow-ups such as “yes”; the judge is instructed to honor superseding requests and independently inspect workspace evidence. A blocked current or high-priority item does not stop continuation while any safe, authorized work remains elsewhere in the request; `blocked` is reserved for a globally blocked remaining ledger. The judge also treats repeated exhaustive runs with changing or recurring failure classes as a strategy problem: it requests focused root-cause stabilization instead of another generic repair-and-rerun cycle. Known system-notification/plugin prompt envelopes and legacy parent-summary responses are excluded. Paseo’s hook messages lack trusted origin metadata, so this envelope filtering is not a universal origin guarantee.
- Completion verdicts fail closed. The judge is instructed that a committed plan or report of intended work is not that work performed. A verdict wrapped in prose or fences is extracted (the last verdict-bearing JSON object wins); a reply with no valid verdict gets one constrained retry in the same gate session; if that also fails, the parent receives an honest “completion is unconfirmed — continue” message instead of being left idle as if it had passed. Every unparseable judge reply is preserved verbatim in `plugin-data/role-orchestrator-gate-failures.jsonl`. Judge infrastructure failures (the gate agent errors or never answers) stay quiet as before, so a dead judge provider cannot nag the parent in a loop.
- Every completed turn of a gate-enabled role is judged, including turns with running descendants. The judge receives fresh descendant identities, statuses and permission counts from the daemon's persisted parent labels. A busy child does not prove that the whole unfinished request is busy. As in Juke, actual ongoing work is distinguished from promises or status reports, and a steering/status message does not cancel an unfinished authorized task. The judge checks background jobs, scripts/services and bound ports with its tools; `waiting` requires verified coverage of every unfinished requirement, while independent runnable work receives `continue`. Persistent dev servers do not by themselves cover unfinished task requirements. Archived agents and internal judge/context helpers are excluded. A failed live query prevents an unverified judgment and is logged.
- A finished or failed child wakes its idle gated parent to handle the result, even while siblings still work. Parentage is read from persisted child labels, so this works for children created before a plugin reload; no lifecycle-map reconstruction is needed. A quiescence beat and parent generation check avoid a duplicate wake when the parent resumed itself. Explicit cancellation does not trigger a wake, and a parent's own pending permission is respected. Deleted roles are reported as unavailable rather than silently treated as passed or recreated.
- Oversized evidence is summarized in successive chunks using the configured judge model in separate, unparented Paseo sessions, archived afterward. No summary prompts go to the Supervisor. These are isolated harness sessions, not direct vendor API calls; tool restrictions are prompt instructions, not a sandbox. Summaries preserve requirements, evidence, unresolved work, contradictions, and uncertainty.
- Budgeting uses conservative UTF-8 byte estimates and reserves half the advertised model window for runtime instructions, tools, and output. When model-window metadata is missing, the judge first receives selected evidence unchanged; actual provider context errors trigger hierarchical summarization with progressively smaller chunk budgets, never truncation. Exact runtime token usage is not exposed by the plugin SDK. Evidence budgeting is fully automatic; there is no gate-context setting to choose.

The [2026-10-14 completion gate recovery](completion-gate-recovery.md) records the original failure, Juke comparison, source-negative controls and live replacement/continuation verification.

Run client compatibility, extraction, summarization, and lifecycle integration tests with `npm test` on Node with TypeScript stripping and `registerHooks` support (Node 22.18+). Integration tests cover missing model-window metadata, all verdict dispositions, overflow recovery, stale results, failed parent turns, prose-wrapped verdict extraction, the constrained malformed-verdict retry, and the fail-closed continuation with preserved raw judge output. Provider responses are mocked; these tests do not replace a live model smoke test.

The task text entered when launching an agent is separate from the role's persistent system prompt. Full-context delegation attaches every canonical timeline entry without truncation; if that exceeds the child model's context window, the provider error is preserved. Summary delegation creates and archives a temporary child agent configured with the parent's current provider/model/reasoning/mode, then attaches its returned summary.

## Permission behavior

This plugin does not modify provider modes, permission prompts, approval policies, or Paseo's permission handling.

## Delegation

The [suggested Supervisor prompt](prompts/supervisor.md) requires a Coder child for substantive agentic coding, keeps implementation and related tests with one owner, and uses additional children for independent work or risk-appropriate review. It discourages per-step approval gates and duplicate verification. This is prompt guidance, not a new runtime restriction or an automatically installed default for user-owned roles.

Role edits apply to subsequent launches. Existing agents retain their captured system prompt unless explicitly updated; saving a role does not restart agents or rewrite their sessions.

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
paseo plugin add git:papag00se/paseo-role-orchestrator
```

Paseo runs the manifest preparation step (`npm ci --legacy-peer-deps`) when installing from GitHub. The development dependencies support local typechecking and tests; Paseo supplies the matching SDK and UI modules at runtime.

For a local checkout:

```bash
paseo plugin install /absolute/path/to/paseo-role-orchestrator
```
