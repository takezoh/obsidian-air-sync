---
id: task-20260831-unit-2-pipeline-and-lifecycle-migration
kind: task
title: unit-2-pipeline-and-lifecycle-migration
status: todo
created: '2026-08-31'
priority: normal
effort: medium
files_touched:
- src/sync/sync-cycle-planning.ts
- src/sync/cycle-admission-snapshot.ts
- src/sync/rename-optimizer.ts
- src/sync/rename-optimizer.test.ts
- src/sync/orchestrator.ts
- src/sync/plan-executor.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/convergence.test.ts
- src/sync/crash-safety.test.ts
- src/sync/delete-safety.test.ts
pr: null
tags: []
owners: []
relations:
- type: partOf
  target: change-20260831-sync-decision-resource-components
- type: dependsOn
  target: task-20260831-unit-1-single-identity-component-owner
source_paths: []
change: change-20260831-sync-decision-resource-components
summary: Remove the refinement stage and migrate consumers/tests to Admission over
  the immutable plain proposal while preserving v6, execution, and commit-last behavior.
max_diff_loc: 300
pinned_context:
- docs/changes/change-20260831-sync-decision-resource-components/tasks/task-20260831-unit-2-pipeline-and-lifecycle-migration.md
- docs/changes/change-20260831-sync-decision-resource-components/design-plan
---

## Responsibility

Remove the refinement stage and migrate consumers/tests to Admission over the immutable plain proposal while preserving v6, execution, and commit-last behavior.

## Execution contract

- Output: Atomic call-site migration, retired optimizer API/module, component diagnostics, and integration evidence.
- Tool guidance: Verify executor input typing and failure call order before the full gate.
- Boundaries: Do not add a refinePlan shim, change SyncState v6, reorder executor barriers, or let Finalization reinterpret evidence.

## Acceptance

- AC-SD-003
- AC-SD-004
- AC-SD-005
- AC-SD-008
