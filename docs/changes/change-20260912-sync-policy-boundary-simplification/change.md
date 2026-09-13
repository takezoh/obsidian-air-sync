---
id: change-20260912-sync-policy-boundary-simplification
kind: change
title: Simplify sync policy responsibility boundaries
status: active
created: '2026-09-12'
profile: sdd@1
intent: Preserve the accepted four-stage sync pipeline while replacing downstream
  raw conflict-strategy reinterpretation with one Admission-owned typed action policy.
outcomes:
- Observation uses strategy only for bounded fact acquisition.
- Admission compiles every conflict into one required closed execution policy.
- Execution, resolver, and audit consume the admitted policy without rereading or
  reinterpreting settings.
- Commit and finalization ownership, ordering, publication, and retry behavior remain unchanged.
scope:
- src/sync/types.ts
- src/sync/sync-cycle-planning.ts
- src/sync/plan-admission.ts
- src/sync/identity-component-decision.ts
- src/sync/conflict-policy-admission.ts
- src/sync/plan-executor.ts
- src/sync/conflict-action-contract.ts
- src/sync/conflict-resolver.ts
- src/sync/execution-result.ts
- src/sync/conflict-history.ts
- src/sync/orchestrator.ts
- src/sync/plan-admission-case-alias.ts
- src/sync/conflict-resolver.test.ts
- src/sync/conflict.test.ts
- src/sync/convergence.test.ts
- src/sync/crash-safety.test.ts
- src/sync/delete-safety.test.ts
- src/sync/fact-first-execution.test.ts
- src/sync/opened-file-priority.test.ts
- src/sync/plan-admission.test.ts
- src/sync/plan-executor.test.ts
- src/sync/state-committer.test.ts
- src/sync/sync-cycle-planning.test.ts
- sync-admission-authority-guard.test.mjs
- docs/code-enforcement.md
- docs/conflict-resolution.md
- docs/design/design-four-stage-sync-pipeline.md
- docs/sync-pipeline.md
- docs/changes/change-20260912-sync-policy-boundary-simplification/**
non_goals:
- Changing conflict outcomes, identity grouping, action order, preservation, or publication semantics.
- Adding a fifth policy stage, generic rule engine, durable policy/proof state, or recovery marker.
- Changing provider APIs, persisted settings, database schema, or retry scheduling.
change_classes:
- responsibility
- boundary
- internal_design
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260912-sync-policy-boundary-simplification/requirements.md
  required: true
- role: implementation
  path: changes/change-20260912-sync-policy-boundary-simplification/implementation.md
  required: true
- role: verification
  path: changes/change-20260912-sync-policy-boundary-simplification/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags:
- sync
- conflict-resolution
- responsibility-boundary
owners: []
relations: []
source_paths:
- src/sync/types.ts
- src/sync/sync-cycle-planning.ts
- src/sync/identity-component-decision.ts
- src/sync/conflict-policy-admission.ts
- src/sync/plan-executor.ts
- src/sync/conflict-action-contract.ts
- src/sync/conflict-resolver.ts
- src/sync/orchestrator.ts
summary: Replace scattered raw conflict-strategy interpretation with Admission-owned
  typed execution contracts and responsibility-local helpers.
---

## Summary

Make conflict policy flow explicit: capture the setting once, let Observation use it
only for acquisition, let Admission bind a required typed policy to each conflict
action, and make every downstream consumer follow that policy verbatim.

## Closure Notes
