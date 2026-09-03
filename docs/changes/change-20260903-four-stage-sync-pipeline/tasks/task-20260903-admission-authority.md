---
id: task-20260903-admission-authority
kind: task
title: unit-admission-authority
status: done
created: '2026-09-03'
priority: normal
effort: medium
files_touched:
- src/sync/plan-admission.ts
- src/sync/decision-engine.ts
- eslint.config.mts
- src/sync/plan-admission.test.ts
- src/sync/decision-engine.test.ts
pr: null
tags: []
owners: []
relations:
- {type: partOf, target: change-20260903-four-stage-sync-pipeline}
- {type: dependsOn, target: task-20260903-observation-facts}
source_paths: []
change: change-20260903-four-stage-sync-pipeline
summary: Make Admission the sole action-construction authority.
max_diff_loc: 300
pinned_context:
- docs/changes/change-20260903-four-stage-sync-pipeline/tasks/task-20260903-admission-authority.md
- docs/changes/change-20260903-four-stage-sync-pipeline/design-plan
updated: '2026-09-03'
---

## Responsibility

Make Admission the sole action-construction authority.

## Execution contract

- Output: TypeScript boundary changes lint guard and tests.
- Tool guidance: Keep the pure decision table as an Admission-private helper.
- Boundaries: Do not change conflict policy action algebra or identity component rules.

## Acceptance

- Admission alone invokes planSync in production.
- Exact actions and dispositions remain behavior-compatible.
- Lint rejects foreign production imports.


{% transition from="todo" to="in_progress" date="2026-09-03" %}
Unit implementation started
{% /transition %}


{% transition from="in_progress" to="done" date="2026-09-03" %}
Acceptance criteria verified by focused tests
{% /transition %}
