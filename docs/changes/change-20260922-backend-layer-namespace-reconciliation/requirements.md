---
change: change-20260922-backend-layer-namespace-reconciliation
role: requirements
functional_requirements:
- id: FR-RECON-001
  statement: >-
    THE remote filesystem SHALL present a public view — list, listDir, stat, read and
    getChangedPaths — in which each path holds at most one object, each live object appears
    at exactly one path, and no collision, displacement or withheld-claimant fact is part of
    the public result.
  priority: must
  type: invariant
- id: FR-RECON-002
  statement: >-
    WHEN two or more provider-resolved claims contend for one derived cache address and the
    remote filesystem provides the identity-addressed rename capability, THE remote
    filesystem SHALL rename the non-keeper on the backend to the address produced by the
    existing conflict-suffix convention with a discriminator derived from that claimant's own
    stable id, as a mechanism of the filesystem rather than an admitted sync action.
  priority: must
  type: functional
- id: FR-RECON-003
  statement: >-
    THE remote filesystem SHALL determine which claimant keeps the plain address from a
    per-call keeper policy supplied by the sync engine — the claimant whose stable id matches
    a committed SyncRecord (the object the user has been syncing, wherever it now sits), else
    the address arbiter's admitted claimant — and the filesystem SHALL NOT read, store or
    retain sync state, whose absence makes the arbiter its only default.
  priority: must
  type: functional
- id: FR-RECON-004
  statement: >-
    WHEN the remote filesystem has changed the provider namespace while reconciling a
    contention, THAT cycle SHALL NOT commit its remote cursor or derived cache, SHALL abort
    its working view, and SHALL report that the cycle is to be retried; the next cycle SHALL
    re-observe the settled provider facts.
  priority: must
  type: invariant
- id: FR-RECON-005
  statement: >-
    EVERY object that existed on the provider before a contention was observed SHALL still
    exist on the provider afterwards and SHALL be reachable in the vault once synced, unless
    the user deleted it; NO object SHALL be deleted, emptied, truncated or made permanently
    unreachable in order to free a cache address, on any route, including every failure path
    of the reconciliation.
  priority: must
  type: invariant
- id: FR-RECON-006
  statement: >-
    WHEN the backend refuses or fails the identity-addressed rename, THE remote filesystem
    SHALL report the reconciliation as failed, the cycle SHALL remain non-clean with its
    cursor uncommitted, and the cycle SHALL be retried; NO collision record, disposition,
    repair queue or recovery marker SHALL be persisted, and the collision SHALL NOT become an
    Admission failure.
  priority: must
  type: functional
- id: FR-RECON-007
  statement: >-
    WHERE the remote filesystem does not provide the identity-addressed rename capability, NO
    provider mutation SHALL be attempted, no collision SHALL be introduced by the filesystem,
    and the cycle SHALL NOT be blocked by a condition no cycle could clear.
  priority: must
  type: functional
- id: FR-RECON-008
  statement: >-
    THE sync engine SHALL consume only the 1:1 view; the contention Admission stage, the
    Admission-owned checkpoint block, the withheld-address input to identity decision, and the
    contended user signal SHALL be removed, and a contention SHALL never surface as an
    Admission failure or as a distinct cycle-completion kind.
  priority: must
  type: functional
- id: FR-RECON-009
  statement: >-
    THE remote filesystem SHALL continue to exclude from its published deleted set any path
    whose absence is attributable to a contention it is resolving, computed inside the
    filesystem, while a path the provider really removed and a path whose parent left the
    tracked root SHALL still be reported deleted.
  priority: must
  type: invariant
- id: NFR-RECON-001
  statement: >-
    THIS change SHALL NOT persist a collision record, chosen-address table, disposition,
    failure reason, repair queue or recovery marker; SHALL NOT add a persistent store or a
    retained in-memory correctness owner; SHALL NOT add an instance field to
    AbstractMetadataCache; SHALL NOT bump METADATA_CACHE_VERSION or change the FileRecord
    shape; SHALL NOT add a SyncActionType, a DAG or a recovery queue; and SHALL leave
    sync-state-ownership-guard.test.mjs and sync-admission-authority-guard.test.mjs green with
    no fixture edits.
  priority: must
  type: non_functional
- id: NFR-RECON-002
  statement: >-
    THE backend-agnostic cache base SHALL contain no provider-specific branch, predicate or
    capability hook, and AbstractMetadataCache SHALL issue no provider request and hold no
    client or sync state; the identity-addressed rename SHALL remain an optional filesystem
    capability in the shape the codebase already uses for checkpoint, never a predicate on
    backend identity, and the keeper policy SHALL reach the filesystem as a per-call input,
    never as stored state.
  priority: must
  type: non_functional
- id: NFR-RECON-003
  statement: >-
    RESOLVING a contention SHALL cost at most one rename per contended address per cycle; a
    cycle that reconciled is not committed and is retried, so a contention among n claimants
    at one address converges in at most n-1 reconciliation cycles. No additional provider read
    is introduced beyond re-observing the renamed object, and uncontested paths SHALL continue
    to sync in every cycle that is not spent reconciling.
  priority: must
  type: non_functional
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Authority

- The repository owner directed this boundary: the backend layer in front of the sync engine
  performs the backend rename, and sync is retried to converge.
- It modifies `change-20260916-cache-path-id-bijection` by moving the *placement* of the
  upstream rename remedy; the remedy, the `insertConflictSuffix(path, "id-" + id)` target and
  the no-loss invariant (FR-RECON-005) are unchanged.
- It conforms to `design-four-stage-sync-pipeline` and `design-core-backend-integration`.

