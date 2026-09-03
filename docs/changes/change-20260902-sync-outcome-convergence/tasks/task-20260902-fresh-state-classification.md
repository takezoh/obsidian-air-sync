---
id: task-20260902-fresh-state-classification
kind: task
title: unit-fresh-classification-admission
status: done
created: '2026-09-02'
priority: normal
effort: medium
files_touched:
- src/sync/sync-cycle-planning.ts
- src/sync/cycle-admission-snapshot.ts
- src/sync/plan-admission.ts
- src/sync/identity-component-decision.ts
- src/sync/plan-admission.test.ts
- src/sync/orchestrator.test.ts
pr: null
tags: []
owners: []
relations:
- {type: partOf, target: change-20260902-sync-outcome-convergence}
source_paths: []
change: change-20260902-sync-outcome-convergence
summary: Add fresh-state classification and compound Admission authority without new
  state or interfaces.
max_diff_loc: 300
pinned_context:
- docs/changes/change-20260902-sync-outcome-convergence/tasks/task-20260902-fresh-state-classification.md
- docs/changes/change-20260902-sync-outcome-convergence/design-plan
updated: '2026-09-02'
---

## Responsibility

Add fresh-state classification and compound Admission authority without new state or interfaces.

## Execution contract

- Output: Pure TypeScript policy changes and exhaustive behavior tests.
- Tool guidance: Reuse current ChangeSet, SyncRecord, identity evidence, and COLD acquisition seams.
- Boundaries: No journal, deferred/attention state, provider call from Admission, schema, or provider interface change.

## Acceptance

- Six current-state rows are exclusive and complete; unknown performs zero action.
- Local rename-edit is one authorized compound action only when remote baseline is unchanged.
- Existing debt supplies candidate endpoints but never selects authority.
