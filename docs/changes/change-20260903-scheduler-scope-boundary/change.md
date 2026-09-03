---
id: change-20260903-scheduler-scope-boundary
kind: change
title: Filter excluded rename endpoints at scheduler boundary
status: done
created: '2026-09-03'
profile: sdd@1
intent: Ensure excluded rename endpoints never enter the sync engine's local event
  input.
outcomes:
- Cross-scope file renames retain only the included endpoint as an ordinary dirty
  path.
- Cross-scope folder renames expand to included child-file changes without storing
  an excluded folder or file path.
scope:
- src/sync/scheduler.ts vault rename event normalization
- src/sync/scheduler.test.ts boundary tests
- src/sync/ integration changes owned by the referenced excluded-path correction
- docs/sync-pipeline.md shared boundary documentation
- docs/adr/0008-logical-identity-admission-fails-closed.md shared boundary ADR
- docs/design/design-four-stage-sync-pipeline.md shared governing design
- docs/changes/change-20260903-remove-policy-out/ referenced correction package
- docs/changes/change-20260903-mixed-scope-folder-rename/ obsolete package removal
non_goals:
- Changing configured-scope policy
- Changing sync state persistence or action execution
change_classes:
- boundary
- behavior
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260903-scheduler-scope-boundary/requirements.md
  required: true
- role: implementation
  path: changes/change-20260903-scheduler-scope-boundary/implementation.md
  required: true
- role: verification
  path: changes/change-20260903-scheduler-scope-boundary/verification.md
  required: true
promotion:
- action: none
  reason: The referenced excluded-path correction already promoted the governing invariant
    and forbidden boundary; this supplement brings scheduler ingress into conformance
    with it.
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: references, target: change-20260903-remove-policy-out}
- {type: modifies, target: design-four-stage-sync-pipeline}
source_paths:
- src/sync/scheduler.ts
- src/sync/scheduler.test.ts
evidence_refs:
- type: test
  ref: RED scheduler suite (6 expected failures)
- type: test
  ref: GREEN scheduler suite (35 tests)
- type: command
  ref: final repository gate (lint, lint:bot-repro, build, test:coverage)
- type: command
  ref: dev-evidence out-of-scope and closure readiness PASS
summary: Keep excluded rename endpoints out of LocalChangeTracker and expand cross-scope
  folder events to included file changes.
updated: '2026-09-03'
closure:
  closed_at: '2026-09-03T11:49:56.492012+00:00'
  content_hash: sha256:0b303fe796580fd83634f55ee94aa5263395e2baa99f9a337d33bb6a21bb20d4
---

## Summary

Final verification found that `SyncScheduler` still preserved cross-scope rename
edges in `LocalChangeTracker`. Filter those edges at event ingress: ordinary file
renames retain only included endpoints, while folder events are expanded to included
file units when either root is excluded.

## Closure Notes

Excluded rename endpoints are now removed at scheduler ingress. No durable state or
new sync status was introduced.
