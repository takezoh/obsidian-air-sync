# Remote working-view abort — canonical design

<!-- anchor: goal -->
## Goal and scope

Remove `SyncOrchestrator.recoverViaColdScan` and make every incomplete sync attempt repeatable by closing the existing remote checkpoint working view. A wholly clean attempt commits that view; every other attempt discards it before retry or return. The next attempt is selected from the last durable checkpoint/scope, committed per-file `SyncRecord`s, the current tracker snapshot, and current endpoints. COLD, WARM, and HOT remain ordinary acquisition strategies, not recovery modes.

In scope are the required `IncrementalCheckpoint` lifecycle API, `CachingRemoteFs` live-view ownership and durable queries, sync finalization and exception routing, executor sibling settlement, priority invalidation, the shared three-provider checkpoint contract, and an in-place revision of ADR 0001. Out of scope are new state/store/schema/version/migration, a recovery marker or pending-work ledger, a second cache snapshot, a replacement orchestrator field, cancellation of effects that already started, provider wire changes, and changes to retry, conflict, rename, or per-file commit policy.

<!-- anchor: approach -->
## Chosen approach

`IncrementalCheckpoint` gains a required `abortWorkingView(): Promise<void>`. `CachingRemoteFs` implements it under its existing mutex by clearing only `cache`, `initialized`, `_changesPageToken`, and `_scopeFingerprint`. It performs no provider operation and no `MetadataStore` write or clear. The later ordinary acquisition lazily restores the durable checkpoint, or performs the existing fresh scan if no durable checkpoint is known.

The cycle has an exhaustive terminal boundary: clean means commit; all incomplete returned outcomes mean abort. Exceptions from observation through execution abort before the existing classifier, delay, retry, notification, or return. A commit rejection also aborts before propagation. Backend-state/settings work occurs after the checkpoint boundary, so its failure does not issue a second abort. An abort invariant failure propagates and cannot be treated as a successful retry.

Before the orchestrator discards the working view, `executePlan` settles every promise already scheduled in the failing parallel join. The existing `Promise.all` remains the rejection selector: its exact rejected object is captured, scheduled siblings are awaited with `Promise.allSettled`, and that same object is rethrown. This changes publication timing only; it introduces no error-type or input-order precedence.

### Alternatives rejected

- `resetCheckpoint` is destructive to durable state and remains reserved for explicit Rescan/identity lifecycle.
- Reconstructing the filesystem or adding copy-on-write snapshots, recovery flags, journals, or pending ledgers widens state ownership.
- Acquisition self-rollback cannot decide whether the later cycle outcome is commit-safe.
- An implicit destructor/finalizer cannot be awaited at every retry and exception boundary.

<!-- anchor: fr-wv-001 -->
### FR-WV-001 — checkpoint-owned abort

An incomplete checkpoint-capable attempt shall invoke the required, idempotent, live-only `abortWorkingView` and shall leave provider state and the durable checkpoint unchanged.

<!-- anchor: fr-wv-002 -->
### FR-WV-002 — exhaustive closeout

Finalization shall commit exactly a wholly safe cycle and abort every Admission rejection, failed/blocked result, missing terminal proof, or `checkpointBlocked` result; commit rejection shall abort before propagation.

<!-- anchor: fr-wv-003 -->
### FR-WV-003 — exceptional ordering

Observation, preparation, Admission, and execution exceptions shall abort before classification/retry, while post-closeout backend-state/settings exceptions shall not cause a second abort.

<!-- anchor: fr-wv-004 -->
### FR-WV-004 — fatal settlement

`AuthError` and `InternalFreshInvariantError`, exactly the current cycle-fatal action classes, shall move the active batch to `aborting`, settle scheduled siblings, invalidate queued work, and rethrow the same rejection selected by the existing aggregate before working-view discard.

<!-- anchor: fr-wv-005 -->
### FR-WV-005 — ordinary convergence

Equivalent current facts shall converge through ordinary COLD, WARM, or HOT acquisition without prior-error input or a successor to `recoverViaColdScan`.

<!-- anchor: fr-wv-006 -->
### FR-WV-006 — durable queries and reset separation

`hasCheckpoint` and `getScopeFingerprint` shall query durable metadata only; missing data or read failure shall conservatively return `false`/`null`. An uncommitted fresh scan shall not change those answers. Only existing explicit reset flows may clear durable checkpoint data.

<!-- anchor: fr-wv-007 -->
### FR-WV-007 — priority and supersession

Detached priority invalidation or `checkpointBlocked` shall abort. An exact admitted pull completed by priority and marked superseded remains terminal and may participate in a clean commit.

<!-- anchor: fr-wv-008 -->
### FR-WV-008 — provider-shared replay

Google Drive, Dropbox, and OneDrive shall run one observable shared contract covering same-instance replay, no-checkpoint/fresh-scan behavior, arbitrary-prefix pagination failure, checkpoint failure, scope restoration, folder-rename replay, replay-free subtree snapshots, crash reconstruction, and abort/reset separation.

<!-- anchor: nfr-wv-001 -->
### NFR-WV-001 — closed authority set

