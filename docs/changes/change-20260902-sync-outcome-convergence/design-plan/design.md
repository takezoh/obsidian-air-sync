# Sync outcome convergence — fresh reconciliation design

<!-- anchor: goal -->
## Goal and consultation authority

Revision `fresh-reconciliation-v1` implements the confirmed consultation decision: a local rename plus local edit is not itself a conflict; an unchanged baseline remote resource converges to the new path and current local content; only an observed remote identity/content/path or destination change enters the configured `auto_merge | duplicate` behavior.

The design has no journal, pinned payload, durable pending replay, `deferred`, `requires_attention`, operation-bound checkpoint receipt, or new conditional-provider capability. Every invocation derives its action from current local state, the committed `SyncRecord`, and a fresh remote snapshot through existing `IFileSystem` behavior. Observation/transport failure ends that invocation as retryable error with no pending row; a later ordinary trigger recomputes from scratch.

Scope is one regular-file local rename plus content edit and the partial states produced by its remote rename/write. Folder rename chains, interactive conflict UI, new provider APIs, and a general recovery state machine are out of scope.

<!-- anchor: req-local-rename-edit-convergence -->
## Requirements

`REQ-LOCAL-RENAME-EDIT-CONVERGENCE` — Given baseline remote identity `R` at `old`, current local content at `new`, fresh remote `R@old` unchanged from baseline, and remote `new` absent, sync shall automatically leave the remote at `new` with the current local content. The local rename/edit alone shall not produce conflict.

<!-- anchor: req-remote-change-conflict -->
`REQ-REMOTE-CHANGE-CONFLICT` — If fresh state shows that `R` content/path/identity or the destination occupant changed from baseline, the component shall enter the existing configured `auto_merge | duplicate` conflict behavior. No pre-conflict rename/write may overwrite the observed changed version.

<!-- anchor: req-fresh-state-classification -->
`REQ-FRESH-STATE-CLASSIFICATION` — Each invocation shall exclusively classify the component from current local, committed baseline, and fresh remote endpoint/identity/content evidence as `old_path_baseline`, `post_rename_old_content`, `converged`, `remote_changed`, `destination_conflict`, or `unknown`. Stored phase and pending-operation state shall not exist.

<!-- anchor: req-retryable-no-pending -->
`REQ-RETRYABLE-NO-PENDING` — Observation or transport failure shall use the current bounded retry/error path, perform no unsafe fallback, advance no checkpoint, and persist no pending row. The next ordinary sync shall reacquire and reclassify all evidence.

<!-- anchor: req-fresh-crash-recovery -->
`REQ-FRESH-CRASH-RECOVERY` — After crash or uncertain completion, the last committed baseline/checkpoint shall remain authoritative and the next fresh classification shall resume from the observed old-path, post-rename-old-content, converged, changed/destination-conflict, or unknown state. Blind substep retry and rollback rename are forbidden.

<!-- anchor: req-commit-last-existing -->
`REQ-COMMIT-LAST-EXISTING` — The new-path `SyncRecord` shall be committed only after rename and current-content write are freshly verified complete. The existing remote checkpoint shall commit only on a fully clean cycle; no new receipt protocol is introduced.

<!-- anchor: req-disconnected-component-progress -->
`REQ-DISCONNECTED-COMPONENT-PROGRESS` — Failure in one identity component shall stop further I/O for that component while disconnected authorized components may complete. The failed cycle remains non-clean and the existing checkpoint does not advance.

<!-- anchor: req-legacy-debt-evidence-only -->
`REQ-LEGACY-DEBT-EVIDENCE-ONLY` — Existing SyncState v6 `RenameDebt` shall not authorize replay. It may keep endpoints in one COLD/fresh reconciliation input, but only current observations authorize effects. No migration, transformation, quarantine store, marker, or workflow is added. Exact debt is removed only by existing release membership after successful consequence and safe checkpoint.

<!-- anchor: nfr-existing-provider-boundary -->
`NFR-EXISTING-PROVIDER-BOUNDARY` — The change shall keep current `IFileSystem`, checkpoint, backend registry, and shared contract families. Provider-specific code and all-provider conditional mutation are unnecessary; only backend-agnostic behavior tests for this flow are added.

