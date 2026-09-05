---
id: change-20260905-fact-first-component-admission
kind: change
title: Fact-first component admission and one completion contract
status: closing
created: '2026-09-05'
profile: sdd@1
intent: Remove action-derived identity proofs and duplicated rename completion decisions
  while preserving stateless convergence and two durable authorities.
outcomes:
- Admission binds current identity and scope before constructing actions; identical
  complete COLD/WARM/HOT facts yield identical decisions without recovery state.
- Ordered components preserve versions and publish exact per-file records before suffix
  effects; only a fully closed clean cycle advances its checkpoint and acknowledges
  captured generations.
scope:
- sync-admission-authority-guard.test.mjs Enforce fact-only decision inputs and closed
  identity ownership.
- src/sync/ Fact-first Admission, ordered component execution, exact publication,
  scope compatibility and single cycle completion.
- docs/adr/adr-20260905-fact-first-component-admission.md Record the approved responsibility-contract
  revision.
- src/__mocks__/sync-test-helpers.ts Mirror exact transactional publication contracts
  in the existing filesystem/store test seam.
- src/fs/onedrive/incremental-sync.test.ts Migrate the dependent ScopeProjection fixture
  to the required captured query contract without changing backend behavior.
- sync-state-ownership-guard.test.mjs Keep the existing writer inventory closed across
  exact CAS methods and destructured store references.
- docs/code-enforcement.md Document exact publication writer detection without adding
  allowed owners.
- AGENTS.md Enforce the accepted fact-first and ordered component contract.
- ARCHITECTURE.md Describe the accepted four-stage responsibilities and publication
  ordering.
- docs/design/design-four-stage-sync-pipeline.md Promote the accepted invariant and
  boundary revisions.
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md Reaffirm two durable
  authorities and supersede obsolete scheduler assumptions.
non_goals:
- No new durable state, in-memory correctness owner, recovery mode, schema bump, backend
  rewrite, or UI policy.
change_classes:
- responsibility
- boundary
- invariant
- behavior
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260905-fact-first-component-admission/requirements.md
  required: true
- role: implementation
  path: changes/change-20260905-fact-first-component-admission/implementation.md
  required: true
- role: verification
  path: changes/change-20260905-fact-first-component-admission/verification.md
  required: true
promotion:
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-003
    statement: A cycle is clean only after every exact admitted obligation has successful
      terminal publication and the working view closes once. Sibling effects settle
      before commit or abort; incomplete attempts abort before classification or retry.
      Only clean completion acknowledges captured tracker generations.
    enforcement: test
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-004
    statement: Configured-scope projection removes excluded metadata and identity
      edges before BatchObservation. Every relation uses the same immutable cycle-local
      pure scope compatibility query; it performs no I/O and cannot bind identity
      or authorize actions.
    enforcement: test
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-006
    statement: Admission binds current component identity, endpoints and committed
      baseline before subordinate content comparison and constructs ordered actions
      once. Actions and intended effects never serve as identity or completeness evidence.
    enforcement: contract
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-007
    statement: Admission selects one authority family from current component facts
      and emits exactly one disposition. Coherent reports precede aliases; unresolved
      claims have no weaker-family fallback. A report is already satisfied only when
      its current endpoints and identity claims are positively accounted for.
    enforcement: contract
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-009
    statement: Execution preserves component order through each action's terminal
      publication; failure blocks the suffix. Independent singleton transfers and
      same-key matches may pool, but all pool and active priority effects settle before
      the globally serial component interval, throughout which new priority effects
      are deferred.
    enforcement: test
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-010
    statement: Publication compares exact admitted source and destination records
      atomically; storage does not choose identity replacement policy. Parent publication
      consumes existing successful child receipts, not a second registry. Concurrent
      records and incompatible merge bases are protected by the same transaction.
    enforcement: test
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-011
    statement: 'Sync has exactly two durable authorities: successful per-file SyncRecords
      and the wholly clean-cycle remote cursor. Metadata cache and scope are derived
      final snapshots committed atomically with that cursor. Do not persist intent,
      evidence, failures or recovery instructions, or introduce another retained in-memory
      correctness owner.'
    enforcement: contract
- target: design-four-stage-sync-pipeline
  section: boundaries.forbidden
  action: upsert
  item:
    id: BOUNDARY-007
    statement: Independent identity-policy stages, action-first normalization or repair
      APIs, action-bearing observations, and correctness proofs retained at module
      scope or across calls are forbidden.
- target: design-four-stage-sync-pipeline
  section: boundaries.forbidden
  action: upsert
  item:
    id: BOUNDARY-008
    statement: Conflict resolution cannot mutate originals or select separate ordinary
      and rename execution routes. One capture and policy-required preservation contract
      precedes executor-owned effects, source revalidation, terminal proof and publication.
      Newly arriving destinations are precondition failures, never deletion authority;
      interrupted work is re-observed without compensating recovery state.
- target: design-four-stage-sync-pipeline
  section: relations
  action: upsert
  item:
    type: references
    target: adr-20260905-fact-first-component-admission
evidence_refs:
- type: test
  ref: src/sync/fact-first-execution.test.ts
- type: test
  ref: src/sync/plan-admission.test.ts
- type: test
  ref: src/sync/sync-cycle-finalization.test.ts
- type: test
  ref: sync-state-ownership-guard.test.mjs
- type: source
  ref: docs/changes/change-20260905-fact-first-component-admission/verification.md
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: modifies, target: design-four-stage-sync-pipeline}
source_paths: []
summary: Design structural simplification of sync decisions without new correctness
  state or recovery paths.
updated: '2026-09-05'
promotion_applied_at: '2026-09-05T10:45:02.511599+00:00'
---

## Summary

Implemented the approved design to remove action-derived identity inference and independent cycle-completion decisions. See [design plan](design-plan/design.md) and [implementation progress](implementation.md). Obsolete action-first APIs and the separate ordinary-conflict execution route are removed; current-fact binding, ordered publication and sole finalization are implemented. Both independent code reviewers approved after regression repairs. Final command-gate evidence and design promotion remain separate from actual-vault acceptance. No recovery branch, schema reset, deployment or commit was introduced.

## Closure Notes

Not closed. The full post-review repository gate passed and persistent-design promotion was applied through the docs CLI. The user's one-time exception covers registration of the structured promotion data and its required verification references only. The accepted ADR and promoted design govern future changes, and guards enforce the production boundaries. The user subsequently reported successful actual-vault testing; matching-build log inspection confirmed 16 clean cycles without warnings or errors in the observed interval. See verification.md for acquisition modes, rename convergence and observation limits. PR integration and lifecycle closure remain separate; no merge is authorized by the request to update the PR.


{% transition from="draft" to="ready" date="2026-09-05" %}
User-approved revised design; independent design review and document conformance passed. Production implementation remains pending.
{% /transition %}


{% transition from="ready" to="active" date="2026-09-05" %}
Implementing the user-approved responsibility contracts; no deployment or commit.
{% /transition %}


{% transition from="active" to="closing" date="2026-09-05" %}
Code gate and independent review passed; user approved one-time direct registration of structured promotion data. Apply the accepted design; actual-vault acceptance remains pending, so do not close as done.
{% /transition %}
