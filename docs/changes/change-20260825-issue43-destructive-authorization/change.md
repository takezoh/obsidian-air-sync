---
id: change-20260825-issue43-destructive-authorization
kind: change
title: Close destructive authorization at one decision boundary
status: ready
created: '2026-08-25'
profile: sdd@1
intent: Prevent ambiguous or incomplete sync evidence from authorizing destructive
  actions by making Admission the single final permission boundary, while simplifying
  the Issue 43 feature branch.
outcomes:
- Destructive execution accepts only an Admission-issued nominal plan bound to one
  immutable cycle snapshot.
- Actionless uncertainty is deferred, observable, checkpoint-holding, and recoverable
  through a later COLD cycle.
- Finalization performs mechanical completion and commit-last retirement without re-deciding
  safety.
- The full branch delta from bc83e326 is minimality-audited and Issue 46 causality
  remains independently verified.
scope:
- .gitignore
- ARCHITECTURE.md
- docs/adr/
- docs/code-enforcement.md
- docs/e2e-testing.md
- docs/sync-pipeline.md
- e2e/
- eslint.config.mts
- src/
non_goals:
- Changing persisted sync-state schemas or adding migration logic.
- Folding OneDrive Issue 46 evidence-production behavior into the central authorization
  fix.
- Adding a lifecycle manager, persistent component graph, remote debt, or duplicate
  normative evidence carrier.
change_classes:
- behavior
- boundary
- responsibility
- implementation_only
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260825-issue43-destructive-authorization/requirements.md
  required: true
- role: implementation
  path: changes/change-20260825-issue43-destructive-authorization/implementation.md
  required: true
- role: verification
  path: changes/change-20260825-issue43-destructive-authorization/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations: []
source_paths:
- src/sync/plan-admission.ts
- src/sync/plan-admission-graph.ts
- src/sync/sync-cycle-planning.ts
- src/sync/plan-executor.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/orchestrator.ts
summary: Centralize destructive authorization in Admission and simplify Issue 43 recovery
  and finalization boundaries.
updated: '2026-09-01'
---

## Summary

Centralize final destructive permission in Admission, retain actionless uncertainty,
and simplify the Issue 43 branch around one immutable authorization contract.

## Closure Notes

Implemented the immutable Admission snapshot, exhaustive dispositions, nominal executor
input, mechanical commit-last finalization, and strict pre-Admission COLD recovery.
Main-session review and the branch-wide minimality audit found no remaining blocking
issue; one redundant logging carrier was removed. Repository gates, dev-evidence scope
checks, and live Google Drive, Dropbox, and OneDrive E2E all pass.
