---
id: change-20260831-sync-decision-resource-components
kind: change
title: Unify sync decision around resource components
status: active
created: '2026-08-31'
profile: sdd@1
intent: Replace the plan-then-optimize-then-revalidate pipeline with one explicit
  identity-component decision owner while preserving path-local proposal behavior,
  destructive safety, crash recovery, and backend-neutral contracts.
outcomes:
- PlanAdmission alone shapes cross-path rename actions, authorizes destructive work,
  assigns component dispositions, and selects exact rename lifecycle membership.
- Each cycle constructs identity components once and no longer has a standalone refinePlan
  or a second Admission component build.
- Provider differences remain behind IFileSystem shared behavior contracts, with targeted
  live verification only when concrete evidence suggests an interface gap.
scope:
- src/sync/ proposal-to-Admission boundary, component outcomes, lifecycle wiring,
  diagnostics, and structural enforcement.
- src/fs/ shared provider faithful-fake and interface conformance.
- e2e/ targeted opt-in live evidence only when a concrete backend representation gap
  is suspected.
- ARCHITECTURE.md persistent sync decision responsibility boundary.
- docs/sync-pipeline.md pipeline and lifecycle documentation.
- docs/adr/ accepted Admission ownership decision and reconciled ownership text.
- eslint.config.mts Admission-private import and pure-transform enforcement.
- docs/code-enforcement.md structural enforcement documentation.
- docs/error-handling.md pipeline error-boundary documentation.
- docs/changes/change-20260831-issue51-rename-evidence-lifecycle/change.md compatibility
  note for the retained debt lifecycle contract.
- docs/changes/change-20260825-issue43-destructive-authorization/change.md compatibility
  review for observational-only planning diagnostics.
non_goals:
- Changing SyncState v6, RenameDebt wire shape, checkpoint formats, or executor ordering.
- Introducing provider-specific sync policy, a persistent resource graph, or a general
  sync compiler.
- Claiming that the redesign fixes the unmeasured Issue
change_classes:
- responsibility
- boundary
- invariant
- internal_design
governance:
  gate: hard
  reasons:
  - Changes the persistent responsibility boundary between path proposal, rename shaping,
    destructive Admission, execution, and lifecycle finalization.
  - Narrows the standalone optimizer consequence of accepted ADR 0008 while preserving
    its evidence and fail-closed invariants.
  approval_evidence: consultation-sync-decision-resource-components-adr
members:
- role: requirements
  path: changes/change-20260831-sync-decision-resource-components/requirements.md
  required: true
- role: implementation
  path: changes/change-20260831-sync-decision-resource-components/implementation.md
  required: true
- role: verification
  path: changes/change-20260831-sync-decision-resource-components/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags:
- sync
- architecture
- decision
owners: []
relations: []
source_paths:
- src/sync/change-detector.ts
- src/sync/decision-engine.ts
- src/sync/rename-optimizer.ts
- src/sync/optimize-local-renames.ts
- src/sync/optimize-remote-renames.ts
- src/sync/scope-projection.ts
- src/sync/plan-admission.ts
- src/sync/plan-admission-graph.ts
- src/sync/cycle-admission-snapshot.ts
- src/sync/local-rename-admission.ts
- src/sync/sync-cycle-planning.ts
- src/sync/orchestrator.ts
- src/sync/plan-executor.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/identity-component-decision.ts
- eslint.config.mts
- docs/code-enforcement.md
- docs/error-handling.md
- docs/changes/change-20260831-issue51-rename-evidence-lifecycle/change.md
summary: Replace plan-then-optimize-then-revalidate with one component decision boundary
  while preserving crash and destructive-safety invariants.
updated: '2026-08-31'
---

## Summary

Keep the existing path-local decision table and executor/finalizer contracts, but make
PlanAdmission the single owner of identity-connected action shaping and authorization.
The accepted plan removes standalone `refinePlan`, constructs components once, and
uses an exhaustive fail-closed outcome table with exact v6 debt membership.

## Closure Notes

Cold-cycle checksum enrichment now exposes its candidate and successful-match counts in
the existing change-detection diagnostic event. This is observational only: acquisition
owns the measurement, while Decision and Admission remain unchanged. The integration
witness also preserves the user notification count for successful `match` actions.


{% transition from="draft" to="ready" date="2026-08-31" %}
design-plan-approved
{% /transition %}


{% transition from="ready" to="active" date="2026-08-31" %}
unit-delivery-started
{% /transition %}
