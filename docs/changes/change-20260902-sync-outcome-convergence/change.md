---
id: change-20260902-sync-outcome-convergence
kind: change
title: Reconcile local rename edits without deferred state
status: draft
created: '2026-09-02'
profile: sdd@1
intent: Replace indefinite rename-mismatch replay with per-invocation fresh
  reconciliation while preserving Admission ownership and commit-last safety.
outcomes:
- A synchronized regular file renamed and edited locally converges when the remote baseline is unchanged.
- An observed remote or destination change enters the configured existing conflict behavior before rename/write.
- Observation, transport, crash, and partial-effect recovery persist no pending operation and reclassify fresh state next invocation.
- Existing SyncRecord, COLD recovery, checkpoint-last, and exact debt release remain the recovery boundary.
scope:
- Admission, execution, conflict, finalization, status, and command behavior for one regular-file local rename plus edit.
- Fresh classification of unchanged, post-rename, converged, remote-changed, destination-conflict, and unknown states.
- Existing SyncState v6 RenameDebt as candidate endpoint evidence only, never replay authority.
non_goals:
- Folder renames, rename chains, interactive conflict strategy, or a general workflow engine.
- Persisted field migration or transformation of SyncState v6.
- New provider/checkpoint capability, durable recovery workflow, rollback rename, or atomic external-writer guarantee.
change_classes:
- behavior
- responsibility
- invariant
- internal_design
governance:
  gate: hard
  reasons:
  - Changes the accepted rename-mismatch deferral and RenameDebt replay consequences.
  - Changes destructive Admission classification and partial-effect recovery behavior.
  approval_evidence: User confirmed fresh reconciliation without journal, deferred, pending replay, attention workflow, conditional-provider boundary, or operation-bound checkpoint receipt on 2026-09-02.
members:
- role: requirements
  path: changes/change-20260902-sync-outcome-convergence/requirements.md
  required: true
- role: implementation
  path: changes/change-20260902-sync-outcome-convergence/implementation.md
  required: true
- role: verification
  path: changes/change-20260902-sync-outcome-convergence/verification.md
  required: true
promotion:
- target: none
  section: none
  action: none
  item: {}
  reason: The accepted fresh-state reconciliation ADR owns the durable decision; no existing top-level design document is in the authorized scaffold.
unresolved_decisions: []
tags:
- sync
- convergence
- rename
- safety
owners: []
relations:
- {type: introduces, target: adr-20260902-fresh-state-reconciliation-for-rename-edits}
- {type: modifies, target: adr-20260831-admission-owns-identity-component-decisi}
- {type: modifies, target: adr-20260831-admission-owned-local-rename-constraint-lifecycle}
source_paths:
- src/sync/decision-engine.ts
- src/sync/identity-component-decision.ts
- src/sync/plan-admission.ts
- src/sync/plan-executor.ts
- src/sync/conflict-resolver.ts
- src/sync/conflict.ts
- src/sync/merge.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/rename-debt.ts
- src/sync/orchestrator.ts
- src/sync/orchestrator.test.ts
- src/sync/plan-admission.test.ts
summary: Recompute rename-edit work from current local, committed baseline, and fresh
  remote evidence on every invocation, without durable deferred or pending state.
---

## Summary

Deliver the dependency-ordered contracts in [implementation.md](implementation.md). The implementation keeps existing provider and checkpoint interfaces, introduces no durable recovery store, and uses the configured conflict strategy only after fresh remote or destination change is observed.

## Closure Notes

Closure requires the fresh-state reconciliation ADR accepted, both superseded proposals rejected with consultation provenance, all success criteria in [verification.md](verification.md) evidenced, no deferred or pending replay path, the repository gate green, and the promotion disposition applied.
