---
id: adr-20260831-admission-owns-identity-component-decisi
kind: adr
title: Admission owns identity-component decision
summary: Keep path-local proposal separate while one cycle-local Admission owner shapes
  and authorizes every identity-connected component.
status: accepted
created: '2026-08-31'
decision_makers:
- user
tags:
- sync
- architecture
- rename
owners: []
relations:
- {type: partOf, target: change-20260831-sync-decision-resource-components}
source_paths:
- src/sync/plan-admission.ts
- src/sync/plan-admission-graph.ts
- src/sync/identity-component-decision.ts
- src/sync/sync-cycle-planning.ts
consequences:
  positive:
  - Cross-path action shaping, authorization, disposition, and lifecycle membership
    can no longer disagree across stages.
  - One bounded cycle-local component partition makes incomplete identity evidence
    fail closed without a persistent graph.
  negative:
  - PlanAdmission must retain the complete outcome table and its discriminating tests
    as one cohesive policy boundary.
  neutral:
  - AuthorizedSyncPlan, executor ordering, provider interfaces, SyncState v6, and
    commit-last finalization remain unchanged.
confirmation: Lint keeps Admission internals pure and private; focused Admission,
  convergence, crash-safety, and provider contract tests plus the full project gate
  verify the boundary.
updated: '2026-09-01'
---

# Admission owns identity-component decision

## Context

The path-local `planSync()` table is a stable compatibility boundary, but a rename or
stable identity relates more than one path. The former pipeline shaped those relations
in a standalone whole-plan `refinePlan()` pass and then rebuilt their connected
components in Admission. That divided one safety decision between two owners and made
action shape, destructive authorization, disposition, and local debt membership able
to drift independently.

The filesystem boundary already supplies the required provider-neutral facts:
producer-qualified path authority, opaque same-root identity, reported rename edges,
and post-delta snapshots. No provider-specific sync policy or broader interface is
required.

## Decision

- `planSync()` remains the sole path-local proposal owner. It consumes no rename
  evidence and emits at most one ordinary action per path in input order.
- PlanAdmission consumes one immutable cycle snapshot and builds one exhaustive,
  cycle-local identity-component partition. It is the sole owner of component-local
  action shaping, destructive authorization, disposition, and local rename lifecycle
  membership.
- Each relevant component produces exactly one `authorized`, `resolved_no_action`, or
  `deferred` outcome. Missing, conflicting, multiply applicable, or incomplete proof
  selects deferral; execution never chooses a fallback.
- Native local rename shaping retains the baseline/hash proof. Native remote rename
  shaping retains the backend-reported edge and opaque same-root identity proof.
  Folder mappings must be complete and destination occupancy must be safe.
- A fresh proved additive local report creates no debt. An already loaded matching v6
  debt may be released only after its proved no-action or additive consequence and a
  clean checkpoint. Safety-binding local candidates are persisted before I/O and
  released only after their successful consequence and checkpoint.
- The standalone `refinePlan` stage and module are retired. Local and remote shaping
  helpers are private implementation details of Admission, not independently callable
  whole-plan policy stages.
- Component state is never persisted. Construction is deterministic, uses linear
  auxiliary memory, and performs one sort plus bounded union/find and prefix-index
  work; there is no per-outcome rebuild or provider branch.
- `AuthorizedSyncPlan`, executor phases, SyncState v6 `RenameDebt`, provider
  interfaces, and checkpoint-before-retirement remain unchanged.

## Rejected alternatives

- Move rename semantics into `planSync()`. This would mix path-local comparison with
  cross-path identity proof and destabilize the published table.
- Keep `refinePlan()` as a trusted pre-authorization pass. This preserves two semantic
  owners and permits action/lifecycle disagreement.
- Let Admission call provider-specific fallback code. Backend differences belong
  behind `IFileSystem` and its shared behavior contracts.
- Introduce a general or persisted resource graph. The required relation is bounded to
  one immutable cycle and does not justify new durable state.
- Let the executor retry a rejected native rename as delete plus transfer. Runtime
  failure is not identity proof.

## Consequences

{% consequence kind="positive" %} Cross-path action shaping, authorization, disposition, and lifecycle membership now come from one component result. {% /consequence %}

{% consequence kind="positive" %} Identity uncertainty remains local to its connected component while disconnected ordinary proposal order is preserved. {% /consequence %}

{% consequence kind="negative" %} PlanAdmission is a high-value policy boundary whose outcome table and complexity constraints require focused regression tests. {% /consequence %}

{% consequence kind="neutral" %} Provider contracts, executor ordering, SyncState v6, and commit-last finalization do not change. {% /consequence %}

{% consequence kind="neutral" %} This decision neither attributes nor claims to fix any blank-file symptom. {% /consequence %}

## Confirmation

Run the focused Admission, convergence, crash-safety, delete-safety, and
three-provider shared contract suites; verify production has one component builder
call and no `refinePlan` import; then run `npm run lint`,
`npm run lint:bot-repro`, `npm run build`, and `npm test`.


{% transition from="proposed" to="accepted" date="2026-08-31" %}
Implemented and verified as the single Admission-owned identity-component boundary.
{% /transition %}
