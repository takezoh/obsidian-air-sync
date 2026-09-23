---
id: change-20260922-backend-layer-namespace-reconciliation
kind: change
title: Resolve provider namespace collisions in the remote filesystem boundary
status: active
created: '2026-09-22'
profile: sdd@1
intent: >-
  A filesystem holds one object per path, so the remote filesystem — the backend layer in
  front of the sync engine — owns the path↔identity bijection. When the provider namespace
  holds two live objects at one derived address, the remote filesystem renames one of them
  on the backend and the sync cycle is retried; the sync engine never observes a collision.
outcomes:
- The sync engine consumes only a 1:1 remote view. No collision, displacement or withheld
  claimant crosses the IFileSystem boundary as an engine-level fact.
- On a provider-resolved collision the remote filesystem renames the non-keeper on the
  backend by its stable identity, aborts its working view, and signals a retry; the next
  cycle re-observes the settled provider facts and converges.
- The contention Admission stage, the Admission-owned checkpoint block, and the contended
  user signal are removed. A repair the backend refuses is an ordinary cycle failure that
  keeps the remote cursor uncommitted, without any collision concept in the engine.
- >-
  The no-loss invariant of change-20260916-cache-path-id-bijection is preserved — every
  object that existed before a collision still exists and is reachable after it.
scope:
- src/backends/googledrive/adapter.ts
- src/fs/interface.ts
- src/fs/caching/remote-fs.ts
- src/fs/caching/remote-fs.contract.test.ts
- src/fs/caching/metadata-cache.ts
- src/fs/caching/metadata-cache.test.ts
- src/fs/caching/id-delta.ts
- src/fs/caching/id-delta.test.ts
- src/fs/caching/namespace-reconciliation.ts
- src/fs/caching/namespace-reconciliation.test.ts
- src/fs/managed/managed-remote-fs.ts
- src/sync/plan-admission-address-contention.ts
- src/sync/plan-admission-address-contention.test.ts
- src/sync/plan-admission.ts
- src/sync/plan-admission.test.ts
- src/sync/identity-component-decision.ts
- src/sync/moved-baseline-publication.test.ts
- src/sync/orchestrator.ts
- src/sync/orchestrator.test.ts
- src/sync/state.ts
- src/sync/state.test.ts
- src/__mocks__/sync-test-helpers.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/sync-cycle-finalization.test.ts
- src/sync/sync-cycle-planning.ts
- src/sync/sync-notification.ts
- src/sync/sync-notification.test.ts
- src/sync/plan-executor.ts
- src/sync/plan-executor.test.ts
- src/sync/priority-batch-state.ts
- src/sync/priority-batch-state.test.ts
- src/sync/types.ts
- src/sync/change-detector.ts
- src/sync/remote-change-source.ts
- src/sync/conflict.ts
- src/utils/path.ts
- tests/fs/contracts/caching-remote-fs.contract.ts
- tests/fs/googledrive/managed.contract-harness.ts
- tests/fs/managed/faithful-collision-adapter.ts
- tests/fs/managed/reconcile-namespace.test.ts
- tests/fs/managed/orchestrator-namespace.test.ts
- e2e/googledrive.e2e.ts
- eslint.config.mts
- AGENTS.md
- ARCHITECTURE.md
- docs/design/design-four-stage-sync-pipeline.md
- docs/adr/adr-20260922-backend-layer-namespace-reconciliation.md
non_goals:
- No persistent collision record, chosen-address table, repair queue, recovery marker, new
  store, or new AbstractMetadataCache instance field.
- No new SyncActionType, DAG, or recovery queue.
- No IndexedDB schema change or METADATA_CACHE_VERSION bump.
- No Dropbox or OneDrive production change. The reconciliation capability is optional, in
  the same shape as checkpoint, and only Google Drive implements it.
- No consent prompt, setting, or opt-out for the provider rename; the owner has accepted
  the rename remedy.
change_classes:
- responsibility
- boundary
- invariant
- behavior
- internal_design
governance:
  gate: hard
  reasons:
  - The remote filesystem performs a provider mutation (a rename) from the backend layer
    rather than from an admitted sync action, which changes the mutation-authority boundary
    recorded in AGENTS.md and NFR-ADDR-004 of change-20260916-cache-path-id-bijection.
  - It removes the contention Admission stage and the Admission-owned checkpoint block,
    both governed by the four-stage sync pipeline and the commit-last boundary (ADR 0001).
  approval_evidence: >-
    The repository owner directed this boundary explicitly and repeatedly: the backend layer
    in front of the sync engine performs the backend rename, and sync is retried to converge.
    No-loss remains the binding invariant. The owner then asked for the remaining work to be
    completed, accepting the boundary and its recorded mutation-authority change (ADR
    adr-20260922-backend-layer-namespace-reconciliation).
