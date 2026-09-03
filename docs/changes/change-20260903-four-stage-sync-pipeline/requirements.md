---
change: change-20260903-four-stage-sync-pipeline
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Functional requirements

- **FR-FOUR-001 (ubiquitous):** The system shall represent each normal sync cycle as exactly Observation, Admission, Execution, and Commit/finalization responsibilities.
- **FR-FOUR-002 (state-driven):** While acquiring a batch observation, the system shall produce immutable local, remote, baseline, scope, and namespace facts without constructing executable actions.
- **FR-FOUR-003 (event-driven):** When Admission receives one batch observation, the system shall construct and authorize the exact immutable action set and lifecycle dispositions for that cycle.
- **FR-FOUR-004 (unwanted):** If identity topology or concurrent baseline evidence is ambiguous, then the system shall authorize no destructive effect for the affected component.
- **FR-FOUR-005 (state-driven):** While executing a batch, the system shall perform only actions from its exact authorized plan and shall not reroute them.
- **FR-FOUR-006 (unwanted):** If any admitted component is nonterminal, failed, invalidated, foreign, duplicate, or partial, then the system shall retain the checkpoint and applicable rename debt.

## Non-functional requirements

- **NFR-FOUR-001:** Production imports shall mechanically enforce that only Admission can invoke the path-local action decision helper.
- **NFR-FOUR-002:** Provider calls, checkpoint schema, phase order, conflict policy, priority behavior, and existing user-visible outcomes shall remain compatible.

## Acceptance

1. Given a normal cycle observation, when it is captured before Admission, then it contains observed entries and evidence but no `SyncPlan` or executable action list.
2. Given the same observed entries, when Admission runs, then it produces the same exact actions and dispositions as the prior behavior.
3. Given a local rename plus local content edit with unchanged Remote state, when two cycles run, then the new name and new content converge and the second cycle has no actions.
4. Given incompatible Local and Remote changes from the same baseline, when Admission runs, then conflict policy is applied and no stale plain action bypasses it.
5. Given an attempt by another production layer to import the decision helper, when lint runs, then lint fails.
