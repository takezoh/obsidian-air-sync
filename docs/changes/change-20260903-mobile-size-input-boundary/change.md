---
id: change-20260903-mobile-size-input-boundary
kind: change
title: Remove mobile size policy from sync-engine state
status: done
created: '2026-09-03'
profile: sdd@1
intent: Enforce the mobile maximum file size as sync-input scope instead of an engine-visible
  deferred state, consistently across batch, scheduler, priority, and checkpoint recovery
  paths.
outcomes:
- Oversized current files are absent from LocalChangeTracker and BatchObservation.
- Priority pull stops before content I/O when current local or remote metadata proves
  the file oversized.
- Raising the effective mobile threshold forces one cold reconcile.
scope:
- docs/adr/0008-logical-identity-admission-fails-closed.md governing decision
- docs/design/design-four-stage-sync-pipeline.md governing invariant
- docs/sync-pipeline.md active pipeline contract
- src/main.ts scheduler policy wiring
- src/sync/opened-file-priority.test.ts priority boundary tests
- src/sync/opened-file-priority.ts priority boundary
- src/sync/orchestrator.test.ts threshold-widening recovery test
- src/sync/orchestrator.ts canonical exclusion policy wiring
- src/sync/scheduler.test.ts event-ingress tests
- src/sync/scheduler.ts event-ingress boundary
- src/sync/scope-fingerprint.test.ts effective-policy fingerprint test
- src/sync/scope-fingerprint.ts effective-policy fingerprint
- src/sync/scope-projection.test.ts scope filtering tests
- src/sync/scope-projection.ts pre-Observation filtering
- src/sync/sync-cycle-planning.test.ts BatchObservation boundary tests
- src/sync/types.ts scope disposition vocabulary
non_goals:
- Persisting excluded paths or deferred operations
- Changing unknown-observation fail-closed behavior
- Cleaning stale failed-action quarantine documentation and permanentCode residue
change_classes:
- boundary
- behavior
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260903-mobile-size-input-boundary/requirements.md
  required: true
- role: implementation
  path: changes/change-20260903-mobile-size-input-boundary/implementation.md
  required: true
- role: verification
  path: changes/change-20260903-mobile-size-input-boundary/verification.md
  required: true
promotion:
- action: upsert
  target: design-four-stage-sync-pipeline
  section: invariants
  item:
    id: INV-004
    statement: Configured path and effective mobile-size filtering removes excluded
      paths and cross-scope identity edges before BatchObservation; LocalChangeTracker,
      Admission, and later stages cannot observe or branch on them.
    enforcement: test
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: modifies, target: design-four-stage-sync-pipeline}
- {type: references, target: change-20260903-remove-policy-out}
- {type: supersedes, target: change-20260903-remove-policy-out}
source_paths:
- docs/adr/0008-logical-identity-admission-fails-closed.md
- docs/design/design-four-stage-sync-pipeline.md
- docs/sync-pipeline.md
- src/sync/scope-projection.ts
- src/sync/scope-projection.test.ts
- src/sync/types.ts
- src/sync/scheduler.ts
- src/sync/scheduler.test.ts
- src/main.ts
- src/sync/opened-file-priority.ts
- src/sync/opened-file-priority.test.ts
- src/sync/orchestrator.ts
- src/sync/orchestrator.test.ts
- src/sync/scope-fingerprint.ts
- src/sync/scope-fingerprint.test.ts
- src/sync/sync-cycle-planning.test.ts
evidence_refs:
- type: test
  ref: RED focused suites (9 expected failures, 139 passing controls)
- type: test
  ref: GREEN focused suites (168 tests)
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro (29 tests)
- type: command
  ref: npm run build
- type: command
  ref: npm run test:coverage (90 files, 1715 tests)
- type: test
  ref: live Google Drive, Dropbox, and OneDrive E2E (3 files, 163 tests)
- type: contract
  ref: independent causal critique approved with zero findings
- type: command
  ref: dev-evidence out-of-scope and closure readiness PASS at scope-7317bcfd40af7979
summary: Treat oversized current files as absent at every sync input boundary, without
  deferred state.
updated: '2026-09-03'
promotion_applied_at: '2026-09-03T13:08:25.725383+00:00'
closure:
  closed_at: '2026-09-03T13:08:54.184759+00:00'
  content_hash: sha256:49e7066ffb4f47131c8ce3336d8a11de2a9badd02ceda26bda6984de73abc542
---

## Summary

Remove `mobile_deferred` from the engine model. A single metadata-aware boundary
predicate treats oversized current files as nonexistent to sync, while current-state
observation and scope fingerprinting keep threshold changes convergent without durable
intermediate state.

## Closure Notes

All declared outcomes are implemented. Oversized current files are filtered at local
event, batch observation, and priority-content boundaries; effective scope widening is
recovered by one cold scan; no durable intermediate state was added.