members:
- role: requirements
  path: changes/change-20260922-backend-layer-namespace-reconciliation/requirements.md
  required: true
- role: implementation
  path: changes/change-20260922-backend-layer-namespace-reconciliation/implementation.md
  required: true
- role: verification
  path: changes/change-20260922-backend-layer-namespace-reconciliation/verification.md
  required: true
promotion:
- target: design-four-stage-sync-pipeline
  section: responsibilities
  action: upsert
  item:
    id: RESP-005
    statement: >-
      The remote filesystem owns the path↔identity bijection and provider namespace
      reconciliation. It alone detects that two provider-resolved objects claim one derived
      address, decides placement, renames the non-keeper on the backend through the
      identity-addressed rename capability, and reports whether its working view may be
      committed. The sync engine consumes only a 1:1 remote view and re-runs the cycle when
      the filesystem reports that it reconciled the namespace; no collision, displacement or
      withheld claimant is an engine-level fact, and the keeper policy from committed
      SyncRecords is supplied to the filesystem per call, never read by it.
  reason: >-
    The collision machinery leaking into Admission produced a checkpoint-blocked follow-up
    whose retry could not be made to converge. This fixes the owner of the bijection and the
    remediation at the backend boundary, so a fourth local rule cannot be added and the
    engine never interprets a provider namespace limit.
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-017
    statement: >-
      Every remote view the sync engine consumes is 1 path = 1 object and contains every
      live object at some path; an object is never withheld from the engine's view while a
      collision is unresolved. A remote filesystem that cannot present a 1:1 view repairs
      the provider namespace in the backend layer and the cycle is retried; until the repair
      lands the cursor is not committed, and no object is destroyed, emptied or made
      permanently unreachable to free an address. Where the filesystem lacks the repair
      capability, no collision is created by it and nothing is done to the provider.
    enforcement: contract
  reason: >-
    This is the cross-cutting invariant this change exists to establish and it supersedes the
    placement decision of adr-upstream-rename-remedy (the remedy and no-loss invariant stay).
promotion_applied_at: '2026-09-22T00:00:00Z'
unresolved_decisions:
- 'reconciliation-read-cost — reconciliation re-observes provider facts after a rename; how
  many extra provider reads a contended cycle costs (one delta replay, one full scan) is
  unmeasured. Settle by an instrumented e2e.'
tags:
- metadata-cache
- deletion-safety
- cross-backend
- sync-boundary
owners: []
relations:
- type: modifies
  target: change-20260916-cache-path-id-bijection
- type: conformsTo
  target: design-four-stage-sync-pipeline
- type: conformsTo
  target: design-core-backend-integration
source_paths:
- src/backends/googledrive/adapter.ts
- src/fs/interface.ts
- src/fs/caching/remote-fs.ts
- src/fs/caching/metadata-cache.ts
- src/fs/caching/id-delta.ts
- src/fs/caching/namespace-reconciliation.ts
- src/fs/managed/managed-remote-fs.ts
- src/sync/plan-admission-address-contention.ts
- src/sync/plan-admission.ts
- src/sync/identity-component-decision.ts
- src/sync/moved-baseline-publication.test.ts
- src/sync/orchestrator.ts
- src/sync/state.ts
- src/sync/state.test.ts
- src/__mocks__/sync-test-helpers.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/sync-cycle-planning.ts
- src/sync/sync-notification.ts
- src/sync/plan-executor.ts
- src/sync/change-detector.ts
- src/sync/remote-change-source.ts
- src/sync/conflict.ts
- src/sync/types.ts
- src/utils/path.ts
summary: path↔stable-id の全単射と provider namespace 衝突の解決を remote FS（backend
  層）が所有し、engine は 1:1 view だけを消費して再試行で収束する。Admission の contention
  stage を撤去。
updated: '2026-09-22'
---

## Summary

`AbstractMetadataCache` already assigns derived addresses (change-20260916). What that change
left in the wrong place is the **consequence** of a collision: it is published as
`RemoteDelta.contended`, decided in an Admission stage (`plan-admission-address-contention.ts`),
and turned into an Admission-owned checkpoint block that closes the cycle as `follow_up`.

That split is what the observed failure comes from. A cycle that aborts on `follow_up` re-runs
from the committed pre-repair view; when the re-observation re-derives a contention whose
withheld claimant the repair already relocated, the cycle re-plans the same rename, the repair
fails its admitted-path precondition, and the cycle never converges. On a backend whose identity
rename has no precondition the same shape loops forever at status `syncing`. Either way the sync
engine is interpreting a provider namespace limit it does not own.