The change shall add no durable authority, schema, migration, recovery ledger, intermediate correctness state, or orchestrator field. The only durable correctness authorities remain successful per-file `SyncRecord`s and the complete remote cache/cursor/scope checkpoint committed after a wholly clean cycle.

<!-- anchor: nfr-wv-002 -->
### NFR-WV-002 — discriminating verification

Tests shall distinguish live from durable facts and shall fail when abort is absent or races scheduled siblings. A no-op abort spy or always-repeating delta fake is insufficient convergence evidence.

## Components

<!-- anchor: component-checkpoint-owner -->
### Checkpoint owner

`src/fs/interface.ts`, `src/fs/caching/remote-fs.ts`, and `src/store/metadata-store.ts` own `contract-working-view-lifecycle`. The capability becomes all-or-nothing: if `checkpoint` exists, abort is required; a filesystem without the capability receives neither commit nor abort.

`hasCheckpoint` and `getScopeFingerprint` consult the durable store even when the object has an initialized live view. Absence and read error produce `false`/`null`, selecting ordinary COLD conservatively without creating an abort obligation or exposing live candidates. `commitCheckpoint` passes a candidate scope into atomic persistence and may publish it to live fields only after save success.

<!-- anchor: component-cycle-boundary -->
### Cycle boundary

`src/sync/orchestrator.ts`, `src/sync/sync-cycle-finalization.ts`, and `src/sync/change-detector.ts` own `contract-cycle-closeout` and `contract-temperature-convergence`. Structural try/catch regions distinguish pre-closeout failures, which require abort, from post-closeout settings failures, which do not. No outcome flag or field records that distinction.

<!-- anchor: component-executor-settlement -->
### Executor settlement

`src/sync/plan-executor.ts`, `src/sync/priority-batch-state.ts`, and the existing pools own `contract-fatal-settlement`. Both current fatal classes invoke the existing active-batch abort transition before their permit is released. `beginAction` retains supersession handling and then rejects invalidated/aborting queued actions before provider I/O. Started actions settle normally, including any successful per-file record commit; no later executor phase starts.

<!-- anchor: component-provider-contracts -->
### Provider contract composition

`tests/fs/contracts/caching-remote-fs.contract.ts` and the central registry own `contract-provider-replay`. The same contract is registered for `GoogleDriveFs`, `DropboxFs`, and `OneDriveFs`. A paginated failure may leave any prefix of the derived live view, including none. The design assumes no provider-specific page-application timing; it requires whole-view invalidation and replay from the durable cursor.

## State and authority model

| State | Owner | Advancement | Incomplete-attempt rule |
|---|---|---|---|
| Durable cursor + complete cache + scope | `MetadataStore` through `CachingRemoteFs` | atomic `commitCheckpoint` after a wholly clean cycle | unchanged |
| Per-file `SyncRecord` | `SyncStateStore` through the existing committer | after that file's admitted I/O and proof | successful records remain valid |
| Live cursor/cache/scope/initialized | existing `CachingRemoteFs` fields | acquisition and admitted remote work | cleared by `abortWorkingView` |
| Tracker/priority/pool bookkeeping | existing cycle collaborators | current events and bounded scheduling | existing lifecycle only; never recovery authority |

Abort is not rollback of provider effects or per-file records. It only invalidates a derived remote view. Ordinary re-observation combines successful records with current endpoint facts, rediscovering incomplete work from the prior durable cursor.

The API boundary is:

```ts
interface IncrementalCheckpoint {
  getChangedPaths(): Promise<RemoteDelta | null>;
  listCurrentSnapshot?(): Promise<FileEntity[]>;
  hasCheckpoint(): Promise<boolean>;
  resetCheckpoint(): Promise<void>;
  commitCheckpoint(context?: { scopeFingerprint?: string }): Promise<void>;
  abortWorkingView(): Promise<void>;
  getScopeFingerprint?(): Promise<string | null>;
}
```

## Exact lifecycle table

| Attempt observation/outcome | Required checkpoint closeout | What happens next |
|---|---|---|
| All authorized actions terminal, fresh proofs present, no failure/block, not `checkpointBlocked` | commit only | continue from new durable checkpoint |
| Admission rejection or missing authorization/terminal proof | abort only | prior durable checkpoint + current facts |
| Returned failed or blocked execution | abort only | existing retry/return policy after abort |
| Priority-only `checkpointBlocked` or detached invalidation | abort only | requested normal lifecycle re-observes durable facts |
| Observation, preparation, Admission, or execution throws | abort before propagation/classification | existing retry/terminal policy |
| `AuthError` or `InternalFreshInvariantError` from an action | scheduled siblings settle; batch is `aborting`; then abort before propagation | same selected rejection object reaches existing policy |
| `commitCheckpoint` rejects | abort before propagation | prior durable checkpoint remains authoritative |
| Fresh/full scan rejects before a checkpoint exists | abort live view; durable getters remain `false`/`null` | ordinary COLD retry |
| First scan succeeds live but cycle is incomplete | abort live view; no durable checkpoint appears | ordinary COLD retry |
| `readBackendState`/`saveSettings` rejects after closeout | no second operation | preserve already committed/aborted result |
| No checkpoint capability | neither commit nor abort | existing list/stat/record behavior |
| Abort invariant itself rejects | propagate abort failure; do not classify as completed retry | fail closed with boundary unclosed |
| Process crash before commit | no callable abort; durable state unchanged | new object reconstructs from durable state |
| Explicit Rescan/identity reset | `resetCheckpoint` | destructive durable + live reset by existing policy |

