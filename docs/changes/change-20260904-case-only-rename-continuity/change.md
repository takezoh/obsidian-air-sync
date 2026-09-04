---
id: change-20260904-case-only-rename-continuity
kind: change
title: Preserve case-only rename continuity across checkpoints
status: active
created: '2026-09-04'
profile: sdd@1
intent: Restore case-only rename continuity by returning cache persistence to ADR 0001's two-authority, commit-last model.
outcomes:
- Clean checkpoints persist the complete final remote metadata projection with the remote cursor.
- Successful admitted file I/O commits its SyncRecord independently at the file boundary.
- Existing affected vaults cold-start both persistence databases and rebuild from current facts.
- The closed authority set and reviewed SyncOrchestrator field inventory are mechanically guarded.
scope:
- src/fs/caching/remote-fs.ts — complete cache snapshot at clean checkpoint
- src/store/metadata-store.ts — metadata cache version 3 to 4 cold-start
- src/sync/state.ts — SyncState version 7 to 8 cold-start
- src/sync/state.test.ts — legacy path-identity reset regression
- src/fs/googledrive/index.test.ts — case-only rename restart regression
- src/store/metadata-store.test.ts — complete replace and version-upgrade contracts
- src/sync/orchestrator.test.ts — per-file SyncRecord and second-cycle convergence
- sync-state-ownership-guard.test.mjs — closed state-owner inventory
- package.json — required guard wiring
- eslint.config.mts — guard lint admission
- AGENTS.md — repository operating rule
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md — governing decision
- docs/adr/0008-logical-identity-admission-fails-closed.md — v8 baseline invalidation rationale
- docs/code-enforcement.md — mechanical enforcement contract
non_goals:
- New Admission or identity algorithm
- COLD relation reconstruction or additional recovery state
- SyncRecord migration or recovery-specific identity logic
- Broad cursor lifecycle or Orchestrator refactor
change_classes:
- behavior
- responsibility
- boundary
- invariant
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260904-case-only-rename-continuity/requirements.md
  required: true
- role: implementation
  path: changes/change-20260904-case-only-rename-continuity/implementation.md
  required: true
- role: verification
  path: changes/change-20260904-case-only-rename-continuity/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations: []
source_paths:
- src/fs/caching/remote-fs.ts
- src/store/metadata-store.ts
- src/sync/state-committer.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/orchestrator.ts
- AGENTS.md
- docs/code-enforcement.md
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md
- docs/adr/0008-logical-identity-admission-fails-closed.md
summary: Persist a complete subordinate remote cache only with a clean cursor checkpoint,
  cold-start affected persisted state once, and guard the exact two-authority boundary.
updated: '2026-09-04'
---

## Summary

The remote cursor and per-file `SyncRecord` are the only authoritative durable sync
states. A checkpoint is the operation that commits the cursor after a wholly clean
cycle, not a third state. The remote metadata cache is a replaceable projection and is
serialized completely in the same transaction as that cursor.

The repair removes `touchedPaths` and `pendingFullPersist`, cold-starts metadata cache
version 3 as version 4 and SyncState version 7 as version 8, and adds documentation plus
a source guard so new durable authorities or `SyncOrchestrator` fields cannot be
introduced silently. This one-time reset is schema invalidation, not a new recovery
state or identity decision.

## Closure Notes
