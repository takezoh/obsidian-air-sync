---
id: change-20260831-issue51-rename-evidence-lifecycle
kind: change
title: Repair rename evidence ownership and lifecycle
summary: Move local rename durability decisions into Admission and safely converge
  existing false v6 debt without weakening fail-closed sync.
status: active
created: '2026-08-31'
profile: sdd@1
intent: Restore convergence for never-synchronized local renames by moving durable
  rename-constraint promotion into Admission without weakening fail-closed destructive
  authorization.
outcomes:
- Fresh unbaselined local renames can execute their terminal additive push without
  permanent rename_mismatch deferral or new debt.
- Existing false SyncState v6 debt converges without manual reset and is retired only
  after successful admitted progress and a clean checkpoint.
- Genuine or ambiguous synchronized-resource renames retain pre-I/O crash evidence
  and fail closed.
scope:
- src/sync/change-detector.ts — local rename candidate acquisition.
- src/sync/path-observation.ts — authoritative opposite-side endpoint confirmation.
- src/sync/identity-evidence.ts — immutable Admission proof projection.
- src/sync/types.ts — local rename candidate type contract.
- src/sync/sync-cycle-planning.ts — cycle snapshot and lifecycle membership wiring.
- src/sync/cycle-admission-snapshot.ts — immutable Admission input capture.
- src/sync/plan-admission.ts — Admission-owned classification and lifecycle output.
- src/sync/plan-admission-graph.ts — fail-closed component evaluation.
- src/sync/local-rename-admission.ts — pure additive proof and lifecycle partition.
- src/sync/rename-debt.ts — unchanged v6 persistence carrier.
- src/sync/state.ts — v6 debt storage contract.
- src/sync/orchestrator.ts — pre-I/O persistence ordering.
- src/sync/sync-cycle-finalization.ts — mechanical consequence-bound retirement.
- src/sync/orchestrator.test.ts — lifecycle ordering and false-debt convergence regressions.
- src/sync/plan-admission.test.ts — additive whitelist and fail-closed counterexamples.
- src/sync/rename-debt.test.ts — mechanical persistence-carrier contract tests.
- docs/code-enforcement.md — documented orchestrator cap matching the cohesive pre-I/O
  cut point.
- eslint.config.mts — ratcheted orchestrator line cap for the visible pre-I/O cut
  point.
- docs/adr/adr-20260831-admission-owned-local-rename-constraint-lifecycle.md — accepted
  responsibility decision.
non_goals:
- Proving or fixing the Issue 51 blank-file symptom without second-device runtime
  evidence.
- Rolling back or redesigning unrelated files from ff87f7d.
- Adding a general identity graph, persistent lifecycle state machine, schema migration,
  or manual reset.
change_classes:
- behavior
- responsibility
- boundary
- invariant
- internal_design
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260831-issue51-rename-evidence-lifecycle/requirements.md
  required: true
- role: implementation
  path: changes/change-20260831-issue51-rename-evidence-lifecycle/implementation.md
  required: true
- role: verification
  path: changes/change-20260831-issue51-rename-evidence-lifecycle/verification.md
  required: true
promotion:
- target: none
  section: none
  action: none
  item: {}
  reason: The stable cross-component decision is owned by the accepted ADR; no separate
    top-level design document is introduced.
unresolved_decisions: []
tags:
- sync
- rename
- safety
owners: []
relations:
- {type: references, target: adr-20260825-issue43-destructive-authorization}
- {type: introduces, target: adr-20260831-admission-owned-local-rename-constraint-lifecycle}
- {type: references, target: adr-20260831-admission-owns-identity-component-decisi}
source_paths:
- src/sync/change-detector.ts
- src/sync/path-observation.ts
- src/sync/identity-evidence.ts
- src/sync/types.ts
- src/sync/sync-cycle-planning.ts
- src/sync/cycle-admission-snapshot.ts
- src/sync/plan-admission.ts
- src/sync/plan-admission-graph.ts
- src/sync/local-rename-admission.ts
- src/sync/rename-debt.ts
- src/sync/state.ts
- src/sync/orchestrator.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/orchestrator.test.ts
- src/sync/plan-admission.test.ts
- src/sync/rename-debt.test.ts
- eslint.config.mts
- docs/code-enforcement.md
updated: '2026-09-01'
---

## Summary

Issue #51 exposed a responsibility split introduced in 0.1.42: planning converts every
local rename report into durable debt before Admission has established that the edge
can affect a synchronized resource. Admission then correctly rejects the push-only plan
as a rename mismatch, and commit-last Finalization correctly retains the deferred debt,
creating a permanent loop.

This change makes Admission the sole promotion owner. Collection supplies one fixed
immutable proof projection; the orchestrator persists exactly Admission's retained
membership before I/O; Finalization retires exact release membership only after its
corresponding consequence and checkpoint succeed. Existing v6 rows are replayed as
candidates and re-evaluated from fresh authoritative facts. The stored wire shape and
schema remain unchanged.

The follow-on identity-component decision redesign keeps this exact debt lifecycle
contract. It removes the separate whole-plan optimizer and makes the same Admission
outcome select action shaping, disposition, and lifecycle membership together; it does
not broaden retirement or change the persisted v6 representation.

## Closure Notes

Implementation now follows the accepted Admission-owned lifecycle boundary. Focused
red/green and mutation witnesses distinguish the false additive case from remote
occupancy, baseline, unknown-scope, folder, and destructive counterexamples. The full
repository gate passes; the separate blank-file symptom remains outside this change.
