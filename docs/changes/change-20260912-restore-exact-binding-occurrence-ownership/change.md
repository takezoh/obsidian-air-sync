---
id: change-20260912-restore-exact-binding-occurrence-ownership
kind: change
title: Restore exact binding occurrence ownership
status: done
created: '2026-09-12'
profile: sdd@1
intent: Restore one-owner binding for exact endpoints so a later alias cannot authorize
  a second action from the same occurrence.
outcomes:
- Baseline exact binding and structural binding share the same occurrence-claim boundary.
- Ambiguous alias residue fails Admission instead of publishing duplicate destination
  actions.
scope:
- src/sync/identity-component-decision.ts
- src/sync/plan-admission.test.ts
- sync-admission-authority-guard.test.mjs
- docs/changes/change-20260912-restore-exact-binding-occurrence-ownership/**
non_goals:
- Do not change exact-path materialization, native rename selection, relation abandonment,
  Execution, publication, checkpoint, or persistent state.
change_classes:
- behavior
- invariant
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260912-restore-exact-binding-occurrence-ownership/requirements.md
  required: true
- role: implementation
  path: changes/change-20260912-restore-exact-binding-occurrence-ownership/implementation.md
  required: true
- role: verification
  path: changes/change-20260912-restore-exact-binding-occurrence-ownership/verification.md
  required: true
promotion:
- target: none
  section: none
  action: none
  item: {}
  reason: Existing INV-006 and occurrence-ownership rules already govern this review
    correction.
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: dependsOn, target: change-20260912-unify-exact-path-admission}
- {type: conformsTo, target: design-four-stage-sync-pipeline}
source_paths:
- src/sync/identity-component-decision.ts
- src/sync/plan-admission.test.ts
- sync-admission-authority-guard.test.mjs
evidence_refs:
- type: test
  ref: RED focused Admission test produced conflict(case.md) plus rename_remote(Case.md
    to case.md)
- type: test
  ref: RED reversed-baseline Admission test produced two actions from the same local
    occurrence
- type: test
  ref: RED historical identity mismatch test produced conflict plus a second action
    from the same remote occurrence
- type: test
  ref: RED identity-unavailable exact endpoint test produced two conflicts from the
    same remote occurrence
- type: test
  ref: GREEN npm test -- --run src/sync/plan-admission.test.ts (129 tests)
- type: test
  ref: node --test sync-admission-authority-guard.test.mjs (11 tests)
- type: test
  ref: npm run test:coverage (96 files, 2016 tests)
- type: test
  ref: fake_green_guard.py PASS
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro (56 guard tests)
- type: command
  ref: npm run build
- type: contract
  ref: Sol cross-task review found and verified fixes for identity-unavailable duplicate
    binding and exact-dispatch guard false-green
summary: Prevent exact and structural binders from claiming the same current occurrence
  and enforce both exact dispatch sites.
updated: '2026-09-12'
promotion_applied_at: '2026-09-12T06:16:19.582259+00:00'
closure:
  closed_at: '2026-09-12T06:16:26.460943+00:00'
  content_hash: sha256:304ae31730f7189666fcbfb6912b3420f3222aba3234e4296608f1a2fb12bce2
---

## Summary

An exact binding must claim the concrete endpoints it owns before later alias and tail
binding passes inspect the same component.

## Closure Notes


{% transition from="draft" to="ready" date="2026-09-12" %}
Review finding, bounded scope, requirements, implementation contract, and verification plan are complete.
{% /transition %}


{% transition from="ready" to="active" date="2026-09-12" %}
Begin the bounded review correction after the approved implementation direction.
{% /transition %}


{% transition from="active" to="closing" date="2026-09-12" %}
Implementation, required gates, fake-green check, and independent Sol rereview are complete.
{% /transition %}
