---
id: change-20260902-rename-identity-evidence-model
kind: change
title: Close rename identity and observation evidence model
status: ready
created: '2026-09-02'
profile: sdd@1
intent: Normalize rename identity evidence and sync ownership so every legal state
  terminates without deferred replay or silent remote-version loss.
outcomes:
- A local rename plus edit converges from fresh identity evidence when the tracked
  remote is unchanged.
- Tracked R at a third path plus foreign Y at the destination preserves both exact
  versions before the configured resolver runs once.
- Missing metadata uses bounded byte snapshots; unstable or unavailable evidence terminates
  explicitly for the invocation.
- Planning, Admission, resolver, executor, state committer, and cycle finalizer each
  have one authority boundary.
scope:
- src/sync/sync-cycle-planning.ts — immutable cycle evidence and one-time candidate
  derivation.
- src/sync/cycle-admission-snapshot.ts — shallow carrier folded into planning.
- src/sync/plan-admission.ts — normalized total Admission decision.
- src/sync/plan-admission-graph.ts — identity component partition.
- src/sync/identity-component-decision.ts — legal identity decision.
- src/sync/local-rename-admission.ts — rename candidate/debt admission.
- src/sync/conflict-resolver.ts — read-only preparation and sole conflict-output resolver.
- src/sync/conflict.ts — existing configured strategy output.
- src/sync/content-identity.ts — comparable keys and bounded byte witness.
- src/sync/plan-executor.ts — effect ordering and terminal proof.
- src/sync/execution-result.ts — closed execution failure result.
- src/sync/state-committer.ts — branded proof-gated per-file CAS.
- src/sync/sync-cycle-finalization.ts — checkpoint then exact debt release.
- src/sync/plan-admission.test.ts — legal union and total matrix verification.
- src/sync/conflict-resolver.test.ts — preparation and resolver verification.
- src/sync/conflict.test.ts — configured strategy behavior.
- src/sync/content-identity.test.ts — content/version witness verification.
- src/sync/plan-executor.test.ts — cut-point and terminal proof verification.
- src/sync/state-committer.test.ts — proof-gated CAS verification.
- src/sync/sync-cycle-finalization.test.ts — clean finalization verification.
- docs/adr/adr-20260903-preserve-all-observed-remote-versions.md — accepted multi-remote
  policy.
non_goals:
- Folder renames, rename chains, a new conflict strategy, provider/checkpoint API,
  or external-writer linearizability.
- Durable deferred, pending, journal, receipt, payload, replay, rollback, or cross-invocation
  artifact deduplication state.
change_classes:
- behavior
- responsibility
- invariant
- internal_design
governance:
  gate: hard
  reasons:
  - Changes user-visible conflict outputs for the multi-remote R/Y case.
  - Replaces the former retryable/deferred evidence outcome with a total normalized
    decision and bounded snapshot contract.
  approval_evidence: User selected preserve-all-then-resolve-tracked-identity on 2026-09-03
    and directed responsibility/boundary normalization.
members:
- role: requirements
  path: changes/change-20260902-rename-identity-evidence-model/requirements.md
  required: true
- role: implementation
  path: changes/change-20260902-rename-identity-evidence-model/implementation.md
  required: true
- role: verification
  path: changes/change-20260902-rename-identity-evidence-model/verification.md
  required: true
promotion:
- target: none
  section: none
  action: none
  item: {}
  reason: Accepted ADRs and this canonical design plan own the durable decisions;
    no separate stable design promotion is required.
unresolved_decisions: []
tags:
- sync
- convergence
- rename
- safety
owners: []
relations:
- {type: introduces, target: adr-20260903-preserve-all-observed-remote-versions}
- {type: modifies, target: adr-20260902-fresh-state-reconciliation-for-rename-edits}
- {type: modifies, target: adr-20260831-admission-owns-identity-component-decisi}
source_paths:
- src/sync/sync-cycle-planning.ts
- src/sync/plan-admission.ts
- src/sync/identity-component-decision.ts
- src/sync/conflict-resolver.ts
- src/sync/plan-executor.ts
- src/sync/state-committer.ts
- src/sync/sync-cycle-finalization.ts
summary: Normalize rename identity evidence, preserve R and Y, and assign one owner
  to each sync boundary.
updated: '2026-09-03'
---

## Summary

This change replaces case-by-case rename repair with one normalized evidence algebra and a one-way
authority pipeline. Planning captures one immutable candidate. Admission makes the total pure
authorization decision. Preparation only snapshots. The configured resolver alone preserves and
names conflict outputs. The executor alone mutates and proves the terminal state. Per-file CAS and
global checkpoint/debt release remain distinct commit-last boundaries.

## Closure Notes

Design-only package. Production implementation and gate evidence are intentionally not recorded yet.


{% transition from="draft" to="ready" date="2026-09-03" %}
Design spine, independent critique, minimality audit, accepted ADR, and documentation conformance are green.
{% /transition %}
