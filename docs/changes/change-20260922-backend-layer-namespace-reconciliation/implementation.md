---
change: change-20260922-backend-layer-namespace-reconciliation
role: implementation
contracts:
- contract-remote-1to1-view
- contract-namespace-reconciliation
- contract-retry-convergence
- contract-engine-contention-removed
contract_projections:
- id: contract-remote-1to1-view
  verifications:
  - verify-public-delta-has-no-contention
  - verify-deletion-attribution-internal
  discretion: []
- id: contract-namespace-reconciliation
  verifications:
  - verify-rename-non-keeper-by-identity
  - verify-keeper-policy-per-call
  - verify-capability-absent-no-mutation
  discretion:
  - discretion-keeper-policy-spelling
- id: contract-retry-convergence
  verifications:
  - verify-reconciled-cycle-not-committed
  - verify-next-cycle-settled
  - verify-refused-rename-nonclean-retried
  discretion: []
- id: contract-engine-contention-removed
  verifications:
  - verify-no-admission-contention-stage
  - verify-guards-green-no-fixture-edits
  discretion: []
adrs:
- adr-backend-layer-namespace-reconciliation
decision_dispositions:
- decision_input_ref: decision-input-remedy-placement
  disposition: >-
    Adopted. The remedy (rename the non-keeper on the provider) is unchanged from
    change-20260916; its placement moves from an admitted sync action plus an Admission
    checkpoint block into the remote filesystem, which then asks the engine to retry.
    The engine never observes the collision.
  adr_refs: [adr-backend-layer-namespace-reconciliation]
  contract_refs: [contract-namespace-reconciliation, contract-retry-convergence]
- decision_input_ref: decision-input-keeper-policy-owner
  disposition: >-
    Adopted as a per-call input. The committed SyncRecord is the keeper tie-break and lives
    in the sync engine, so the filesystem receives the decision as a function argument and
    stores nothing. Exact spelling left discretionary.
  adr_refs: [adr-backend-layer-namespace-reconciliation]
  contract_refs: [contract-namespace-reconciliation]
- decision_input_ref: decision-input-mutation-authority
  disposition: >-
    Adopted with a raised boundary cost. The filesystem now performs one backend rename from
    the backend layer. This overturns NFR-ADDR-004 of change-20260916 and the
    execution-phase-only mutation wording in AGENTS.md; the owner directed it and the design
    records the update as part of implementation.
  adr_refs: [adr-backend-layer-namespace-reconciliation]
  contract_refs: [contract-namespace-reconciliation]
milestones:
- id: fs-reconciliation-contract
- id: move-repair-into-fs
- id: remove-engine-contention
- id: retry-from-fs-status
- id: remove-public-contention-carriers
- id: conformance
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Contracts

### contract-remote-1to1-view

Owner: `src/fs/caching/remote-fs.ts` (with `src/fs/interface.ts`).

The public filesystem result carries only `changedPaths`, `renamedPaths` and `deleted`. Contention
and displacement accounting stay inside the filesystem: the arbiter, the drain settlement and the
`displacedAddresses` subtraction are unchanged, but their facts are not fields of `RemoteDelta`.

Partition: every changed path is classified modified, renamed or deleted at exactly one of the
existing producers; a path absent because a contention is being resolved is excluded from `deleted`
inside the filesystem, while a genuine deletion and an out-of-root move still reach `deleted`.

### contract-namespace-reconciliation

Owner: `src/fs/caching/remote-fs.ts` + `src/fs/managed/managed-remote-fs.ts`.

`reconcileNamespace(policy)` runs under the cache mutex at the cycle boundary. For each
provider-resolved contention it computes the keeper (`policy(path, ids)` else the arbiter's admitted
claimant), renames the other on the backend to
`insertConflictSuffix(path, "id-" + <stable id>)` through the identity-addressed rename capability,
and applies the provider's answer to the derived cache. It returns `settled`, `changed` or `failed`.