## Decision dispositions

`decision-input-explicit-operation-journal`, `decision-input-separate-journal-store`, `decision-input-pinned-content`, `decision-input-journal-attention-authority`, and `decision-input-legacy-forward-only` are rejected by confirmed consultation. No substitute durable carrier is introduced.

`decision-input-remove-deferred-outcome` is adopted without replacing it with another durable workflow. Retryable failure belongs to one invocation only.

`decision-input-configured-conflict-resolver` is adopted through a narrow rename-aware adapter to the existing resolver. It maps old baseline, new local, and current remote paths into existing `auto_merge | duplicate` semantics and returns an ordinary conflict result; it does not own recovery state.

`decision-input-conditional-remote-mutation` and `DI-CONV-007` are rejected as requirements for this change. Existing interfaces remain. The contract covers evidence visible in each fresh snapshot and does not claim linearizability against an external writer racing after that snapshot.

`decision-input-observation-derived-phase`, `decision-input-smaller-nonjournal-reconstruction`, and `DI-CONV-003` are adopted as fresh classification with no stored phase. `DI-CONV-002` is rejected.

`decision-input-accepted-deferral-adrs` is partially superseded: Admission ownership, fail-closed evidence, disconnected order, exact legacy release, and checkpoint-last remain; deferred outcome and debt-as-replay-authority do not.

`DI-CONV-001` is rejected as replay authority; v6 debt remains only candidate endpoint evidence. `DI-CONV-004` is rejected as independently schedulable delete plus push; one compound executor action owns rename then write. `DI-CONV-005` is not adopted as a safety substitute: the design uses existing fresh evidence but makes no atomic mutation-precondition claim. `DI-CONV-006` is adopted by leaving SyncState v6 physically unchanged.

<!-- anchor: adr-0001-metadata-cache-is-subordinate-to-commit-last -->
## ADR projection

ADR 0001 remains accepted: per-file state follows successful I/O, the checkpoint commits only on a clean cycle, a crash reloads the committed checkpoint, and same-session failure forces COLD recovery.

<!-- anchor: adr-0002-backends-verified-by-shared-behaviour-contracts -->
ADR 0002 remains accepted without a new contract family. Existing `IFileSystem` behavior and backend fakes remain the provider boundary; new tests are sync-level behavior tests.

<!-- anchor: adr-0008-logical-identity-admission-fails-closed -->
ADR 0008 remains accepted for fresh evidence, Admission-only authority, whole-component failure isolation, and checkpoint-last. Its mandatory `deferred` outcome and debt replay interpretation are superseded.

<!-- anchor: adr-20260831-admission-owns-identity-component-decisi -->
The accepted Admission ownership ADR remains binding except for its exact three-outcome vocabulary and unchanged-debt consequence.

<!-- anchor: adr-20260831-admission-owned-local-rename-constraint-lifecycle -->
The accepted local rename lifecycle ADR remains binding for candidate-not-authority, pre-I/O evidence persistence already present, exact release membership, and checkpoint-before-release. Legacy debt no longer independently replays an action.

<!-- anchor: adr-20260902-authorized-operation-journal-with-nonreplaying-attention -->
The journal/attention ADR is rejected by confirmed consultation. Its store, payload, attention, quota/security, and forward-only rollout mechanisms are absent.

<!-- anchor: adr-20260902-compound-conflict-resolution-and-conditional-mutation -->
The conditional-mutation/checkpoint-receipt ADR is rejected by confirmed consultation. No provider interface or checkpoint receipt change remains.

<!-- anchor: adr-20260902-fresh-state-reconciliation-for-rename-edits -->
The accepted fresh-state reconciliation ADR is the decision owner for this change. Its acceptance provenance is consultation `consultation-fresh-reconciliation-20260902`, evidence `user-approve-fresh-reconciliation-20260902`.

<!-- anchor: component-fresh-reconciliation-admission -->
## Components and contracts

### Fresh reconciliation Admission

Grounding: `src/sync/sync-cycle-planning.ts`, `src/sync/cycle-admission-snapshot.ts`, `src/sync/plan-admission.ts`, `src/sync/identity-component-decision.ts`, and focused tests. Admission remains pure: acquisition supplies current observations and Admission alone chooses the component outcome.