This change gives the bijection and the namespace repair to the remote filesystem, the backend
layer directly in front of the engine.

- **The remote filesystem owns the 1:1 view.** Its public result — `list`, `stat`, `read`,
  `getChangedPaths` — never yields two objects at one path and never withholds a live object.
  Detection and accounting (the arbiter, the drain settlement, the deletion subtraction) stay
  inside the filesystem exactly as today; only the *publication* to the engine changes.
- **The remote filesystem repairs the namespace.** At the cycle boundary it reconciles: for a
  provider-resolved contention where it holds the identity-addressed rename capability, it
  renames the non-keeper to the deterministic conflict address on the backend, updates its
  derived cache from the provider's answer, aborts its working view, and reports `changed`. The
  keeper policy — the object holding a committed `SyncRecord` — is supplied by the engine per
  call, so the filesystem stays stateless and the user's established file keeps its name.
- **The engine retries to converge.** A `changed` reconciliation queues the cycle exactly as a
  follow-up is queued today; the next cycle re-observes provider-true facts and is clean. No
  upfront-collision concept reaches Admission: the existing `checkpointBlocked` / `awaiting_repair`
  / `present_unresolved` / `withheldAddresses` machinery and the contended user signal are removed.

Nothing new is persisted. The rename is a mechanism of the filesystem, not an admitted sync
action; a provider that refuses it makes the cycle non-clean and it is retried, with no recovery
state and no collision record. The no-loss invariant of change-20260916 is unchanged: both
objects survive at distinct addresses, and the repair target uses the established
`insertConflictSuffix(path, "id-" + <stable id>)` convention.

## Why this supersedes the previous placement

`adr-upstream-rename-remedy` decided the *remedy* (rename the non-keeper on the provider) and the
owner has not changed that decision. It placed the *execution* in the sync engine as an admitted
action plus an Admission checkpoint block. The observed stall is a property of that placement, not
of the remedy. This change keeps the remedy and the no-loss invariant and moves the ownership of
the bijection, the detection, the repair, and the commit-eligibility decision into the remote
filesystem, which is the only layer that holds both the provider facts and the derived address.

## Implementation Notes

Landed on branch `feat/backend-module-static-built-ins`; gate green (`lint`, `lint:bot-repro`,
`build`, `test:coverage`).

Done:
- `IFileSystem.namespaceReconciliation` (optional) implemented by `ManagedRemoteFs`; the filesystem
  accumulates the working view's contentions and `reconcileNamespace(policy)` renames the
  non-keeper on the backend through `identityRename`, returning `settled`/`changed`/`failed`.
- The orchestrator calls it after change collection, supplying the keeper policy (committed
  SyncRecords) and the scope filter per call. `changed` closes the cycle as a follow-up (abort +
  retry) with no admission and no execution; the next cycle re-observes settled facts. `failed`
  rethrows the provider's own error so it runs the attempt's classification, backoff and
  `MAX_RETRIES` instead of looping.
- The Admission contention stage is gone: `plan-admission-address-contention.ts` deleted,
  `AdmissionResult.checkpointBlocked` and the `withheldAddresses` input to
  `decideIdentityComponent` removed, and `remote-change-source` / `change-detector` no longer
  forward a contention to the sync engine.
- `insertConflictSuffix` moved to `src/utils/path.ts` and re-exported from `src/sync/conflict.ts`.

Also done:
- `RemoteDelta.contended` and `IncrementalCheckpoint.drainWorkingViewContentions` are gone from the
  `IFileSystem` contract; `getChangedPaths` returns a 1:1 path view. The concrete caching
  filesystem keeps its working-view drain (`takeWorkingViewContentions`), reached only by
  namespace reconciliation and by the shared caching contract's unit-level driver.
- The dead executor path is deleted: `plan-executor`'s provider-identity rename branch,
  `RenameAction.providerIdentity`, and `AdmissionFailureReason.awaiting_repair` / `awaitsRepair`.
- The shared caching contract and the live Google Drive e2e were adapted: collision facts are read
  through the concrete filesystem's drain, and the repair is driven by
  `namespaceReconciliation.reconcileNamespace`.

Review fixes:
- A permanently refused rename is no longer an empty-plan follow-up: `failed` rethrows the provider
  error through the error policy, so a refusal surfaces as an error rather than endless `syncing`.
- The keeper is matched by stable identity (the claimant whose id matches a committed `SyncRecord`),
  which is what FR-RECON-003 now states.
- Reconciliation issues at most one rename per contended address per cycle; three or more claimants
  settle over cycles (NFR-RECON-003, AC-RECON-009).
- Reconciliation now runs before change collection and builds the working view itself, so the engine
  never consumes an incomplete view; `settled` carries the delta it built and collection reuses it.
