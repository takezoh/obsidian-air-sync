---
id: adr-20260825-issue43-destructive-authorization
kind: adr
title: Bind destructive execution to immutable Admission authority
summary: Freeze cycle inputs before Admission and make its nominal output the sole
  executable destructive plan.
status: accepted
created: '2026-08-25'
decision_makers:
- user
consulted: []
informed: []
relations:
- {type: originatedFrom, target: change-20260825-issue43-destructive-authorization}
source_paths:
- src/sync/sync-cycle-planning.ts
- src/sync/plan-admission.ts
- src/sync/plan-admission-graph.ts
- src/sync/plan-executor.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/orchestrator.ts
consequences:
  positive:
  - A proposal cannot reach the executor through supported typed production paths
    without Admission issuing permission from one stable input set.
  - Zero-action uncertainty is represented explicitly and remains visible, checkpoint-holding,
    and recoverable.
  negative:
  - Executor tests and callers must obtain authorized plans through Admission, increasing
    fixture setup at the safety boundary.
  - Snapshot and disposition types must evolve atomically across planning, execution,
    and finalization.
  neutral:
  - Existing RenameDebt, remote session evidence, SyncState v6, and Issue 46 backend
    ownership remain unchanged.
confirmation: Focused admission/orchestrator/finalization tests prove nominal executor
  input, snapshot stability, actionless deferral, strict pre-Admission recovery, and
  independent OneDrive/A-B evidence causality.
updated: '2026-09-01'
---

# Bind destructive execution to immutable Admission authority

## Context

ADR 0008 makes Admission the final owner of destructive admissibility, but the current
shape leaves two invalid states representable: zero-action evidence components can be
discarded, and the executor accepts a plain proposal type. Mutable settings or namespace
inputs between Admission and execution would also let one authorization be consumed
against a different projection. Issue #46 is a separate OneDrive/cache evidence-
production defect and cannot be proven by central exception-retention tests.

## Decision

The orchestrator captures one immutable cycle snapshot before Admission, containing the
refined proposal, existing normative evidence, observations, scope projection, and the
accepted backend/root namespace. Settings/root changes apply to a later snapshot, and
backend/root teardown remains serialized with in-flight execution.

Admission emits exactly one disposition for every relevant component, including those
with zero actions, and is the only constructor of an opaque/nominal
`AuthorizedSyncPlan`. The executor accepts only that carrier. Finalization consumes the
same snapshot's dispositions plus mechanical completion and cannot re-evaluate safety.

Actionless uncertainty is deferred, visible, checkpoint-holding, evidence-retaining,
and requests a later COLD cycle without a tight retry. Only an exception strictly before
Admission is treated by the orchestrator as evidence-acquisition recovery; it retains
already yielded remote evidence and requests COLD without fabricating authorization.

No lifecycle manager, persistent component graph, remote debt, or duplicate normative
evidence DTO is introduced. Issue #46 remains independently owned and verified at the
OneDrive backend/cache producer with its casing regression and an Admission-constant A/B
pipeline test.

## Rejected alternatives

- Keep `executePlan(SyncPlan)` and rely on call-site convention; this leaves admission bypass representable.
- Re-check settings/root version during execution; this creates mutable check/use semantics instead of keeping one in-flight input set stable.
- Persist authorization or a component lifecycle graph; existing bounded recovery carriers already provide crash/session recovery.
- Treat all zero-action components as resolved; unresolved observations would silently advance checkpoints.
- Fold Issue #46 cache repair into pre-Admission recovery; that confuses evidence omission with evidence retention.

## Consequences

The frontmatter records the normative positive, negative, and neutral consequences. The
implementation must compile planning, Admission, executor, orchestrator, and finalization
changes together; no persisted-data migration or Issue #46 implementation coupling is
introduced.
