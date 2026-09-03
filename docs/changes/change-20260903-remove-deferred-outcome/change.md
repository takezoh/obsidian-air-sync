---
id: change-20260903-remove-deferred-outcome
kind: change
title: Remove deferred sync outcome
status: done
created: '2026-09-03'
profile: sdd@1
intent: Remove the misleading deferred sync outcome and represent fail-closed Admission
  results as invocation-local failures.
outcomes:
- Admission exposes only authorized, resolved-no-action, or failed outcomes.
- Execution results contain executor outcomes only; cycle orchestration owns Admission
  failures.
- User-visible errors no longer claim unresolved components are retryable or deferred.
scope:
- src/sync Admission, cycle orchestration, notification, finalization, and focused
  tests
- Active sync architecture documentation
non_goals:
- Change conflict strategy or remote provider interfaces
- Add pending, journal, replay, or migration state
- Rewrite immutable historical change packages
change_classes:
- behavior
- responsibility
- internal_design
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260903-remove-deferred-outcome/requirements.md
  required: true
- role: implementation
  path: changes/change-20260903-remove-deferred-outcome/implementation.md
  required: true
- role: verification
  path: changes/change-20260903-remove-deferred-outcome/verification.md
  required: true
promotion:
- action: none
  reason: The accepted fresh-state reconciliation ADR already owns removal of the
    deferred outcome; this change brings implementation and active documentation into
    conformance.
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: modifies, target: adr-20260902-fresh-state-reconciliation-for-rename-edits}
source_paths:
- src/sync/plan-admission.ts
- src/sync/identity-component-decision.ts
- src/sync/execution-result.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/sync-cycle-planning.ts
- src/sync/sync-notification.ts
- src/sync/orchestrator.ts
- docs/sync-pipeline.md
- docs/error-handling.md
evidence_refs:
- type: test
  ref: 'focused: 175/175'
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro (29/29)
- type: command
  ref: npm run build
- type: command
  ref: npm run test:coverage (90 files, 1723 tests)
summary: Replace deferred Admission vocabulary with explicit invocation-local failure
  while preserving fail-closed execution and checkpoint safety.
updated: '2026-09-03'
promotion_applied_at: '2026-09-03T02:17:57.511059+00:00'
closure:
  closed_at: '2026-09-03T02:18:18.876841+00:00'
  content_hash: sha256:e0c65c6825f92ab31ad5093b22bb55f5b0c54e77a57fa9e01176a0609170fe6e
---

## Summary

The accepted fresh-state design removed deferred recovery authority, but the code still
exposes `DeferredComponent`, carries it through `ExecutionResult`, and presents it as a
retryable error. This change closes that design/implementation gap. Admission failures
remain fail-closed and checkpoint-holding, but they are truthful invocation-local errors,
not queued work or a promised convergence state.

## Closure Notes

Removed the deferred Admission outcome and its retryability presentation. The executor
result is again executor-only; orchestration owns the combined cycle outcome. Fail-closed
components remain visible as errors, hold the checkpoint, and request fresh COLD
observation on a later ordinary trigger without claiming eventual convergence.