<!-- anchor: contract-fresh-state-classification -->
`contract-fresh-state-classification` consumes the current local entity at `new`, the committed old/new `SyncRecord`, the reported/candidate edge when available, and one fresh remote snapshot resolving baseline identity and both endpoints. Producer ownership remains LocalFs, current remote `IFileSystem`, and SyncState; none is persisted as a new operation authority.

Precedence is exclusive:

1. `converged`: `R@new`, old absent, and remote content equals current local; authorize state-only baseline repair.
2. `post_rename_old_content`: `R@new`, old absent, and content equals old baseline; authorize current-content write only.
3. `old_path_baseline`: `R@old` equals baseline and new absent; authorize compound rename then current-content write.
4. `remote_changed`: baseline identity has changed content/version/path outside the two resumable states; route conflict.
5. `destination_conflict`: new is occupied by a different identity; route conflict.
6. `unknown`: identity/path/content/occupancy cannot be uniquely proved; return retryable error with zero action.

Contradictory facts are `unknown`; no default branch is baseline-unchanged. An existing v6 edge only requests endpoint observation and joins the component; it never selects a row. Normal witness is unchanged `R@old` plus local `new`. Adversarial witnesses are stale cache over changed remote, distinct destination identity, missing identity/content authority, and multiple unmatched local additions after restart.

<!-- anchor: component-fresh-compound-executor -->
### Fresh compound executor

Grounding: `src/sync/plan-executor.ts`, `src/sync/state-committer.ts`, and their tests. The new action is one serial component action, not independent rename/delete/push members.

<!-- anchor: contract-fresh-compound-execution -->
`contract-fresh-compound-execution` rechecks the in-memory local entity/content and the admitted fresh classification before each compound attempt through current interfaces. For `old_path_baseline`, it calls existing remote rename, observes the identity at `new`, reads current local bytes, writes them to `new`, then verifies old absence/new content. For `post_rename_old_content`, it skips rename and writes current bytes. For `converged`, it performs no remote I/O.

No `SyncRecord` path rewrite occurs until the terminal remote observation matches current local content. A thrown/timeout substep returns ordinary action failure; the same invocation does not retry a raw rename blindly. The next COLD/fresh invocation reclassifies. There is no rollback rename: moving the object back can race with current state and is not necessary for a recognizable post-rename intermediate.

The correctness claim is snapshot-bounded. The existing interface cannot provide atomic preconditions against an external writer after the final observation; this change does not invent that guarantee. Current provider behavior, failure classification, and action retry limits remain. A later local edit remains dirty and is reconciled by a later invocation.

<!-- anchor: component-rename-edit-conflict-adapter -->
### Rename-edit conflict adapter

Grounding: `src/sync/conflict-resolver.ts`, `src/sync/conflict.ts`, `src/sync/merge.ts`, `src/sync/conflict-history.ts`, and their tests. The configured strategies and audit result remain existing public behavior.

<!-- anchor: contract-existing-conflict-adaptation -->
`contract-existing-conflict-adaptation` supplies a transient rename-aware view containing target path `new`, local read path `new`, baseline content path `old`, current remote read path, and the three current entities to the existing resolver. It changes neither `ConflictStrategy` nor provider interfaces. The adapter ensures no rename/write runs before conflict resolution.

`auto_merge` reads the old merge base, current local bytes at `new`, and observed remote bytes at their current path, then applies the existing merge/fallback semantics to the target view. `duplicate` preserves the observed remote version using the existing conflict-sibling rules and keeps the local version at the target. Each fresh invocation delegates at most once to the configured existing resolver semantics. No ownership inference from content equality and no exactly-once conflict-artifact guarantee are added; a later invocation observes current state and, if it still classifies conflict, delegates independently.

Normal witness passes base/local/remote content from different paths to the existing strategy. Adversarial witnesses prove remote change routes here before rename/write, destination occupancy is preserved under the existing resolver contract, and one fresh invocation calls the configured resolver no more than once. Tests do not assert conflict-artifact deduplication across invocations.

<!-- anchor: component-existing-finalization -->
### Existing finalization and legacy debt release

