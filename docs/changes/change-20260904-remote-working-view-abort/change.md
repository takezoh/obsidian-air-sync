---
id: change-20260904-remote-working-view-abort
kind: change
title: Abort uncommitted remote working views
status: draft
created: '2026-09-04'
profile: sdd@1
intent: Remove same-session recovery memory and make every incomplete checkpoint-capable
  sync attempt repeatable by explicitly discarding its uncommitted remote working
  view.
outcomes:
- Every checkpoint-capable attempt ends in exactly a clean commit or a live-only abort.
- COLD, WARM, and HOT converge from durable checkpoint facts, current SyncRecords,
  tracker facts, and current endpoints without prior-error state.
- Fatal executor actions settle scheduled siblings and invalidate queued provider
  work before the working view is discarded, without changing rejection selection.
- Durable checkpoint and scope queries never expose uncommitted live candidates and
  conservatively return false or null on read failure.
- Google Drive, Dropbox, and OneDrive prove same-instance replay through one shared
  provider-neutral checkpoint contract.
- ADR 0001 continues to govern exactly two durable authorities and is revised in place
  for an attempt-bounded live working view.
scope:
- AGENTS.md — permanent attempt-lifecycle and no-recovery-owner rules.
- ARCHITECTURE.md — durable checkpoint and working-view boundary.
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md — accepted governing
  decision.
- docs/adr/0002-backends-verified-by-shared-behaviour-contracts.md — shared contract
  responsibility.
- docs/adr/0008-logical-identity-admission-fails-closed.md — Admission-failure closeout.
- docs/adr/adr-20260903-stateless-current-state-recovery.md — ordinary retry semantics.
- docs/code-enforcement.md — test-pinned attempt lifecycle.
- docs/sync-pipeline.md — commit/abort and temperature selection.
- src/fs/interface.ts — required IncrementalCheckpoint abort operation.
- src/fs/caching/remote-fs.ts — durable queries and live-view lifecycle.
- src/fs/caching/remote-fs.contract.test.ts — base partial-prefix abort replay.
- src/__mocks__/sync-test-helpers.ts — complete checkpoint test double.
- src/fs/googledrive/index.test.ts — durable hasCheckpoint expectation.
- src/sync/orchestrator.ts — exhaustive exception closeout and removal of recovery
  state.
- src/sync/orchestrator.test.ts — retry, closeout, and ordinary replay verification.
- src/sync/plan-executor.ts — settle-before-fatal propagation fence.
- src/sync/plan-executor.test.ts — exact rejection and sibling settlement verification.
- src/sync/priority-batch-state.ts — fatal queued-action invalidation.
- src/sync/priority-batch-state.test.ts — aborting-phase scheduler verification.
- src/sync/sync-cycle-finalization.ts — returned-outcome commit-or-abort owner.
- src/sync/sync-cycle-finalization.test.ts — exhaustive finalization verification.
- sync-state-ownership-guard.test.mjs — closed orchestrator field inventory.
- tests/fs/contracts/caching-remote-fs.contract.ts — three-backend durable/live replay
  contract.
- tests/fs/googledrive/caching-remote-fs.contract-harness.ts — paginated Google Drive
  contract seam.
- tests/fs/dropbox/caching-remote-fs.contract-harness.ts — paginated Dropbox contract
  seam.
- tests/fs/onedrive/caching-remote-fs.contract-harness.ts — paginated OneDrive contract
  seam.
non_goals:
- New durable or intermediate state, store, schema/version, migration, journal, pending-work
  ledger, recovery marker, or replacement orchestrator field.
- Rolling back provider effects or successful per-file SyncRecord commits from started
  actions.
- Destructive resetCheckpoint use for ordinary failure recovery.
- Provider-specific pagination policy or changes to provider wire APIs.
- Changes to retry counts/backoff, error classification, conflict/rename semantics,
  pool limits, phase order, or per-file commit timing.
change_classes:
- behavior
- responsibility
- boundary
- invariant
- internal_design
governance:
  gate: hard
  reasons:
  - Changes the accepted same-session convergence mechanism in ADR 0001 and the shared
    IncrementalCheckpoint lifecycle boundary.
  - Changes when fatal executor errors become observable by requiring sibling settlement
    while preserving the existing selected rejection.
  approval_evidence: User explicitly directed the required live-only abort, exhaustive
    commit-or-abort lifecycle, same-rejection settlement rule, false/null durable-query
    fallback, and no-new-state boundary on 2026-09-04.
members:
- role: requirements
  path: changes/change-20260904-remote-working-view-abort/requirements.md
  required: true
- role: implementation
  path: changes/change-20260904-remote-working-view-abort/implementation.md
  required: true
- role: verification
  path: changes/change-20260904-remote-working-view-abort/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: conformsTo, target: design-four-stage-sync-pipeline}
source_paths:
- src/fs/interface.ts
- src/fs/caching/remote-fs.ts
- src/sync/orchestrator.ts
- src/sync/sync-cycle-finalization.ts
- tests/fs/contracts/caching-remote-fs.contract.ts
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md
- docs/adr/0008-logical-identity-admission-fails-closed.md
summary: Replace same-session cold-recovery memory with checkpoint-owned discard/reload
  of uncommitted remote working views.
updated: '2026-09-04'
---

## Summary

This change replaces the history-dependent `recoverViaColdScan` branch with an explicit
lifecycle operation on the object that owns the uncommitted remote cursor/cache view. A
wholly clean cycle atomically commits the complete remote projection; every returned or
exceptional incomplete cycle awaits a live-only abort before retry or return. The next
attempt therefore reconstructs from the prior durable checkpoint and current facts through
the ordinary COLD, WARM, or HOT path.

The executor establishes the discard fence: both existing cycle-fatal classes invalidate
queued work, all already scheduled siblings settle, and the exact rejection selected by the
existing `Promise.all` is rethrown unchanged. No state, schema, migration, recovery ledger,
or replacement orchestrator field is introduced. ADR 0001 is revised in place; provider
verification remains one observable contract shared by Google Drive, Dropbox, and OneDrive.

## Closure Notes
