---
id: adr-20260922-backend-layer-namespace-reconciliation
kind: adr
title: The remote filesystem owns path↔identity bijection and namespace reconciliation
status: accepted
created: '2026-09-22'
updated: '2026-09-22'
decision_makers:
- project owner
consulted:
- change-20260922-backend-layer-namespace-reconciliation
relations:
- {type: modifies, target: change-20260916-cache-path-id-bijection}
- {type: conformsTo, target: design-four-stage-sync-pipeline}
consequences:
  positive:
  - The sync engine consumes only a 1:1 remote view. Two live provider objects at one
    derived address are never an engine-level fact, so no Admission stage, checkpoint
    block or follow-up completion is spent interpreting a provider namespace limit.
  - The layer that holds both the provider facts and the derived address (the remote
    filesystem) owns the repair, so the collision is settled where it is observed and
    the cycle converges by one retry.
  - The keeper policy from committed SyncRecords and the scope filter reach the
    filesystem as per-call arguments, so a collision is repaired without the
    filesystem reading or storing sync state.
  negative:
  - The remote filesystem performs one backend rename (a mutation) from the backend
    layer, not from an admitted execution action. This overturns the
    execution-phase-mutation rule of change-20260916-cache-path-id-bijection; the
    mutation is a distinct filesystem operation, never a side effect of a read, and
    its failure is an ordinary non-clean cycle.
  - A backend that permanently refuses the rename stalls the cursor while the rest of
    the vault is retried; no recovery state is kept.
  neutral:
  - The rename remedy itself (rename the non-keeper on the provider to
    `insertConflictSuffix(path, "id-" + id)`) and the no-loss invariant are unchanged;
    only their placement moves.
---

# The remote filesystem owns path↔identity bijection and namespace reconciliation

## Context

A filesystem holds one object per path, so the destination cannot represent two live
objects at one derived address. Change-20260916 gave derived address assignment one
owner and chose to repair the provider namespace by renaming the non-keeper. It placed
the repair in the sync engine: the collision was published as `RemoteDelta.contended`,
decided by an Admission stage (`plan-admission-address-contention.ts`), and turned into
an `AdmissionResult.checkpointBlocked` that closed the cycle as `follow_up`.

That placement let the sync engine own a fact only the remote filesystem can act on. The
follow-up re-runs from the committed pre-repair view; when the re-observation re-derives
a contention whose withheld claimant the repair already relocated, the same rename is
planned again, the repair fails its admitted-path precondition, and the cycle does not
converge — an indefinite `syncing` on a backend whose rename has no precondition, a
terminal repeated failure on one that has it.

## Decision

The remote filesystem owns the path↔identity bijection and the provider namespace repair.
On a provider-resolved contention it renames the non-keeper on the backend through the
identity-addressed rename capability, updates its derived cache from the provider's
answer, aborts its working view, and reports that the cycle must be retried. The keeper
policy (the claimant holding a committed `SyncRecord`) and the scope filter are supplied
by the sync engine per call; the filesystem stores nothing and reads no sync state.

The public `IFileSystem` view — `list`, `stat`, `getChangedPaths` — is 1:1 and carries no
collision. The sync engine no longer observes `contended`, `withheld`, `displacements`, a
`checkpointBlocked` field, or an `awaiting_repair` reason.

## Consequences

- The mutation boundary changes: one backend rename is issued from the backend layer, not
  from an admitted execution action. `AGENTS.md` and
  `docs/design/design-four-stage-sync-pipeline.md` (RESP-005, INV-017) record it.
- The sync engine retries a reconciled cycle exactly as it queues a follow-up; the
  convergence premise ("the next cycle observes settled facts") is now true, because the
  filesystem settled the namespace before the cycle continues.
- Nothing new is persisted. No collision record, repair queue, recovery marker or new
  store exists; a refused rename is an ordinary non-clean outcome retried under the
  existing error policy.
- The arbitration, drain settlement and deletion attribution remain inside the
  filesystem; only their publication changes.

## Alternatives

- **Keep the Admission stage and bound the follow-up.** Rejected: the engine would still
  own a fact it cannot act on, and a bound is a recovery marker.
- **A vault-local invented address.** Rejected already in change-20260916: the invented
  address is not re-derivable from a delta page's own facts and `setFile`'s re-key guard
  snaps it back.
