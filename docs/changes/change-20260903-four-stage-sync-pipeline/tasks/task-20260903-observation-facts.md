---
id: task-20260903-observation-facts
kind: task
title: unit-observation-carriers
status: done
created: '2026-09-03'
priority: normal
effort: medium
files_touched:
- src/sync/sync-cycle-planning.ts
- src/sync/sync-cycle-planning.test.ts
pr: null
tags: []
owners: []
relations:
- {type: partOf, target: change-20260903-four-stage-sync-pipeline}
source_paths: []
change: change-20260903-four-stage-sync-pipeline
summary: Make the pre-Admission boundary fact-only.
max_diff_loc: 300
pinned_context:
- docs/changes/change-20260903-four-stage-sync-pipeline/tasks/task-20260903-observation-facts.md
- docs/changes/change-20260903-four-stage-sync-pipeline/design-plan
updated: '2026-09-03'
---

## Responsibility

Make the pre-Admission boundary fact-only.

## Execution contract

- Output: TypeScript carrier changes and focused tests.
- Tool guidance: Preserve existing copied evidence scope namespace and replay metadata.
- Boundaries: Do not construct actions or change provider observation.

## Acceptance

- The cycle carrier contains observed entries and no SyncPlan.
- Observation imports no action decision helper.


{% transition from="todo" to="in_progress" date="2026-09-03" %}
Unit implementation started
{% /transition %}


{% transition from="in_progress" to="done" date="2026-09-03" %}
Acceptance criteria verified by focused tests
{% /transition %}
