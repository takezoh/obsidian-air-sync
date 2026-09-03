---
id: change-20260903-mixed-scope-folder-rename
kind: change
title: Converge mixed-scope folder renames
status: active
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
- Admission scope normalization for local and remote folder rename evidence
- Focused mixed-scope folder rename tests and active sync design documentation
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
- src/sync/scope-normalization.ts
- src/sync/plan-admission.ts
- src/sync/plan-admission.test.ts
- docs/sync-pipeline.md
- docs/adr/0008-logical-identity-admission-fails-closed.md
summary: Partition a folder rename at the Admission boundary when every included descendant
  has an independently proven rename and excluded descendants remain untouched.
updated: '2026-09-03'
---

## Summary

An excluded descendant such as `desktop.ini` made a local folder rename fail
Admission even though every included Markdown descendant had exact file-level rename
evidence. Admission had coalesced those independently safe actions into one native
folder rename before applying scope, so the excluded path accidentally controlled an
operation outside its authority.

Normalize the component by scope before action shaping. The folder edge remains
identity and lifecycle evidence, but it is not an executable unit when included and
policy-excluded descendants have different consequences. Included descendants execute
only when their individual mappings are complete; excluded descendants are untouched.

## Closure Notes


{% transition from="closing" to="active" date="2026-09-03" %}
Keep package active until PR commit identity and deployed verification are recorded
{% /transition %}
