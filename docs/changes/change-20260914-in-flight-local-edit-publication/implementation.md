---
change: change-20260914-in-flight-local-edit-publication
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Accepted design boundary

`adr-20260914-publish-captured-push-revision` is accepted and must exist before production
work begins. It narrowly supersedes the prior rule for a still-present changed local source
only after an ordinary push passed final pre-write validation and exactly proved the
captured bytes at the admitted remote target.

## Contracts

### contract-captured-push-publication

`src/sync/plan-executor.ts` keeps the existing `ExactSnapshot` to branded
`TerminalActionProof` path. In the push branch, the proof's local publication entity is the
captured entity and `intendedContent` is the captured buffer. Remote actual path, identity,
kind, size, and bytes remain mandatory. Current local bytes after the write are not a proof
input for that completed push.

Test seams: `src/sync/local-edit-during-push.repro.test.ts` and
`src/sync/plan-executor.test.ts`.

### contract-publication-binding

`commitAction` remains the sole per-file publisher. It consumes the branded proof, performs
the existing exact state CAS, builds the record from captured local facts and proved remote
facts, and supplies `intendedContent` to the validated best-effort merge-base projection.
It does not infer execution history or reread the newer local revision.

Test seams: record/base assertions in the reproduction and exact-CAS negatives in
`src/sync/plan-executor.test.ts`.

### contract-next-cycle-convergence

Existing tracker generation equality and clean-only checkpoint rules remain unchanged. An
orchestrator-level deferred-write test must prove that a later generation survives clean
acknowledgment, drives the immediate next HOT push, creates no conflict sibling, and reaches
an unchanged third-cycle fixed point.

Test seams: `src/sync/orchestrator.test.ts`, `src/sync/local-tracker.test.ts`, and
`src/sync/sync-cycle-finalization.test.ts`.

### contract-non-push-strictness

Only `action.action === "push"` with captured content may use the historical local half.
Pull, rename, conflict, preservation, destination occupancy, descendant proof, remote
identity, and remote byte proof retain their current failure contracts.

### contract-architecture-conformance

The earlier ADR and active sync/error documentation must point to the narrow supersession.
The state-ownership guard must remain green without inventory expansion.

## Dependency-ordered units

1. `unit-0-record-accepted-boundary`: materialize the accepted ADR before production work.
2. `unit-1-push-proof-and-publication`: adjust the private push terminal input selection;
   turn the reproduction green and add hashless, corruption, identity, CAS, pull, rename,
   and conflict controls.
3. `unit-2-tracker-cycle-integration`: add the real tracker/checkpoint interleaving witness;
   do not alter lifecycle production owners unless a separate defect is evidenced.
4. `unit-3-docs-and-gates`: reconcile active ADR/docs and run focused tests plus the full
   repository gate.

## Implementation discretion

The only delegated choice is whether the captured-local selection is inline in the private
push branch or in an adjacent private helper in `plan-executor.ts`. Escalate if this requires
an exported/cross-component carrier, an additional provider call, a new state owner, or any
non-push weakening.
