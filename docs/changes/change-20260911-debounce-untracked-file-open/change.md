---
id: change-20260911-debounce-untracked-file-open
kind: change
title: Debounce untracked file-open fallback
status: active
created: '2026-09-11'
profile: sdd@1
intent: Keep file creation inside the scheduler-owned debounce even when Obsidian
  immediately opens the new untracked note.
outcomes:
- Opening a newly created untracked note does not start a batch before the vault debounce
  expires.
- An untracked open without a create event still schedules one normal lifecycle after
  the debounce interval.
scope:
- src/sync/opened-file-priority.ts
- src/sync/opened-file-priority.test.ts
- src/sync/orchestrator.ts
- src/sync/orchestrator.test.ts
- src/sync/scheduler.ts
- src/sync/scheduler.test.ts
- docs/sync-pipeline.md
- docs/adr/0004-sync-reruns-are-classified-by-trigger.md
non_goals:
- Do not delay tracked priority pulls or safety fallbacks after contradiction, invalidation,
  provider failure, or CAS loss.
change_classes:
- behavior
- responsibility
- invariant
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260911-debounce-untracked-file-open/requirements.md
  required: true
- role: implementation
  path: changes/change-20260911-debounce-untracked-file-open/implementation.md
  required: true
- role: verification
  path: changes/change-20260911-debounce-untracked-file-open/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: modifies, target: design-four-stage-sync-pipeline}
source_paths:
- src/sync/opened-file-priority.ts
- src/sync/orchestrator.ts
- src/sync/scheduler.ts
summary: Return an untracked priority outcome to the scheduler and coalesce it through
  the existing vault debounce.
updated: '2026-09-11'
---

## Summary

## Closure Notes