Partition: a `requested_echo` claim is never renamed; a filesystem without the capability performs
no mutation and returns `settled`; an identity re-observation that no longer matches the admitted
path is a `failed` reconciliation, never a wrong-object rename.

### contract-retry-convergence

Owner: `src/sync/orchestrator.ts` + `src/sync/sync-cycle-finalization.ts`.

A `changed` reconciliation aborts the working view and queues a retry; the next cycle re-observes
the settled provider facts and is clean. A `failed` reconciliation leaves the cycle non-clean with
the cursor uncommitted and retried under the existing error policy. No new completion kind is added:
the retry producer changes from `AdmissionResult.checkpointBlocked` to the filesystem's
reconciliation status.

### contract-engine-contention-removed

Owner: `src/sync/plan-admission*.ts`, `src/sync/identity-component-decision.ts`,
`src/sync/remote-change-source.ts`, `src/sync/change-detector.ts`,
`src/sync/sync-notification.ts`, `src/main.ts`, `src/sync/plan-executor.ts`.

The contended fact, the Admission contention stage, the `withheldAddresses` input, the Admission
checkpoint block and the contended user signal are removed. A collision never surfaces as an
Admission failure.

## Units

### unit-1 — filesystem reconciliation contract
Files: `src/fs/interface.ts`, `src/fs/caching/remote-fs.ts`, `src/fs/caching/remote-fs.contract.test.ts`.
Acceptance: the interface declares the policy and result; `RemoteDelta` no longer carries
`contended`/`withheld`/`displacements`; the deletion subtraction is internal; existing deletion and
cursor-expiry contract cases keep passing.

### unit-2 — move the repair mechanism into the filesystem
Files: `src/fs/caching/id-delta.ts`, `src/fs/managed/managed-remote-fs.ts`, `src/fs/caching/id-delta.test.ts`.
Acceptance: the drain keeps detecting and accounting contentions exactly as today; the identity
rename is invoked from the filesystem's reconciliation, not from the executor; a successful rename
updates the derived cache from the provider endpoint; the stale-contention withdrawal of the prior
fix remains as an internal invariant.

### unit-3 — remove the engine contention stage
Files: `src/sync/plan-admission-address-contention.ts` (deleted), `src/sync/plan-admission.ts`,
`src/sync/identity-component-decision.ts`, `src/sync/priority-batch-state.ts`, tests.
Acceptance: `admitBatchObservation` has no contention input; `decideIdentityComponent` has no
`withheldAddresses`; `AdmissionResult.checkpointBlocked` and `PriorityBatchState.blockCheckpoint`
contention wiring are gone; no `awaiting_repair`/`present_unresolved` reason remains.

### unit-4 — retry from the filesystem status
Files: `src/sync/orchestrator.ts`, `src/sync/sync-cycle-finalization.ts`, tests.
Acceptance: the orchestrator calls `reconcileNamespace` at the cycle boundary with the keeper policy
from `SyncStateStore`; `changed` queues a retry; `failed` is a non-clean cycle; `completionOf` no
longer reads a checkpoint block.

### unit-5 — remove public contention carriers and the user signal
Files: `src/sync/remote-change-source.ts`, `src/sync/change-detector.ts`,
`src/sync/sync-notification.ts`, `src/main.ts`, tests.
Acceptance: the `onRemoteContention` callback and threading are gone; the notification and status
bar carry no contended clause; a contended cycle is not reported as an error.

### unit-6 — conformance
Files: `tests/fs/contracts/caching-remote-fs.contract.ts`,
`tests/fs/remote-backend-contracts.test.ts`, per-family harnesses.
Acceptance: the shared contract pins two ids at one path and the survival of both objects after
reconciliation for every family that can produce the shape, with a cited non-producibility otherwise;
the composition root still fails to compile on a missing cell; no family receives a production-only
capability hook through the backend-agnostic base.