For a returned cycle, commit-or-abort is exhaustive. For a process crash, durability—not an in-process finalizer—provides the boundary.

## Executor rejection preservation

At each existing parallel boundary:

```text
selector = Promise.all(alreadyScheduled)
try await selector
catch selected:
  await Promise.allSettled(alreadyScheduled)
  throw selected
```

The real implementation must attach settlement observation so no secondary unhandled rejection is introduced, while retaining the exact object that the pre-change `Promise.all` would expose. It must not scan settled reasons, prioritize `AuthError`, or choose by input order. The same rule applies at every nested parallel join. Serial phases retain their existing stop behavior.

## Temperature and retry behavior

- COLD without a durable checkpoint: a live fresh scan never makes `hasCheckpoint` true; abort clears it and the next attempt performs the ordinary fresh scan.
- COLD with a durable checkpoint/full join: abort removes the attempted live join; the durable projection and current facts are joined again.
- WARM: abort causes the next delta acquisition to resume from the durable cursor, so uncommitted additions, deletions, and renames reappear.
- HOT: incomplete cycles do not acknowledge the relevant tracker facts; after abort they are joined with replayed remote facts.

An in-call retry keeps the existing captured `forceFullScan`; later cycles recompute their ordinary mode. Durable getter read failure returns `false`/`null` and therefore selects ordinary COLD. Neither branch records the preceding failure.

## Priority, checkpoint, and closeout ordering

The existing priority finalizer lease remains the serialization boundary. The checkpoint commit-or-abort operation finishes while the lease is held. Backend-state extraction and settings persistence follow that closeout but remain in their current ordering. This preserves `checkpointBlocked`, tracker acknowledgment, retry/backoff, notifications, and priority scheduling without adding a lifecycle field.

<!-- anchor: contract-working-view-lifecycle -->
## Contract: working-view lifecycle

Abort is required, live-only, mutex-serialized, idempotent, and performs no store/provider mutation. Reset remains durable and explicit. Durable getters never expose live candidates; absence or read failure returns `false`/`null`. Commit publishes scope/cache/cursor only after atomic persistence succeeds. Abort failure propagates and is never accepted as a completed retry boundary.

<!-- anchor: contract-cycle-closeout -->
## Contract: cycle closeout

Every returned checkpoint-capable attempt invokes exactly one terminal choice. Pre-closeout exceptions abort before existing error handling; commit failure aborts; post-closeout settings errors do not repeat closeout. Capability absence is a valid no-operation branch.

<!-- anchor: contract-fatal-settlement -->
## Contract: fatal settlement

`AuthError` and `InternalFreshInvariantError` are the complete current cycle-fatal set. Each enters `aborting`; all promises scheduled in its current join settle; queued work performs no provider I/O; later phases do not start; the exact original aggregate-selected rejection is rethrown unchanged.

<!-- anchor: contract-temperature-convergence -->
## Contract: temperature convergence

COLD, WARM, and HOT use only durable/current inputs. A stateful test must demonstrate a live view that is blind before abort, replays afterward, and reaches the same endpoint bytes and `SyncRecord`s without any prior-error state.

<!-- anchor: contract-provider-replay -->
## Contract: provider replay

The shared caching contract runs through all three central registrations. It permits any live prefix after paginated failure and observes only that abort invalidates the whole working view, the same instance resumes from durable state, fresh scans remain uncommitted until commit, and rename/subtree snapshots replay correctly.

<!-- anchor: adr-remote-working-view-abort-boundary -->
## ADR 0001 revision: attempt-bounded working views

Revise `docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md` in place. Its accepted decision remains: complete remote metadata/cursor/scope commit atomically and last; per-file records commit only after their admitted I/O succeeds; the metadata cache is not an independent authority. The revision replaces load-bearing same-session `recoverViaColdScan` recovery with an explicit attempt-bounded working-view lifecycle owned by `IncrementalCheckpoint`.

The chosen explicit API is the smallest coherent boundary because the checkpoint owner already owns the live fields, mutex, durable store, commit, and reset. No new ADR is created because no new durable-state authority or competing architectural decision is introduced.

## Dependency order and verification

1. Add the checkpoint API/owner semantics and stateful shared contract.
2. Establish executor settlement and fatal-class invalidation.
3. Integrate exhaustive orchestrator/finalizer closeout and remove recovery state.
4. Revise ADR 0001/docs/guard fixtures and run focused tests, then the repository gate.

The authoritative adversarial matrix is in `verification.md`; file-level task boundaries and acceptance are in `implementation.md`. There are no open product questions.
