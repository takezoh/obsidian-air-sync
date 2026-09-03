---
id: change-20260903-remove-policy-out
kind: change
title: Remove excluded paths from the sync engine boundary
status: done
created: '2026-09-03'
profile: sdd@1
intent: Ensure excluded paths cease to exist at the sync engine boundary.
outcomes:
- BatchObservation contains only included paths in entries, observations, evidence,
  scope, and baseline membership.
- Cross-scope rename evidence is reduced to the independently observable included-side
  create or delete.
scope:
- src/sync/scope-projection.ts and sync-cycle-planning.ts boundary normalization
- Focused scope, planning, change detection, and admission tests
- Current sync design and obsolete mixed-scope change artifacts introduced only on
  the unmerged branch
- src/sync/scope-projection.ts
- src/sync/sync-cycle-planning.ts
- src/sync/types.ts
- src/sync/orchestrator.ts
- src/sync/scope-projection.test.ts
- src/sync/sync-cycle-planning.test.ts
- src/sync/change-detector.test.ts
- src/sync/plan-admission.test.ts
- docs/sync-pipeline.md
- docs/adr/0008-logical-identity-admission-fails-closed.md
- docs/design/design-four-stage-sync-pipeline.md
- docs/changes/change-20260903-mixed-scope-folder-rename/
- src/sync/identity-component-decision.ts
- src/sync/local-rename-admission.ts
- src/sync/convergence.test.ts
- src/sync/crash-safety.test.ts
non_goals:
- Changing execution, conflict, checkpoint, provider, or persistence semantics
change_classes:
- boundary
- behavior
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260903-remove-policy-out/requirements.md
  required: true
- role: implementation
  path: changes/change-20260903-remove-policy-out/implementation.md
  required: true
- role: verification
  path: changes/change-20260903-remove-policy-out/verification.md
  required: true
promotion:
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-004
    statement: Configured-scope filtering removes excluded paths and cross-scope identity
      edges before BatchObservation; Admission and later stages cannot observe or
      branch on them.
    enforcement: test
- target: design-four-stage-sync-pipeline
  section: boundaries.forbidden
  action: upsert
  item:
    id: BOUNDARY-006
    statement: BatchObservation carrying an excluded path, excluded-path disposition,
      or identity edge with an excluded endpoint.
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: modifies, target: design-four-stage-sync-pipeline}
- {type: references, target: change-20260902-sync-outcome-convergence}
source_paths:
- src/sync/scope-projection.ts
- src/sync/sync-cycle-planning.ts
- src/sync/types.ts
- src/sync/orchestrator.ts
- src/sync/scope-projection.test.ts
- src/sync/sync-cycle-planning.test.ts
- src/sync/change-detector.test.ts
- src/sync/plan-admission.test.ts
- docs/sync-pipeline.md
- docs/adr/0008-logical-identity-admission-fails-closed.md
- docs/changes/change-20260903-mixed-scope-folder-rename/change.md
- docs/changes/change-20260903-mixed-scope-folder-rename/requirements.md
- docs/changes/change-20260903-mixed-scope-folder-rename/implementation.md
- docs/changes/change-20260903-mixed-scope-folder-rename/verification.md
- src/sync/identity-component-decision.ts
- src/sync/local-rename-admission.ts
- src/sync/convergence.test.ts
- src/sync/crash-safety.test.ts
evidence_refs:
- type: test
  ref: RED npm test -- --run src/sync/sync-cycle-planning.test.ts (1 expected failure)
- type: test
  ref: focused sync boundary suites (6 files, 160 tests)
- type: test
  ref: mutation witness (5 expected failures; restored 23/23 green)
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro (29/29)
- type: command
  ref: npm run build
- type: command
  ref: npm run test:coverage (90 files, 1707 tests)
- type: command
  ref: dev-evidence out-of-scope-changes.v2 PASS
summary: Filter excluded paths and cross-scope identity evidence before constructing
  BatchObservation.
updated: '2026-09-03'
promotion_applied_at: '2026-09-03T11:38:46.290511+00:00'
closure:
  closed_at: '2026-09-03T11:39:04.437857+00:00'
  content_hash: sha256:cd259223bd7295578f6e89c1c48546a19d4fc96535b89e1ddd93435f09d6cd00
---

## Summary

The reverted PR introduced `policy_out` as an Admission-visible disposition for
explicit cross-scope rename endpoints. That violates the established boundary:
excluded paths must cease to exist before the sync engine receives its immutable
`BatchObservation`. This correction removes that disposition and clips every
path-bearing fact to configured scope before scope projection and Admission.

## Closure Notes