- An evicted claimant's metadata is handed back from the seat, so the drain re-seats a keeper the
  cache evicted when the arriving claimant later vacates the address; the record-holder keeper path
  converges and is tested.
- Repairability is decided per contended address over the whole claimant set: an address with any
  non-repairable claimant is not mutated at all.
- The implicit `list()` cursor replay happens at most once per working view, so a COLD cycle
  consumes the same view reconciliation settled instead of replaying behind it and seating a
  late-arriving collision.
- A reconciled cycle moves priority to the abort state before the preparation permit is released,
  so a queued file-open pull defers instead of publishing an independent write.
- The diagnostic parent fetch on a refused identity rename is removed: the only permitted provider
  read is the single re-observation of the object itself (NFR-RECON-003).
- A reconciled cycle bypasses the executor entirely (it returns an empty execution), and
  `PriorityBatchState.abort()` is terminal, so the executor's opening `transfer` phase report can
  no longer re-open priority while the cycle is still aborting.
- `ARCHITECTURE.md` is updated to the new boundary (no returned displacement, no SyncAction
  namespace repair, no public `RemoteDelta.contended`; `namespaceReconciliation` is the capability).
- The identity-rename admitted-path precondition is checked from the re-observed object against the
  working view's projection of its name and its immediate parent's cached path, not by walking the
  provider parent chain, so a nested path costs one read, not one per ancestor (NFR-RECON-003); a
  nested collision test pins the single `getById`.
- The shared caching contract now drives the PUBLIC `namespaceReconciliation.reconcileNamespace`
  for a staged collision: it requires the capability on a family that can produce the shape, asserts
  `changed`, discards and re-reads the working view, and checks keeper placement, the survival of
  both objects at distinct addresses, the keeper-policy flip, and an out-of-scope address left
  unmutated. It no longer reaches for the internal `identityRename` (unit-6, AC-RECON-001/002/005/008).

Follow-on fixes (the same boundary, after the repair's non-committing cycle):
- The keeper decision handed to the filesystem is now resolved from the record at the
  contended address (`SyncOrchestrator.namespaceKeeper(path, claimantIds)`), not from
  which claimants hold a record anywhere. When both claimants were already synced, the
  old form was undefined and the arbiter winner took the plain address; the record
  holder at the path is what FR-RECON-003 names. The then-unused `recordedIdentities`
  store API is removed.
- The engine's identity→committed-row join survives a relation the report family
  abandons: a stored row whose provider identity is observed at another address is
  re-seated on that endpoint (the relocated-match fallback), its old address is decided
  vacant, and the carrying action publishes before the vacated one. Without this a
  WARM/HOT cycle decided the moved endpoint unbaselined and the identity-keyed store
  refused the publication — the `SyncRecord changed before terminal publication` loop
  the repair leaves behind.
- `tests/fs/managed/orchestrator-namespace.test.ts` drives the real `ManagedRemoteFs`
  through the real `SyncOrchestrator.runSync()`: the collision is seeded with no prior
  `getChangedPaths()`, so a reconcile that lost its self-built working view fails the
  test.
- A remote folder rename onto an address an existing folder already occupies leaves the
  renamed folder's local counterpart at the old path. Admission now carries that local
  file to the identity's settled address (its own remote rename report names the old
  path), instead of deciding it unbaselined and pushing the old address back onto the
  provider — which recreated `Untitled/a.md` and duplicated the content.
- The repair receipt is verified to leave the derived cache at the provider's own
  post-rename version: `tests/fs/googledrive/managed.contract-harness.ts` deletes a
  reconciled object with no re-observation between the repair and the delete, and a
  separate case pins that a provider write past the observed version fails the delete
  closed rather than deleting an unobserved latest version.
- `tests/fs/managed/orchestrator-namespace.test.ts` adds the COLD/no-checkpoint path
  (AC-RECON-002 parity): the collision exists on the provider before any listing, so a
  reconcile that only worked off a delta would never see it; the test drives the real
  `runSync`, keeper, rename, abort/retry and both surviving objects.

Test coverage:
- `tests/fs/managed/reconcile-namespace.test.ts` drives the production
  `ManagedRemoteFs.namespaceReconciliation` over a collision-capable faithful adapter: the
  non-keeper is renamed by identity, the keeper policy flips which object moves, an out-of-scope
  address is untouched, three claimants cost one rename per cycle and settle over cycles, a refused
  rename reports `failed`, and the view settles after the reconciled working view is discarded and
  re-read.
- The shared caching contract's collision cases and the live Google Drive e2e were adapted to the
  new boundary, driving the repair rather than draining the facts first.
