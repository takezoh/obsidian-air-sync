---
id: change-20260903-mixed-scope-folder-rename
kind: change
title: Converge mixed-scope folder renames
status: abandoned
created: '2026-09-03'
profile: sdd@1
intent: Allow mixed-scope folder renames to converge without granting sync authority
  over policy-excluded descendants.
outcomes:
- Included descendants of a mixed-scope folder rename converge under their individual
  rename evidence.
- Policy-excluded descendants remain untouched at their original paths.
- Unknown or incompletely mapped included descendants still fail Admission before
  execution.
scope:
- Focused mixed-scope folder rename tests and active sync design documentation
- Admission topology partition and operation-footprint constraints for local and remote
  folder rename evidence
non_goals:
- Changing provider APIs, conflict strategy, executor behavior, or checkpoint storage
change_classes:
- behavior
- boundary
- internal_design
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260903-mixed-scope-folder-rename/requirements.md
  required: true
- role: implementation
  path: changes/change-20260903-mixed-scope-folder-rename/implementation.md
  required: true
- role: verification
  path: changes/change-20260903-mixed-scope-folder-rename/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations: []
source_paths:
- src/sync/plan-admission.ts
- src/sync/plan-admission.test.ts
- docs/sync-pipeline.md
- docs/adr/0008-logical-identity-admission-fails-closed.md
- src/sync/admission-topology.ts
- src/sync/plan-admission-graph.ts
- src/sync/local-rename-admission.ts
summary: Partition a folder rename at the Admission boundary when every included descendant
  has an independently proven rename and excluded descendants remain untouched.
updated: '2026-09-03'
---

## Summary

An excluded descendant made a local folder rename fail Admission even though every
included descendant had exact file-level rename evidence. The same defect applies to
every path rejected by the existing `isExcluded()` policy—system junk, user ignore
patterns, dot-path scope, Config Sync exclusions, and reserved plugin data. Admission
had connected these policy-out paths to managed resource identity and allowed them to
control an operation outside sync authority.

Partition Admission topology before graph construction. Included paths form managed
identity components; policy-out descendants are retained only as operation-footprint
constraints that prohibit native whole-folder execution. Included descendants execute
only when their individual mappings are complete; excluded descendants are untouched.

## Closure Notes


{% transition from="closing" to="active" date="2026-09-03" %}
Keep package active until PR commit identity and deployed verification are recorded
{% /transition %}


{% transition from="active" to="abandoned" date="2026-09-03" %}
Rejected: excluded descendants must not enter Admission topology; folder rename is opaque
{% /transition %}
