---
id: change-20260904-case-alias-parent-transition
kind: change
title: Normalize case-alias parent transitions at existing sync boundaries
status: active
created: '2026-09-04'
profile: sdd@1
intent: A mixed-content case-only folder rename converges through ordinary COLD, WARM,
  or HOT acquisition without requested-path cache corruption, special recovery, or
  a new state owner.
outcomes:
- Requested path echoes never re-key provider topology.
- Admission preserves child content work and emits one parent folder rename.
- Existing content-before-structural execution and clean-cycle checkpoint semantics
  remain unchanged.
scope:
- src/fs/ — cache-backed Google Drive, Dropbox, and OneDrive mutation path resolution.
- src/sync/ — Observation and Admission shaping plus exact endpoint execution and
  commit.
- tests/fs/ — shared backend-contract fixtures for provider-resolved mutation paths.
- eslint.config.mts — Admission-private pure-helper enforcement.
- AGENTS.md — repository operating rule for requested-path authority.
- ARCHITECTURE.md — filesystem and Admission boundary documentation.
- docs/adr/ — accepted state and identity decisions clarified for this invariant.
- docs/code-enforcement.md — test-pinned recurrence rule.
non_goals:
- A recovery path for any previously persisted failure state.
- New action types, Admission dispositions, executor scheduling, or durable/in-memory
  correctness state.
- Migration of existing IndexedDB records; the ordinary schema cold-start policy remains
  authoritative.
change_classes:
- behavior
- boundary
- invariant
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260904-case-alias-parent-transition/requirements.md
  required: true
- role: implementation
  path: changes/change-20260904-case-alias-parent-transition/implementation.md
  required: true
- role: verification
  path: changes/change-20260904-case-alias-parent-transition/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations: []
source_paths:
- src/sync/plan-admission.ts
- src/sync/plan-admission-case-alias.ts
- src/sync/plan-admission-graph.ts
- src/sync/identity-component-decision.ts
- src/sync/change-detector.ts
- src/sync/path-observation.ts
- src/sync/plan-executor.ts
- src/sync/state-committer.ts
- src/fs/caching/metadata-cache.ts
- src/fs/googledrive/index.ts
- src/fs/dropbox/index.ts
- src/fs/dropbox/metadata-cache.ts
- src/fs/onedrive/index.ts
summary: Resolve provider paths from provider facts and normalize a complete case-only
  folder component into child content work followed by one parent rename.
updated: '2026-09-04'
---

## Summary

The defect crossed two existing boundaries. Remote adapters accepted caller spelling as
provider topology during writes, while Admission left a single parent casing transition
represented as independent child actions. The repair makes provider-returned topology
authoritative at the filesystem boundary and makes Admission decide the complete parent
component. Execution, per-file commits, and checkpoint finalization remain unchanged.

## Closure Notes
