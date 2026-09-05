---
id: change-20260904-case-alias-parent-transition
kind: change
title: Unify case-alias parent postcondition proof in Admission
status: active
created: '2026-09-04'
profile: sdd@1
intent: A mixed-record case-only parent retry converges through one action-aware Admission
  postcondition proof under COLD, WARM, or HOT without special recovery or a new state
  owner.
outcomes:
- Candidate normalization cannot authorize or settle a component before the final
  evaluator.
- Only the exact unique current-to-committed-baseline occurrence edge for one opaque
  identity may use complete parent-rename coverage.
- Alias and stable-identity checks consume one linearly derived, cycle-local coverage
  relation.
- Existing current-fact retry, per-file commit, working-view abort, and clean-cycle
  checkpoint semantics remain unchanged.
scope:
- src/sync/plan-admission.ts — route every candidate through one final verdict.
- src/sync/identity-component-decision.ts — derive and consume exact topology coverage.
- src/sync/plan-admission-case-alias.ts — retain the existing candidate contract.
- src/sync/plan-admission-graph.ts — retain the existing component contract.
- src/sync/plan-admission.test.ts — proof-owner, exact-edge, and negative regressions.
- src/sync/orchestrator.test.ts — ordinary retry compatibility evidence.
- src/sync/plan-executor.test.ts — ordering compatibility evidence only.
- src/sync/state-committer.test.ts — per-file commit compatibility evidence only.
- src/sync/sync-cycle-finalization.test.ts — checkpoint compatibility evidence only.
- sync-state-ownership-guard.test.mjs — state-owner compatibility evidence only.
- docs/design/design-four-stage-sync-pipeline.md — persist the single-evaluator invariant.
- docs/adr/adr-20260831-admission-owns-identity-component-decisi.md — clarify current authority.
- docs/adr/adr-20260903-stateless-current-state-recovery.md — clarify stateless coverage proof.
non_goals:
- Provider or filesystem behavior changes.
- A recovery path, marker, debt, pending action, or prior-failure decision input.
- New action types, dispositions, failure reasons, executor scheduling, or durable/in-memory
  correctness owners.
- Schema, settings, or IndexedDB migration; generalized rename graphs; provider cleanup.
change_classes:
- behavior
- responsibility
- invariant
- internal_design
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
promotion:
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-006
    statement: Component-local normalization shapes a candidate only; every normalized
      component reaches exactly one action-aware Admission evaluator before exactly
      one disposition is emitted.
    enforcement: test
  reason: Persist the clarified single final postcondition owner so a pre-evaluator
    terminal branch cannot recur.
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: modifies, target: design-four-stage-sync-pipeline}
source_paths:
- src/sync/plan-admission.ts
- src/sync/plan-admission-case-alias.ts
- src/sync/plan-admission-graph.ts
- src/sync/identity-component-decision.ts
- src/sync/plan-admission.test.ts
- src/sync/orchestrator.test.ts
- src/sync/plan-executor.test.ts
- src/sync/state-committer.test.ts
- src/sync/sync-cycle-finalization.test.ts
- sync-state-ownership-guard.test.mjs
- docs/design/design-four-stage-sync-pipeline.md
- docs/adr/adr-20260831-admission-owns-identity-component-decisi.md
- docs/adr/adr-20260903-stateless-current-state-recovery.md
summary: Route every case-alias candidate through one final evaluator and recognize only
  exact complete current-to-baseline identity coverage with linear cycle-local work.
updated: '2026-09-04'
---

## Summary

The current Admission path can shape a complete child-content plus parent-rename candidate
and then either reject it through a second action-unaware proof or terminate from
`normalizeLocalMove` before the generic evaluator sees all component facts. The repair
routes every normalized candidate through one final evaluator. That evaluator derives one
validated coverage relation once and accepts a stable edge only for the exact unique
current occurrence to unique committed baseline occurrence of the same opaque identity.

The repair is cycle-local and backend-independent. Execution, provider behavior, per-file
commits, working-view abort, and checkpoint finalization remain unchanged. No new ADR,
state, action, status, reason, recovery instruction, or special retry path is introduced.

## Closure Notes