## The boundary in one sentence

The remote filesystem is the only layer that holds both the provider facts and the derived
address. It therefore owns the path↔identity bijection and the provider namespace repair; the
sync engine consumes a 1:1 view and only retries when the filesystem says it changed the
namespace.

## Why the previous placement failed

Change-20260916 published the collision as `RemoteDelta.contended`, decided a keeper in a new
Admission stage and made the cycle's checkpoint block an `AdmissionResult` field. The retry that
followed re-runs from the committed pre-repair view. When the re-observation re-derives a
contention whose withheld claimant the repair already relocated, the same rename is planned again,
the repair fails its admitted-path precondition, and the cycle cannot converge. On a backend whose
identity rename has no such precondition the same shape loops indefinitely at status `syncing`.
Both are the sync engine interpreting a provider namespace limit it does not own.

## FR-RECON-001 — the remote view is 1:1 (invariant)

The public filesystem result never carries a collision. Today the collision is a first-class
public fact (`RemoteDelta.contended`, `withheld`, `displacements`). After this change those
remain internal to `src/fs/caching/` — the arbiter, the drain settlement and the deletion
subtraction are unchanged — but they are not part of any result object the sync engine reads.

This is the invariant the owner states directly: the local destination cannot represent two
objects at one path, so the layer that fronts it must not offer such a view.

## FR-RECON-002 / FR-RECON-003 — repair in the backend layer, keeper supplied per call

On detecting a provider-resolved contention, the filesystem repairs the source: it renames the
non-keeper on the backend through the existing identity-addressed rename capability. The keeper
is the claimant holding a committed `SyncRecord` at the contended path; because the filesystem
must not read sync state, the engine supplies that decision per call (the exact spelling is the
`keeper-policy-input` unresolved decision). With no preferred identity the arbiter's admitted
claimant keeps the plain address.

The rename target stays `insertConflictSuffix(contendedPath, "id-" + <renamed claimant's stable
id>)`: a function of the unordered claim set, idempotent across retries, valid for folders, and
never mistakable for the 64-hex conflict-preservation form.

## FR-RECON-004 / FR-RECON-006 — convergence by retry, failure is ordinary

When the filesystem has renamed on the backend, the cycle's facts and cursor are not committed;
the working view is aborted and the cycle is queued again, exactly as the existing follow-up
queue works. The next cycle re-observes provider-true facts and is clean. A refused rename is a
normal non-clean outcome retried under the existing error policy — not a new completion kind and
not an Admission failure.

## FR-RECON-008 — what is removed

- `src/sync/plan-admission-address-contention.ts` and its dispositions.
- `AdmissionResult.checkpointBlocked` and the `sync-cycle-finalization` branch that reads it.
- The `withheldAddresses` input to `decideIdentityComponent` / `indexFacts`.
- `RemoteDelta.contended` / `withheld` / `displacements`, the `onRemoteContention` callback and
  its threading through `remote-change-source.ts` / `change-detector.ts`.
- The contended clause in `sync-notification.ts` and the status-bar clause in `main.ts`.
- The `plan-executor` identity-rename branch; the rename is no longer an admitted sync action.

## Acceptance criteria

| id | criterion | requirements |
|---|---|---|
| AC-RECON-001 | With a two-id one-path collision, the public `RemoteDelta` contains neither a contention nor a withheld-claimant fact, and both objects are reachable at distinct addresses through `list`/`stat`/`read` after reconciliation | FR-RECON-001, FR-RECON-005 |
| AC-RECON-002 | The non-keeper is renamed on the backend to `insertConflictSuffix(path, "id-" + id)`; the keeper named by the per-call policy is not moved; the choice is identical for both claim orders and for COLD, WARM and HOT | FR-RECON-002, FR-RECON-003 |
| AC-RECON-003 | A cycle that reconciled the namespace does not call `commitCheckpoint`, does call `abortWorkingView`, leaves the cursor at its previous value, and is followed by a cycle that observes the settled facts | FR-RECON-004 |
| AC-RECON-004 | A refused rename leaves the cursor uncommitted and the cycle is retried; no collision record, disposition, recovery marker or Admission failure exists | FR-RECON-006, FR-RECON-008 |
| AC-RECON-005 | A filesystem without the rename capability performs no provider mutation and produces no blocked cycle; a collision involving a `requested_echo` claim performs none | FR-RECON-007 |
| AC-RECON-006 | For the measured collision fixture `RemoteDelta.deleted` contains none of the displaced addresses; a genuine deletion and an out-of-root move still reach `deleted` | FR-RECON-009 |
| AC-RECON-007 | No collision record / persistent store / new cache field / new `SyncActionType` exists; both AST guards stay green with no fixture edits; `METADATA_CACHE_VERSION` is unchanged | NFR-RECON-001 |
| AC-RECON-008 | The cache base has no provider branch or client; the keeper policy reaches the filesystem only as a per-call input; a contended cycle costs at most one rename per address | NFR-RECON-002, NFR-RECON-003 |
| AC-RECON-009 | Three or more claimants at one address cost at most one backend rename per reconciliation cycle and settle over subsequent cycles, with no cycle performing two renames for one address | NFR-RECON-003 |

## Non-goals

- Changing Dropbox or OneDrive production behaviour.
- Any IndexedDB schema change, `METADATA_CACHE_VERSION` bump or migration code.
- A new `SyncActionType`, a DAG or a recovery queue.
- A consent prompt, setting or opt-out for the provider rename.
- A persistent collision record, repair queue, or retained in-memory correctness owner.
