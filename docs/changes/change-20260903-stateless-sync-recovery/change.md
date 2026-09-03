---
id: change-20260903-stateless-sync-recovery
kind: change
title: Recover sync from current state without operation journals
status: done
created: '2026-09-03'
profile: sdd@1
intent: Remove persisted intermediate operations and make every failed sync converge
  by re-observing current endpoint state.
outcomes:
- Rename evidence exists only in the current in-memory cycle.
- Failed cycles retain the last clean checkpoint and the next sync replans from current
  state.
- Dropbox case-only rename has no marker or startup-resume lifecycle.
scope:
- src/sync/
- src/fs/dropbox/
- src/store/metadata-store.ts
- src/store/metadata-store.test.ts
- ARCHITECTURE.md
- docs/sync-pipeline.md
- docs/design/design-four-stage-sync-pipeline.md
- docs/adr/0008-logical-identity-admission-fails-closed.md
- docs/adr/adr-20260903-stateless-current-state-recovery.md
non_goals:
- Guarantee crash atomicity across two Dropbox API calls without provider support
- Infer arbitrary renames from matching names or content after restart
- Add a replacement pending, deferred, retry, debt, or journal state
- Rewrite closed historical change packages
change_classes:
- behavior
- responsibility
- invariant
- internal_design
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260903-stateless-sync-recovery/requirements.md
  required: true
- role: implementation
  path: changes/change-20260903-stateless-sync-recovery/implementation.md
  required: true
- role: verification
  path: changes/change-20260903-stateless-sync-recovery/verification.md
  required: true
promotion:
- target: design-four-stage-sync-pipeline
  section: boundaries.consumes
  action: upsert
  item:
    id: BOUNDARY-002
    statement: Committed baseline, current change-detection facts, identity evidence,
      observations, scope, and namespace.
- target: design-four-stage-sync-pipeline
  section: failure_responsibilities
  action: upsert
  item:
    id: FAILURE-004
    statement: Finalization withholds the checkpoint for nonterminal outcomes and
      writes no recovery instruction.
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: introduces, target: adr-20260903-stateless-current-state-recovery}
- {type: modifies, target: adr-20260903-four-stage-sync-pipeline}
source_paths:
- src/sync/state.ts
- src/sync/orchestrator.ts
- src/sync/sync-cycle-planning.ts
- src/sync/plan-admission.ts
- src/sync/plan-executor.ts
- src/sync/sync-cycle-finalization.ts
- src/fs/dropbox/index.ts
- src/store/metadata-store.ts
- docs/sync-pipeline.md
evidence_refs:
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro (29/29)
- type: command
  ref: npm run build
- type: command
  ref: npm run test:coverage (90 files, 1712 tests)
- type: command
  ref: docs lint --conformance (34 indexed, no warnings)
- type: command
  ref: dev-evidence closure.evidence-readiness PASS; scope PASS; declaration coverage
    26/26
summary: 'Delete rename debt, Dropbox pending rename, and failure quarantine so recovery
  has one path: committed baseline plus current observation.'
updated: '2026-09-03'
promotion_applied_at: '2026-09-03T09:26:19.548186+00:00'
closure:
  closed_at: '2026-09-03T09:26:26.563521+00:00'
  content_hash: sha256:d5e55306c2522946c19441c9541cced09b13b0d12b3029ee612a16d9a12114e0
---

## Summary

The engine currently persists a local rename obligation before provider I/O and Dropbox
persists a pending two-leg case-only move. Both create a second recovery mechanism beside
the committed sync baseline. Old obligations can contradict current state and startup
resume mutates a provider before a new sync has observed both endpoints.

This change removes both journals and every replay/release/resume branch. The only durable
sync facts are verified successful-unit `SyncRecord` bundles and a remote checkpoint
committed after a clean cycle. Any error leaves the checkpoint unchanged; the next explicit
sync performs COLD current-state observation and derives a new plan. Current-cycle rename
evidence remains an optimization and conflict input, never a future command.
