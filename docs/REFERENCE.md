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
- A finished or failed child wakes its idle gated parent to handle the result, even while siblings still work. Parentage is read from persisted child labels, so this works for children created before a plugin reload; no lifecycle-map reconstruction is needed. A quiescence beat and parent generation check avoid a duplicate wake when the parent resumed itself. Explicit cancellation does not trigger a wake, and a parent's own pending permission is respected. Deleted roles are reported as unavailable rather than silently treated as passed or recreated. The nudge does not race Paseo's own child-finished notification: it waits while `~/.paseo/finish-subscriptions.json` still lists that parent/child pair (up to 60 s), then gives the parent 3 s to start its turn. If the file is unreadable it waits a fixed 20 s instead.
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

Every role launch runs through one server-side path. By default, the child receives the role's operating contract as its system prompt, its configured provider/model/reasoning/mode, the role label, the Paseo parent/child link, placement in the parent's own workspace and working tree, and any configured inherited parent context.

Parent roles delegate with the plugin's own `launch_role` tool. It is served over MCP from the plugin process and attached per agent, so only agents this plugin launched can see it; the credential in that agent's configuration identifies the calling parent, which is how the allowed-role checklist is enforced in code rather than in prose. `list_roles` returns the permitted catalog with IDs, provider/model, settings and inherited-context defaults. The tools are always loaded; exact tool preapproval is applied on providers that support it. A child that may itself delegate is issued its own credential during the launch.

`launch_role` and the `roles.launch` plugin RPC accept optional `model` and `thinkingOptionId` overrides for that launch only. `model` is the model ID within the role's existing provider, including any model namespace (for example `openai/gpt-6.1-terra` for Pi); it does not change the provider. `thinkingOptionId` is a reasoning option ID such as `high`; pass `null` to use the provider default. Omitted fields retain the role defaults independently, so when changing models choose a compatible reasoning level too. Use Paseo's `list_models` for available IDs and options. The launch result from `launch_role` reports the requested effective provider/model and reasoning setting. The saved role, its mode, permissions, context rules and instructions are not changed. Providers handle model and reasoning compatibility; an accepted launch does not independently prove that a provider honored those settings.

Paseo's built-in `create_agent` has no `roleId` or `systemPrompt` argument, so it cannot perform that launch. The appended parent prompt therefore leads with `launch_role`, and retains the exact role-equivalent `create_agent` recipe—role ID, provider, settings, required label, operating contract, and the parent's own `workspaceId`—only as a fallback for sessions where the tool is unavailable.

The remaining gap is honest: a parent can still call generic `create_agent` directly. Preventing that needs a per-agent tool policy. Paseo's `ProviderPaseoToolsPolicy` (`enabled`, `disabledTools`) resolves per provider and daemon-wide, so disabling `create_agent` for one Supervisor would disable it for every agent on that provider. The plugin does not pretend otherwise, and does not race to archive an already-started unauthorized child.

## Restricting subagent communication

The role setting **Subagents can only message this agent** (`delegation.restrictChildCommunication`, Delegation section of the role editor) makes every subagent of an agent launched from that role a *worker*: it must run on the `pi-worker` provider, has no Paseo tools, and has exactly one way to reach another agent, a `message_parent` tool that sends a message to its parent. The setting is stamped on the agent as the label `paseo-role-orchestrator.child-policy=parent-only` when the role launches, like the captured system prompt: editing the role later does not change agents already running. Agents that do not carry the label, including every agent from a role with the setting off, are never touched.

### Daemon provider (one-time setup)

Add a provider that extends `pi` with Paseo tools turned off. It inherits `pi`'s launch command, so the `agent-scope.sh` and chrome-bridge guard wrapper apply unchanged; only the model list is copied, because a derived provider without `models` shows every model Pi discovers instead of the curated list. With `jq`:

```bash
jq '.agents.providers["pi-worker"] = {extends: "pi", label: "Pi worker", paseoTools: {enabled: false}, models: .agents.providers.pi.models}' ~/.paseo/config.json > /var/tmp/config.json && mv /var/tmp/config.json ~/.paseo/config.json && paseo reload
```

The resulting entry is `"pi-worker": { "extends": "pi", "label": "Pi worker", "paseoTools": { "enabled": false }, "models": [ <same array as pi> ] }`. Re-run it after changing the `pi` model list. Roles that launch workers choose provider `pi-worker` and any `pi` model.

Why not `enabled: true` with `disabledTools`? Paseo delivers plugin-attached tools through its own MCP server, and `enabled: false` stops that server being injected at all (and filters plugin tools). So `message_parent` is served by this plugin's own MCP endpoint (`/worker-mcp`, launch-only through `agent.session_open`) rather than as an attached tool. The result is default-deny: a Paseo upgrade that adds tools cannot leak them to workers.

