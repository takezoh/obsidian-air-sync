# Four-stage sync pipeline responsibility normalization

<!-- anchor: FR-FOUR-001 -->
<!-- anchor: FR-FOUR-002 -->
<!-- anchor: FR-FOUR-003 -->
<!-- anchor: FR-FOUR-004 -->
<!-- anchor: FR-FOUR-005 -->
<!-- anchor: FR-FOUR-006 -->
<!-- anchor: NFR-FOUR-001 -->
<!-- anchor: NFR-FOUR-002 -->
<!-- anchor: component-observation -->
<!-- anchor: component-admission -->
<!-- anchor: component-execution -->
<!-- anchor: component-finalization -->
<!-- anchor: contract-observation-facts -->
<!-- anchor: contract-admission-authority -->
<!-- anchor: contract-exact-execution -->
<!-- anchor: contract-terminal-commit -->
<!-- anchor: adr-20260903-four-stage-sync-pipeline -->

## Architecture

The normal pipeline has exactly four top-level responsibility owners:

```text
Observation acquisition
  immutable entries + evidence + scope + namespace
        |
Admission decision
  path-local decision helper + identity components + exact authorization
        |
Effect execution
  execute only exact AuthorizedSyncPlan actions
        |
Commit/finalization
  publish exact outcomes -> checkpoint last -> release exact debt
```

Observation never produces a `SyncPlan`. The path-local decision table remains pure, but it is private to Admission in production. The orchestrator sequences the owners without owning action policy. Existing priority scheduling, global phase barriers, conflict rules, and rename-debt lifecycle stay within these four boundaries.

## Dependency order

1. Fact-only Observation carrier.
2. Admission-owned action construction and import guard.
3. Orchestrator/executor integration and behavior regression tests.
4. Finalization verification and durable documentation.

## Discretion

Private naming and helper placement are free. Provider/checkpoint contracts, persistence, phase ordering, action algebra, conflict policy, priority behavior, and user-visible outcomes are fixed and outside this change.
