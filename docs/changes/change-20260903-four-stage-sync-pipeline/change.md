---
id: change-20260903-four-stage-sync-pipeline
kind: change
title: Four-stage sync pipeline responsibility normalization
status: active
created: '2026-09-03'
profile: sdd@1
intent: Normalize the sync engine into four explicit responsibility layers so Observation
  exposes facts only and Admission is the only authority that constructs executable
  actions.
outcomes:
- Observation returns immutable facts and no SyncPlan or executable action proposal.
- Admission constructs the exact authorized plan and remains the sole owner of identity
  topology conflict and destructive-action decisions.
- Execution performs only authorized effects and Finalization commits only exact terminal
  outcomes without behavior regressions.
- Repository documentation and lint guards enforce the four-layer boundary.
scope:
- src/sync/sync-cycle-planning.ts Observation carrier and preparation
- src/sync/plan-admission.ts Admission action construction and authorization
- src/sync/decision-engine.ts Admission-private path-local decision helper
- src/sync/orchestrator.ts four-layer lifecycle wiring and diagnostics
- src/sync/*test.ts boundary and behavior verification
- eslint.config.mts production import boundary enforcement
- ARCHITECTURE.md and docs/sync-pipeline.md durable four-layer design
- docs/adr/ and this change package
non_goals:
- Changing provider APIs checkpoint schema storage format priority semantics or conflict
  policy
- Introducing runtime re-Admission epochs receipts or additional top-level stages
- Changing the persistent outcome vocabulary beyond the already completed deferred
  removal
change_classes:
- behavior
- responsibility
- boundary
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260903-four-stage-sync-pipeline/requirements.md
  required: true
- role: implementation
  path: changes/change-20260903-four-stage-sync-pipeline/implementation.md
  required: true
- role: verification
  path: changes/change-20260903-four-stage-sync-pipeline/verification.md
  required: true
promotion:
- target: design-four-stage-sync-pipeline
  section: responsibilities
  action: upsert
  item:
    id: RESP-001
    statement: Observation acquires and freezes local, remote, baseline, scope, and
      namespace facts without constructing actions.
- target: design-four-stage-sync-pipeline
  section: responsibilities
  action: upsert
  item:
    id: RESP-002
    statement: Admission alone constructs exact actions, resolves identity topology
      and conflict policy, and authorizes a plan.
- target: design-four-stage-sync-pipeline
  section: responsibilities
  action: upsert
  item:
    id: RESP-003
    statement: Execution performs only authorized effects and reports exact outcomes
      without rerouting.
- target: design-four-stage-sync-pipeline
  section: responsibilities
  action: upsert
  item:
    id: RESP-004
    statement: Commit and finalization persist only proven terminal outcomes and advance
      checkpoint state last.
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-001
    statement: No executable action exists before Admission.
    enforcement: conformance
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-002
    statement: Every executed action belongs to the exact AuthorizedSyncPlan for the
      cycle.
    enforcement: contract
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-003
    statement: A checkpoint advances only after all admitted actions are terminal
      under finalization policy.
    enforcement: test
- target: design-four-stage-sync-pipeline
  section: boundaries.forbidden
  action: upsert
  item:
    id: BOUNDARY-003
    statement: Observation importing or invoking action decision helpers.
- target: design-four-stage-sync-pipeline
  section: boundaries.forbidden
  action: upsert
  item:
    id: BOUNDARY-004
    statement: Execution inventing, replacing, or rerouting actions.
- target: design-four-stage-sync-pipeline
  section: boundaries.forbidden
  action: upsert
  item:
    id: BOUNDARY-005
    statement: Finalization inferring success from listing absence or partial completion.
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: introduces, target: design-four-stage-sync-pipeline}
- {type: introduces, target: adr-20260903-four-stage-sync-pipeline}
- {type: conformsTo, target: adr-20260831-admission-owns-identity-component-decisi}
- {type: conformsTo, target: adr-20260902-fresh-state-reconciliation-for-rename-edits}
source_paths:
- src/sync/sync-cycle-planning.ts
- src/sync/plan-admission.ts
- src/sync/decision-engine.ts
- src/sync/orchestrator.ts
- ARCHITECTURE.md
- docs/sync-pipeline.md
- eslint.config.mts
summary: Make Observation fact-only and Admission the sole owner of action construction
  while preserving execution and finalization behavior.
updated: '2026-09-03'
---

## Summary

The normal sync pipeline currently documents a separate Propose stage even though Admission is the declared sole action authority. This change makes the boundary real: Observation emits facts, Admission constructs and authorizes actions, Execution performs them, and Commit/finalization publishes exact terminal state.

It preserves the already implemented PR54/PR57 rename, conflict, priority, provider, checkpoint, and outcome semantics. The change removes an authority split; it does not add runtime decision machinery.

## Closure Notes