### Enforcement

`before("agent.session_open")` runs during creation before the provider session exists. For a child whose `paseo.parent-agent-id` parent carries the policy label:

- **create** on any provider other than `pi-worker` throws `This parent's subagents must use provider pi-worker; relaunch with that provider.` The daemon wraps it as `Plugin paseo-role-orchestrator before agent.session_open failed: ...`; it reaches the parent's `create_agent` call (or `launch_role`, which also refuses earlier, before any summary helper is made).
- **create** on `pi-worker` attaches the `parent` MCP server (credential signed per agent) and puts a `paseo` shim that refuses first on the agent's `PATH`.
- **resume, refresh, import** are not enforced: an existing child reopens as it was, and a worker has its tool and shim re-attached because session-open overrides are re-derived on every open. History-only opens are ignored.
- The plugin's own helpers under a restricted parent (context summaries, completion judges) are exempt through a one-time label that is spent on first use, so copying it onto a later `create_agent` fails.

`message_parent` reads the parent from the calling agent's own `paseo.parent-agent-id` label (never from the request) and sends the text to that agent. A worker's final report still reaches its parent through Paseo's normal finish notification.

### Telling the parent

A role with the setting on gets this section appended to its system prompt at launch: every subagent must use provider `pi-worker` (for example `pi-worker/<model id>`), other providers are refused, workers have no Paseo tools and can only `message_parent`, and a listed child role can only be launched if its provider is `pi-worker`. Nothing else is needed in the role prompt. Configure the child roles of a restricted parent with provider `pi-worker` so `launch_role` works.

### Limits

- The `paseo` shim is a speed bump: a worker with a shell can still call the real CLI by absolute path or talk to the daemon directly. Real isolation would need the worker's process sandboxed from the daemon port.
- Only creation through the daemon is checked. An agent that creates children outside the `paseo.parent-agent-id` link (for example a detached create in a Paseo version that offers one) is not seen by the hook; Paseo 0.14's `create_agent` always links the caller as parent.
- Enabling the plugin's `agent.session_open` hook marks every open agent session stale once (Paseo reopens each before its next idle prompt); roles with the setting off behave as before.

### What a refused creation leaves behind

Checked on a throwaway 0.14 daemon: a refused `create_agent` over MCP leaves no agent record, no files, no workspace or worktree (an MCP `create_agent` places the child in the caller's existing workspace and has no worktree option), and starts no process, because the refusal happens before `createSession`. A refused creation from the app/CLI creation path leaves one failed creation receipt in `~/.paseo/creations/` (about 600 bytes plus a 64-byte claim file, the same ledger every creation writes, never pruned). The daemon also keeps one small in-memory entry (the agent's Paseo tool policy, set just before the hook runs) until restart; a plugin cannot clear it.

## Re-reading the role contract after compaction

The role setting **Re-read this prompt after compaction** (`rereadAfterCompaction`, default off, shown under the system prompt in the role editor) makes the plugin re-send the role contract to an agent after its context is compacted. Paseo has no compaction event, so the plugin looks for one when a turn ends (`agent.turn_ended`).

- **Which agents:** any agent carrying the `paseo-role-orchestrator.role-id` label whose role currently has the setting on. The role is read at turn end, so the setting also applies to agents already running.
- **Detection:** the plugin fetches the agent's timeline from the tail, paging back until it reaches a row at or before the stored position (no fixed row limit), and looks for a `compaction` item with `status: "completed"`. `loading` compactions are ignored; compaction items carry no id, so rows are identified by their timeline sequence number (`seqStart`).
- **Dedupe:** per agent, the sequence number of the last compaction already answered is stored in `plugin-data/role-orchestrator-compaction.json`. Only a completed compaction with a higher sequence number triggers, and the number is stored before the message is sent, so a failed send is not retried on every later turn. The follow-up's own turn contains no compaction, so it cannot retrigger; a second compaction later triggers a second re-read. Storage survives plugin reloads.
- **Follow-up:** `Your context was just compacted. Before anything else, re-read your role contract below and the files it tells you to read at start, then continue.` followed by the role's system prompt as the plugin builds it (`systemPromptForRole`, including the delegation catalog), sent with the normal agent send. Unlike launch-time capture, the current role text is used, so role edits are picked up.
- **Limits:** the check runs at the end of the turn in which the compaction happened, so a compaction that occurs while the agent is idle (for example a manual compaction outside any turn) is only noticed at the next turn end. An agent with no stored position and an old compaction in its history gets one re-read at its next turn end after the setting is switched on. A role with an empty prompt and no delegation sends nothing.

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
