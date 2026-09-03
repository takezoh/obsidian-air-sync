---
id: design-four-stage-sync-pipeline
kind: design
title: Four-stage sync pipeline responsibilities
status: active
created: '2026-09-03'
scope_type: area
responsibilities:
- id: RESP-001
  statement: Observation acquires and freezes local, remote, baseline, scope, and
    namespace facts without constructing actions.
- id: RESP-002
  statement: Admission alone constructs exact actions, resolves identity topology
    and conflict policy, and authorizes a plan.
- id: RESP-003
  statement: Execution performs only authorized effects and reports exact outcomes
    without rerouting.
- id: RESP-004
  statement: Commit and finalization persist only proven terminal outcomes and advance
    checkpoint state last.
invariants:
- id: INV-001
  statement: No executable action exists before Admission.
  enforcement: conformance
- id: INV-002
  statement: Every executed action belongs to the exact AuthorizedSyncPlan for the
    cycle.
  enforcement: contract
- id: INV-003
  statement: A checkpoint advances only after all admitted actions are terminal under
    finalization policy.
  enforcement: test
- id: INV-004
  statement: Configured path and effective mobile-size filtering removes excluded
    paths and cross-scope identity edges before BatchObservation; LocalChangeTracker,
    Admission, and later stages cannot observe or branch on them.
  enforcement: test
boundaries:
  provides:
  - id: BOUNDARY-001
    statement: Fact-only BatchObservation input and exact AuthorizedSyncPlan output.
  consumes:
  - id: BOUNDARY-002
    statement: Committed baseline, current change-detection facts, identity evidence,
      observations, scope, and namespace.
  forbidden:
  - id: BOUNDARY-003
    statement: Observation importing or invoking action decision helpers.
  - id: BOUNDARY-004
    statement: Execution inventing, replacing, or rerouting actions.
  - id: BOUNDARY-005
    statement: Finalization inferring success from listing absence or partial completion.
  - id: BOUNDARY-006
    statement: BatchObservation carrying an excluded path, excluded-path disposition,
      or identity edge with an excluded endpoint.
variability:
  fixed:
  - id: FIXED-001
    statement: The four top-level responsibility owners and their dependency direction.
  - id: FIXED-002
    statement: Admission ownership of identity topology, conflict, and destructive
      action selection.
  free:
  - id: FREE-001
    statement: Private helper layout inside a layer when dependency direction remains
      unchanged.
capabilities:
- id: cap:batch-observation
  uniqueness: per-boundary
- id: cap:action-admission
  uniqueness: per-boundary
- id: cap:effect-execution
  uniqueness: per-boundary
- id: cap:terminal-commit
  uniqueness: per-boundary
failure_responsibilities:
- id: FAILURE-001
  statement: Observation failures abort before authorization.
- id: FAILURE-002
  statement: Admission ambiguity fails closed with no executable destructive action.
- id: FAILURE-003
  statement: Execution failures remain exact per-action outcomes.
- id: FAILURE-004
  statement: Finalization withholds the checkpoint for nonterminal outcomes and writes
    no recovery instruction.
trust_boundaries:
- id: TRUST-001
  statement: Remote and local filesystem observations are untrusted facts until Admission
    binds them into an authorized plan.
compatibility_policies:
- id: COMPAT-001
  statement: Preserve provider calls, checkpoint schema, conflict policy, priority
    semantics, and user-visible sync outcomes.
tags: []
owners: []
relations: []
source_paths:
- src/sync/sync-cycle-planning.ts
- src/sync/plan-admission.ts
- src/sync/plan-executor.ts
- src/sync/sync-cycle-finalization.ts
summary: Current responsibility and dependency boundaries for the four-stage sync
  pipeline.
---

## Purpose

Keep the sync engine structurally convergent by assigning every normal-cycle decision to one of four owners. The split is a dependency rule, not a naming exercise: facts flow forward, and executable authority begins only at Admission.

## Responsibilities

The pipeline is `Observation -> Admission -> Execution -> Commit/finalization`.

- Observation owns acquisition and a cut-consistent immutable carrier.
- Admission owns path-local proposal logic as a private helper, identity-component decisions, conflict policy, and exact authorization.
- Execution owns ordering and I/O for the authorized actions only.
- Commit/finalization owns per-action state publication, completion proof, and checkpoint commit-last.

## Boundaries

`BatchObservation` contains facts, never `SyncPlan` or another action carrier. `AuthorizedSyncPlan` can be created only by Admission. Execution and finalization consume that exact object and cannot call decision helpers.

Configured-scope filtering is the entrance to this boundary. Paths rejected by that
filter, observations that disclose them, and identity edges with an excluded endpoint
must be removed before `BatchObservation` is constructed. Admission and later stages
have no excluded-path disposition and cannot let an excluded physical entry affect a
sync decision.

## Invariants

Rename plus content change on one side is ordinary evidence and converges to the new path and content. A conflict exists only when both sides changed incompatibly from the same baseline. Structural ambiguity fails closed before destructive I/O.

## Collaboration

The orchestrator sequences the four owners but owns none of their policy. The existing priority coordinator is a scheduling mechanism inside Execution; it is not a fifth decision stage.

## Failure Responsibility

Observation and Admission failures abort before effects. Execution records exact failures. Finalization alone decides whether completion is sufficient to advance the checkpoint. A failure preserves the prior committed baseline/checkpoint and persists no operation intent.

## Variability

Private names and helper placement may change. The four owners, action-authority boundary, exact-plan consumption, and commit-last rule may not.

## Conformance

ESLint prevents production modules outside Admission from importing the path-local decision helper. Unit tests verify the fact-only carrier and exact plan behavior. The repository gate verifies lint, Dashboard reproduction, build, and coverage.

## Related Decisions

- `adr-20260903-four-stage-sync-pipeline`
- `adr-20260831-admission-owns-identity-component-decisi`
- `adr-20260902-fresh-state-reconciliation-for-rename-edits`
