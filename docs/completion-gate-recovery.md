# Completion gate recovery, 2026-10-14

## Failure and correction

The recovery Supervisor could end a turn without a completion judgment whenever any descendant was active. The lifecycle handler, verdict freshness predicate, final continuation dispatch and child-finish wake each treated an active sibling as an exemption for the whole request. This upstream assumption confused a single busy task with complete coverage of the outstanding mission.

The correction is a root-cause fix: completed eligible turns reach the judge with a fresh, persisted-parent-label descendant snapshot. The judge distinguishes globally covered in-flight work from independent runnable work. Child results wake an idle parent even while siblings work. Reading persisted parentage also recovers the child-finish edge after plugin reloads; failed children are handled, cancellation and the parent's own pending permissions remain respected.

Separately, the deleted mission-specific role left the old Supervisor labeled with a nonexistent role ID. This is reported explicitly, not aliased by name or recreated. Replacing the agent using the operator's existing Supervisor role is a recovery path, not permission to create another role.

## Juke comparison

Reviewed `juke/server/judge.ts` and `juke/shared/jukes.ts` in the sibling checkout. Juke uses semantic evidence to distinguish actual ongoing work from promises, respects genuine blockers and permissions, and keeps an outstanding task alive across steering and status questions. It has no separate operating-system process monitor; its judge is instructed not to use tools.

The completion gate already instructed its judge to inspect scripts/services, background processes and ports. Its blanket early returns prevented that instruction from being reached. The corrected path retains those independent checks, supplies authoritative descendant statuses and permission counts, and explicitly requires coverage of every unfinished requirement for `waiting`. A persistent development server is not proof that unrelated task work is running. No unrelated Juke feature toggles or second competing judge were added.

## Verification

- All 71 local plugin tests pass, including real-entry lifecycle tests and runtime-schema typechecking.
- The complete original gate source is retained in ignored `tmp/completion-gate-2026-10-14/old-gate.ts.txt`.
- Loading that original source against the final regression tests produces 10 failures / 21 passes. Failures include the busy-child exemption, sibling-delayed wake, reload parentage, failed-child handling and deleted-role visibility.
- Provider replies in unit tests are network-boundary fakes; they prove gate lifecycle/disposition behavior, not a live model's semantic accuracy. Live existing-role smoke `7c221867-8383-4acd-9842-2c40e58c973b` answered its information-only request and received a fresh nonstale `pass` at 22:09:44 UTC. Its preserved receipt is `tmp/completion-gate-2026-10-14/live-smoke-gate-log.json`; that smoke does not credit the recovery mission.
- Replacement Supervisor `2b3b887b-0138-4aaa-9bce-127fd3c203de` was launched through the existing role `e160023a-0660-4424-9248-bbb89a244c8e`, preserving its Sol model and Medium reasoning and the shared Sol/Low judge. The complete role catalog was read back unchanged. Eleven existing children were transferred with every other label preserved before the former idle Supervisor was archived; no history or worktree was removed.
- The replacement performed a real handover, loaded ten finished worker results and recorded the unchanged 164-identity census with 111 terminal / 53 unresolved. At 22:17:08 UTC its gate returned nonstale `continue`, naming PR494 independent integration, finished-result processing and original521 reconciliation. The new turn started at 22:17:08.233 UTC, proving the continuation was actually delivered. Receipts: `replacement-live-gate-verdict.json`, `replacement-after-gate.json` and `replacement-takeover.json` in that evidence directory. The original PR mission remains unfinished.
- No daemon restart, production gateway restart, credential change, signing, transaction submission or role creation is part of this correction.