Grounding: `src/sync/sync-cycle-finalization.ts`, `src/sync/rename-debt.ts`, `src/sync/state.ts`, `src/sync/orchestrator.ts`, and tests.

<!-- anchor: contract-existing-recovery-finalization -->
`contract-existing-recovery-finalization` uses only existing commit-last state. Complete rename/write or conflict result commits the new-path record; an uncertain/failed invocation commits neither that record nor checkpoint and sets existing same-session COLD recovery. Crash reloads the last checkpoint. The next invocation sees old baseline, post-rename old content, converged, changed/conflicting, or unknown and chooses from the classification contract.

Existing v6 `RenameDebt` is not converted, copied, quarantined, or treated as action authority. Its exact edge may keep endpoints in COLD acquisition. Admission emits existing release membership only when fresh facts prove resolved-no-action or a successful authorized consequence. Existing finalization deletes that exact key after the clean checkpoint, and retains it on failure/unknown/checkpoint failure. No new store, marker, or rollback mode exists.

Disconnected authorized actions may finish and commit their per-file records; any failure/unknown withholds the global checkpoint. Status remains existing `partial_error`/`error` without deferred count. A later ordinary trigger is the only recovery scheduler.

## Dependency-ordered units

`unit-fresh-classification-admission` adds the six-state pure classification, compound action shape, legacy-edge-as-candidate treatment, and exhaustive tests. It changes no provider or persistent schema.

`unit-fresh-execution-conflict` implements serial rename/write resume behavior and the narrow path-aware adapter into existing conflict strategies, with crash/partial and single-delegation tests.

`unit-existing-finalization-observability` commits the terminal record through existing finalization, removes deferred presentation/replay authority, preserves exact legacy release after checkpoint, updates docs/guards, and runs the repository gate.

## Acceptance

`acceptance-unchanged-remote-converges` — baseline `R@A/H0`, local `A -> B/H1`, fresh remote `R@A/H0`, and absent `B` ends with `R@B/H1`, new-path record, clean checkpoint, and no conflict/deferred/pending state.

`acceptance-remote-change-uses-existing-conflict` — changed `R`, changed path, or distinct destination enters configured existing conflict behavior before any rename/write and preserves the observed remote version.

`acceptance-partial-effect-fresh-resume` — crash/timeout before rename, after rename, after write, or after record commit is reclassified on the next invocation as old-path baseline, post-rename old content, converged, conflict, or unknown; no rollback or raw substep replay occurs.

`acceptance-retryable-has-no-row` — injected observation/transport failure exhausts current bounded retry, commits no pending state/checkpoint, and a later ordinary sync performs a fresh acquisition.

`acceptance-legacy-debt-safe-release` — a v6 fixture never authorizes an effect, participates only in COLD endpoint acquisition, and is exact-deleted only through existing successful consequence plus safe checkpoint.

`acceptance-existing-boundaries-only` — no journal/payload/attention/checkpoint-receipt/conditional-provider symbol or store exists; current `IFileSystem`, backend matrix, and checkpoint interfaces remain unchanged.

## Critique and consultation resolutions

The confirmed consultation supersedes the previous journal mechanism and its associated patch set:

- `issue-journal-replays-indefinitely`, `issue-journal-capacity-unbounded`, and `issue-pinned-content-security-unowned` are resolved by deleting the journal, payload, pending replay, and attention mechanism entirely.
- `issue-conflict-handoff-does-not-fit-resolver` is resolved by the narrow transient path-aware adapter into the existing resolver.
- `issue-conflict-recovery-not-journaled` is superseded by consultation scope: the active design adds no exactly-once conflict-artifact claim. Each invocation recomputes the whole conflict input and delegates once to existing resolver semantics; artifact recovery remains that existing contract.
- `issue-checkpoint-proof-is-not-versioned` is not applicable after journal cleanup is removed; existing checkpoint-last clean-cycle semantics remain the only checkpoint claim.
- `issue-old-debt-rollout-remains-open` is resolved by retaining the unchanged v6 row as non-authoritative endpoint evidence and using existing exact release-after-checkpoint, with no migration/quarantine/rollback workflow.

There are no open design choices and no unverified provider-capability gate.
