---
id: task-20260831-unit-1-single-identity-component-owner
kind: task
title: unit-1-single-identity-component-owner
status: todo
created: '2026-08-31'
priority: normal
effort: medium
files_touched:
- src/sync/plan-admission.ts
- src/sync/plan-admission-graph.ts
- src/sync/identity-component-decision.ts
- src/sync/local-rename-admission.ts
- src/sync/optimize-local-renames.ts
- src/sync/optimize-remote-renames.ts
- src/sync/plan-admission.test.ts
pr: null
tags: []
owners: []
relations:
- type: partOf
  target: change-20260831-sync-decision-resource-components
- type: dependsOn
  target: task-20260831-fs-evidence-conformance
source_paths: []
change: change-20260831-sync-decision-resource-components
summary: Build components once and decide exact actions, authority, disposition, and
  lifecycle membership under one private Admission owner.
max_diff_loc: 300
pinned_context:
- docs/changes/change-20260831-sync-decision-resource-components/tasks/task-20260831-unit-1-single-identity-component-owner.md
- docs/changes/change-20260831-sync-decision-resource-components/design-plan
---

## Responsibility

Build components once and decide exact actions, authority, disposition, and lifecycle membership under one private Admission owner.

## Execution contract

- Output: Pure TypeScript precedence-table decision, exhaustive typed outcomes, bounded private indexing, and discriminating tests.
- Tool guidance: Start with positive and adversarial row tests, permutation/scale tests, and mutations for hash, absence, completeness, multiple matches, and fallback rejection.
- Boundaries: Do not alter the path table, executor, persistence schema, provider interface, or introduce a general/persistent resource graph.

## Acceptance

- AC-SD-001
- AC-SD-002
- AC-SD-003
- AC-SD-004
- AC-SD-007
