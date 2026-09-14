---
id: change-20260914-in-flight-local-edit-publication
kind: change
title: Publish completed pushes while retaining later local edits
status: done
created: '2026-09-14'
profile: sdd@1
intent: Publish an exactly transferred local revision while retaining an edit that
  arrived during provider I/O as ordinary next-cycle work, instead of manufacturing
  a conflict from a stale baseline.
outcomes:
- A push whose remote terminal proves the captured bytes publishes that captured revision
  even when the local path changed after final pre-write validation.
- The later tracker generation survives clean closeout and converges through the next
  ordinary HOT push without a conflict.
- Remote corruption and every non-push terminal proof remain strict.
scope:
- src/sync/plan-executor.ts
- src/sync/plan-executor.test.ts
- src/sync/local-edit-during-push.repro.test.ts
- src/sync/orchestrator.test.ts
- docs/adr/adr-20260914-publish-captured-push-revision.md
- docs/adr/adr-20260908-converge-relational-ambiguity-with-a-pre.md
- docs/design/design-four-stage-sync-pipeline.md
- docs/sync-pipeline.md
- docs/error-handling.md
non_goals:
- No new durable or retained correctness owner, recovery branch, provider method,
  action, status, exported proof carrier, or receipt registry.
- No weakening of pre-write validation, remote terminal proof, exact record CAS, pull,
  rename, conflict, preservation, descendant, or checkpoint rules.
change_classes:
- behavior
- responsibility
- boundary
- invariant
governance:
  gate: hard
  reasons:
  - Narrows an accepted terminal-publication failure boundary across Execution, Publication,
    tracker acknowledgment, and checkpoint finalization.
  approval_evidence: The project owner requested a structural responsibility/boundary
    fix and explicitly instructed continuation after the accepted cross-responsibility
    contract conflict was identified on 2026-09-14.
members:
- role: requirements
  path: changes/change-20260914-in-flight-local-edit-publication/requirements.md
  required: true
- role: implementation
  path: changes/change-20260914-in-flight-local-edit-publication/implementation.md
  required: true
- role: verification
  path: changes/change-20260914-in-flight-local-edit-publication/verification.md
  required: true
promotion:
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-016
    statement: An ordinary push transfers one immutable exact local snapshot. After
      final pre-write validation, exact remote terminal proof publishes that captured
      entity and bytes as the SyncRecord baseline even if the current local endpoint
      changed or disappeared; the later tracker generation remains next-cycle input.
      This direction-specific rule never weakens remote proof or non-push protocols.
    enforcement: test
  reason: The change updates the persistent Execution-to-Publication responsibility
    boundary and must constrain future implementations.
unresolved_decisions: []
tags:
- sync
- concurrency
- publication
owners: []
relations:
- {type: modifies, target: design-four-stage-sync-pipeline}
source_paths:
- src/sync/plan-executor.ts
- src/sync/local-edit-during-push.repro.test.ts
- src/sync/plan-executor.test.ts
- src/sync/orchestrator.test.ts
evidence_refs:
- type: test
  ref: npm run test:coverage (98 files, 2110 tests)
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro (57 guard tests and source scan)
- type: command
  ref: npm run build
- type: command
  ref: dev-docs lint --conformance (55 documents, 0 warnings)
- type: contract
  ref: design planner comparison, two-pass critic, and integrator completed with no
    actionable blocker
summary: Publish the captured revision of an exactly proved push and retain any later
  local revision for conflict-free next-cycle convergence.
updated: '2026-09-14'
promotion_applied_at: '2026-09-14T12:47:35.006017+00:00'
closure:
  closed_at: '2026-09-14T12:48:00.865396+00:00'
  content_hash: sha256:f90e98cf6e927634ce01fbe933ca9ee178838ada8a08c969b9f1e2752a09dd4a
---

## Summary

Execution now distinguishes the immutable revision actually written remotely from the
current local endpoint after that write. Publication remains exact and single-owner;
tracker generations and checkpoint closeout retain their existing owners.

## Closure Notes


{% transition from="active" to="closing" date="2026-09-14" %}
Implementation, focused concurrency matrix, promotion, and full repository gate are complete.
{% /transition %}
