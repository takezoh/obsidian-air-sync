---
id: task-20260902-unit-fresh-execution-conflict
kind: task
title: unit-fresh-execution-conflict
status: todo
created: '2026-09-02'
priority: normal
effort: medium
files_touched:
- src/sync/plan-executor.ts
- src/sync/state-committer.ts
- src/sync/conflict-resolver.ts
- src/sync/conflict.ts
- src/sync/merge.ts
- src/sync/conflict-history.ts
- src/sync/plan-executor.test.ts
- src/sync/conflict-resolver.test.ts
- src/sync/orchestrator.test.ts
pr: null
tags: []
owners: []
relations:
- type: partOf
  target: change-20260902-sync-outcome-convergence
- type: dependsOn
  target: task-20260902-fresh-state-classification
source_paths: []
change: change-20260902-sync-outcome-convergence
summary: Execute/resume the compound outcome and adapt differing paths into existing
  conflict handling.
max_diff_loc: 300
pinned_context:
- docs/changes/change-20260902-sync-outcome-convergence/tasks/task-20260902-unit-fresh-execution-conflict.md
- docs/changes/change-20260902-sync-outcome-convergence/design-plan
---

## Responsibility

Execute/resume the compound outcome and adapt differing paths into existing conflict handling.

## Execution contract

- Output: Executor/resolver TypeScript changes with fault and conflict behavior tests.
- Tool guidance: Inject failures at rename, observe, write, verify, resolver delegation, and state commit boundaries.
- Boundaries: No durable operation/result record, conditional provider API, new conflict strategy, or checkpoint receipt.

## Acceptance

- Rename then current-content write commits baseline only after terminal verification.
- Partial effect resumes by next fresh classification without rollback or raw retry.
- Remote/destination change uses existing configured strategy and preserves observed remote content.
