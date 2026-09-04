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
- Every cycle resolves stale case aliases from current component facts, with the same
  Admission result for COLD, WARM, and HOT acquisition.
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
- src/sync/change-detector.ts — observation-only case-alias facts and hash enrichment
- src/sync/change-hash-enrichment.ts — content facts for observed case aliases
- src/sync/case-alias-admission.ts — fact-only case-alias component normalizer
- src/sync/case-alias-planning.ts — case-alias executor protocol helpers
- src/sync/current-state-case-rename.ts — remove Observation-side rename inference
- src/sync/plan-admission-graph.ts — carry fact entries into each Admission component
- src/sync/local-rename-admission.ts — typed component normalization and exhaustive decision
- src/sync/plan-admission.ts — sole case-alias authorization owner
- src/sync/plan-executor.ts — pre-effect and terminal proof before SyncRecord commit
- src/sync/types.ts — restrict rename evidence authority to reported events
- src/sync/change-detector.test.ts — positive and differing-content counterexamples
- src/sync/plan-admission.test.ts — complete-proof and forged-proof boundary tests
- src/sync/plan-executor.test.ts — content-race non-commit regression
- sync-state-ownership-guard.test.mjs — closed state-owner inventory
- package.json — required guard wiring
- eslint.config.mts — guard lint admission
- AGENTS.md — repository operating rule
- ARCHITECTURE.md — LocalFs and initial-state reconstruction boundary
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md — governing decision
- docs/adr/0008-logical-identity-admission-fails-closed.md — current-fact canonicalization rationale
- docs/adr/adr-20260903-stateless-current-state-recovery.md — schema invalidation boundary
- docs/adr/adr-20260831-admission-owned-local-rename-constraint-lifecycle.md — mark superseded by stateless recovery
- docs/adr/adr-20260831-admission-owns-identity-component-decisi.md — component-fact decision invariant
- docs/adr/adr-20260902-fresh-state-reconciliation-for-rename-edits.md — baseline-backed alias classification
- docs/adr/adr-20260903-four-stage-sync-pipeline.md — stage boundary invariant
- docs/adr/adr-issue43-destructive-authorization.md — fact-only snapshot and explicit protocol
- docs/design/design-four-stage-sync-pipeline.md — persistent responsibility rule
- docs/changes/change-20260825-issue43-destructive-authorization/change.md — nominal-plan compatibility review
- docs/changes/change-20260901-admission-priority-pull/change.md — priority boundary compatibility review
- docs/code-enforcement.md — mechanical enforcement contract
non_goals:
- Rename inference in Observation or decisions based on cycle temperature/whole-store state
- New Admission status, persisted relation, or recovery state
- SyncRecord migration or stopped-state/error-specific recovery logic
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
- src/sync/change-hash-enrichment.ts
- src/sync/case-alias-admission.ts
- src/sync/case-alias-planning.ts
- src/sync/current-state-case-rename.ts
- src/sync/plan-admission-graph.ts
- src/sync/local-rename-admission.ts
- src/sync/plan-admission.ts
- src/sync/plan-executor.ts
- src/sync/types.ts
- AGENTS.md
- docs/code-enforcement.md
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md
- docs/adr/0008-logical-identity-admission-fails-closed.md
- docs/adr/adr-20260903-stateless-current-state-recovery.md
- docs/adr/adr-20260831-admission-owned-local-rename-constraint-lifecycle.md
- docs/adr/adr-20260831-admission-owns-identity-component-decisi.md
- docs/adr/adr-20260902-fresh-state-reconciliation-for-rename-edits.md
- docs/adr/adr-20260903-four-stage-sync-pipeline.md
- docs/adr/adr-issue43-destructive-authorization.md
- docs/design/design-four-stage-sync-pipeline.md
- docs/changes/change-20260825-issue43-destructive-authorization/change.md
- docs/changes/change-20260901-admission-priority-pull/change.md
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
version 3 as version 4 and incompatible SyncState version 7 as version 8, and adds documentation plus
a source guard so new durable authorities or `SyncOrchestrator` fields cannot be
introduced silently. This one-time reset is schema invalidation, not a new recovery
state. Ordinary collection resolves case-colliding local index entries against the raw
adapter and records a cycle-local case-alias component. Admission alone authorizes an
explicit `case_alias_canonicalization`/`rename_remote` protocol after proving exact
endpoints, stat-authoritative target absence, unique remote identity, and equal
SHA-256/size. No result or intermediate relation is persisted, and the decision does
not depend on COLD/WARM/HOT acquisition, global record count, or a prior failure.

## Closure Notes
