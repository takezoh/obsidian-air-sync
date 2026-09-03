---
change: change-20260903-stateless-sync-recovery
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

Each unit starts with the listed RED test, then makes only the production change needed
to turn it GREEN. Execute units in dependency order.

## U1 — Delete operation persistence surfaces

**RED:** In `src/sync/state.test.ts`, open a seeded v6 database containing debt and verify
the new schema cold-starts with only current sync record/content stores and exposes no
debt API. Add a static production-source absence guard.

**GREEN:** Remove `RenameDebt`, its IndexedDB store/CRUD, `src/sync/rename-debt.ts`, and
their tests; bump the state schema so project-standard cold-start removes the old store.
Remove the operation-marker-only `MetadataStore.setMeta/deleteMeta` API and bump its
schema as required to discard the old Dropbox marker. Preserve checkpoint `getMeta` and
transactional checkpoint writes.

**Files:** `src/sync/state.ts`, `src/sync/state.test.ts`,
`src/sync/rename-debt.ts`, `src/sync/rename-debt.test.ts`,
`src/store/metadata-store.ts`, `src/store/metadata-store.test.ts`.

## U2 — Make Observation and Admission cycle-local

**RED:** Add planning/Admission tests showing identical frozen current facts produce the
same output with no replayed/fresh key sets or rename lifecycle; add COLD case-only tests
for vacant target, same-id alias, foreign occupant, exact display casing, file, folder,
empty folder, and excluded-only folder.

**GREEN:** Remove carried debt inputs, replay/fresh classification,
`persistBeforeExecution`, `releaseAfterSafeCheckpoint`, and all opposing-debt
reconciliation. Keep tracker rename evidence only on the current snapshot. Add one pure
Observation helper that derives only an unambiguous case-folded old/new candidate from
baseline plus actual resolved local path and exact remote identity/casing facts.

**Files:** `src/sync/local-rename-admission.ts`,
`src/sync/sync-cycle-planning.ts`, `src/sync/sync-cycle-planning.test.ts`,
`src/sync/plan-admission.ts`, `src/sync/plan-admission.test.ts`,
`src/sync/change-detector.ts`, focused detector tests.

## U3 — Use one failure recovery loop

**RED:** Add orchestrator tests for effect failure followed by same-process retry,
restart retry, reverted rename no-op, rename+edit, simultaneous remote change, and
folder rename with an excluded system file. Assert no pre-effect state write and no
checkpoint on non-clean cycles. Add a retry test proving the immediately following sync
executes the same newly authorized action.

**GREEN:** Remove debt read/write/namespace/forced-scan/release wiring. Any non-clean
cycle sets invocation-local `recoverViaColdScan`; next run observes current state.
Remove `FailedActionTracker`, `isActionBlocked`, `onActionBlocked`, and their sole
`blocked` outcome/count/notification path. Preserve `superseded` for current-cycle
priority invalidation and preserve bounded provider retries.

**Files:** `src/sync/orchestrator.ts`, `src/sync/orchestrator.test.ts`,
`src/sync/failed-action-tracker.ts`, `src/sync/failed-action-tracker.test.ts`,
`src/sync/plan-executor.ts`, `src/sync/plan-executor.test.ts`,
`src/sync/execution-result.ts`, `src/sync/sync-notification.ts`,
`src/sync/sync-notification.test.ts`, `src/sync/sync-cycle-finalization.ts`,
`src/sync/sync-cycle-finalization.test.ts`.

## U4 — Settle Dropbox case-only rename inside one invocation

**RED:** Add backend tests for preflight collision, two-leg success, second-leg known
failure with verified rollback, lost success response at exact new, lost rollback
response at exact old, foreign/multiple/missing identity, observation failure, and a new
instance whose initialization performs zero moves and reads no pending marker.

**GREEN:** Delete `dropboxCaseRenamePending`, `PendingCaseRename`, pending-settled state,
startup recovery override, save/clear/resume/parser branches. Implement a small endpoint
classifier over old/new/temp using stable id and exact provider display path. Keep the
two moves and at most one rollback in `moveCaseOnly`; cache re-key occurs only after
verified exact-new success. Returned indeterminate errors leave cache untouched.

**Files:** `src/fs/dropbox/index.ts`, `src/fs/dropbox/index.test.ts`, Dropbox focused
contract fixtures where necessary.

## U5 — Conformance and documentation

**RED:** Extend design/static guards to reject production occurrences of `RenameDebt`,
`rename-debt`, `persistBeforeExecution`, `releaseAfterSafeCheckpoint`,
`dropboxCaseRenamePending`, `PendingCaseRename`, the marker mutation API, opposing-debt
reconciliation, and cross-cycle `blocked` quarantine.

**GREEN:** Update `ARCHITECTURE.md`, `docs/sync-pipeline.md`, and enforcement/e2e notes
to the current-state recovery invariant. Do not edit closed change packages; the new ADR
supersedes their active design authority.

Run focused tests after every unit, then the full gate:
`npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`.
Run Dropbox live E2E when credentials are available; otherwise record it as unverified.
