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
- COLD observation removes stale case aliases from the vault index and Admission authorizes
  baseline-free case-only convergence only from complete current-state proof.
- The closed authority set and reviewed SyncOrchestrator field inventory are mechanically guarded.
scope:
- src/fs/caching/remote-fs.ts — complete cache snapshot at clean checkpoint
- src/store/metadata-store.ts — metadata cache version 3 to 4 cold-start
- src/sync/state.ts — SyncState version 7 to 8 cold-start
- src/sync/state.test.ts — legacy path-identity reset regression
- src/fs/googledrive/index.test.ts — case-only rename restart regression
- src/store/metadata-store.test.ts — complete replace and version-upgrade contracts
- src/sync/orchestrator.test.ts — per-file SyncRecord and second-cycle convergence
- src/fs/local/index.ts — discard stale case aliases only after raw-adapter resolution
- src/fs/local/dot-path-adapter.ts — authoritative segment-wise actual-casing resolution
- src/fs/local/dot-path-adapter.test.ts — adapter casing-resolution regression
- src/fs/local/local-fs.test.ts — stale-alias and genuine case-sensitive collision regressions
- src/__mocks__/obsidian.ts — root adapter listing fidelity
- src/sync/change-detector.ts — cycle-local baseline-free case-only evidence acquisition
- src/sync/current-state-case-rename.ts — isolated current-state casing inference
- src/sync/local-rename-admission.ts — strict current-fact validation and action shaping
- src/sync/plan-admission.ts — Admission-owned baseline-free rename authorization
- src/sync/plan-executor.ts — pre-effect and terminal proof before SyncRecord commit
- src/sync/change-detector.test.ts — positive and differing-content counterexamples
- src/sync/plan-admission.test.ts — complete-proof and forged-proof boundary tests
- src/sync/plan-executor.test.ts — content-race non-commit regression
- sync-state-ownership-guard.test.mjs — closed state-owner inventory
- package.json — required guard wiring
- eslint.config.mts — guard lint admission
- AGENTS.md — repository operating rule
- ARCHITECTURE.md — LocalFs and cycle-local recovery boundary
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md — governing decision
- docs/adr/0008-logical-identity-admission-fails-closed.md — v8 baseline invalidation rationale
- docs/adr/adr-20260903-stateless-current-state-recovery.md — schema invalidation boundary
- docs/code-enforcement.md — mechanical enforcement contract
non_goals:
- General baseline-free rename inference
- New Admission status, persisted relation, or recovery state
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
- src/fs/local/index.ts
- src/sync/change-detector.ts
- src/sync/current-state-case-rename.ts
- src/sync/local-rename-admission.ts
- src/sync/plan-admission.ts
- src/sync/plan-executor.ts
- AGENTS.md
- docs/code-enforcement.md
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md
- docs/adr/0008-logical-identity-admission-fails-closed.md
- docs/adr/adr-20260903-stateless-current-state-recovery.md
summary: Restore complete checkpoint projection, cold-start incompatible path identity,
  and safely reconverge stale case aliases from cycle-local proof under Admission.
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
state. Because an already-opened v8 vault no longer has a baseline, `LocalFs` resolves
case-colliding index entries against the raw adapter and Observation may emit one
cycle-local case-only rename candidate. Admission alone converts the ordinary
`pull(old)+push(new)` proposal to `rename_remote` after independently proving exact
endpoints, stat-authoritative target absence, unique remote identity, and equal
SHA-256/size. No result or intermediate relation is persisted.

## Closure Notes
