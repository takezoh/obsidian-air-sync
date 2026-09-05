---
id: adr-20260905-fact-first-component-admission
kind: adr
title: Decide identity components from facts before materializing effects
status: accepted
created: '2026-09-05'
decision_makers:
- unknown
tags: []
owners: []
relations:
- {type: originatedFrom, target: change-20260905-fact-first-component-admission}
- {type: modifies, target: adr-20260904-remote-rename-alias-arbitration}
source_paths: []
summary: 'Accepted responsibility contracts: fact-first ordered component Admission,
  exact authorized publication, frozen scope compatibility and one clean-cycle completion;
  implementation remains pending.'
confirmation: Production-entry convergence and replay tests, exact action/commit tests,
  ownership guards, documentation lint, and the full repository gate; implementation
  and real-vault verification remain pending.
updated: '2026-09-05'
---

## Context

Admission currently constructs path-local actions before identity components, repairs them through rename/case-alias helpers, and uses their shape to validate identity. A component can establish that both endpoints already converge, then fail because alias coverage requires a rename action. Separate finalization and orchestrator predicates also interpret whether rename inputs are settled. These are circular and duplicated decisions inside an otherwise sound four-stage architecture.

The logged no-action rejection is reproduced. A separate public-entry case admits remote rename+edit without a content-transfer instruction; actual data loss was not exercised. These observations motivate changing decision direction and its execution contract, not adding another status or recovery owner.

## Decision

Accepted following the user's approval of the responsibility-contract revision: bind complete current identity/endpoint facts before comparing content and materializing exact effects. Admission alone returns failed, resolved_no_action or authorized. Decision engine is a pure same-identity content comparator; executor implements fixed existing-action protocols with terminal evidence; existing SyncRecord owner publishes success atomically. Finalization alone returns call-local clean/incomplete after commit/abort; orchestration consumes it for tracker acknowledgment and UI completion.

Admission emits readonly ordered existing actions within each existing component. Close components over current endpoints, actual source/destination publication keys and overlapping effect parent/child namespaces, not merely common vault ancestry. Each action's terminal publication precedes the next; prefix failure blocks the suffix. Only independent singleton transfers and same-key matches use the existing pool. Settle that pool and already-running priority work through the existing coordinator barrier, then globally serialize complex/conflict/structural components with all new priority work deferred. Preserve Admission order, including every B pull/match/conflict followed by A match/conflict combination. No DAG, queue or new scheduler owner is introduced; flat phase scheduling is not retained.

Admission owns authorization to replace a captured foreign destination under the selected conflict policy. Executor proves every version that policy requires preserved before successful publication. Store CAS compares exact source/destination expectations (`absent | exactRecord`) without identity policy. Source removal, destination replacement and incompatible merge-base invalidation occur in one transaction; best-effort base refresh is CAS-bound to its corresponding terminal record. Mismatches preserve concurrent records. After I/O success/CAS failure, stale baseline is historical comparison data, not present identity authority, and ordinary re-observation determines the next action without recovery state.

Existing ScopeProjection provides one fixed pure compatibility query over a private immutable capture of current pre-projection scope surface and settings. Every report-, alias-, actual-endpoint- and baseline-derived relation uses it. The query has no I/O, live callback, clock or tracker dependency and reports inclusion compatibility only; identity, completeness and authorization remain Admission responsibilities. Excluded metadata never enters the identity graph. No duplicated candidate enumeration or full physical-subtree scan is required. Both-endpoints-excluded behavior remains unchanged.

Use affirmative current identity/content/scope/baseline convergence, not absence of actions, as the no-op proof. Missing/stale file baseline uses existing match publication first. Reuse current states/action kinds/stores/generations and conflict preservation; no IR, pending work, failure persistence, new in-memory correctness owner or stopped-state branch.

### Accepted normative changes

- Four-stage design INV-006/INV-007: replace candidate-action shaping followed by action-aware identity evaluation with fact-only component binding followed by one exact effect materialization. Preserve the same Admission ownership and exhaustive fail-closed result.
- Accepted 20260904 rename-arbitration ADR: replace only raw-action materialization, report-root-to-proposed-action binding and residual actionless-failure requirements where they treat an operation's existence as topology proof. Preserve coherent report authority for unresolved transitions, unique identity, contradictory-report rejection, no weaker-family fallback, complete included mapping and exact authorization.
- Execution scheduling clauses that assume global flat transfer/conflict/structural phases or path-only action independence are superseded for complex components by readonly Admission order, action-by-action terminal publication, a settled independent singleton pool and globally serial complex components with priority drain/deferral. Existing action kinds, pool capacity and four-stage owners remain; schedule preservation is not claimed.
- Four-stage Observation/scope clauses that prohibit additional scope information or require a wholly data-only carrier are narrowed to permit the single pure ScopeProjection query over private immutable pre-projection scope/settings capture. All relation derivation paths must query it. Excluded metadata remains unavailable to identity grouping and configured inclusion policy remains, including folder relations with descendants excluded at both endpoints. The earlier entrance-representation-is-unchanged claim is withdrawn; no all-physical-descendants immutability policy is introduced.
- ADR 0001 A/B, attempt-bounded derived projection, successful per-file publication and whole-clean-cycle checkpoint remain unchanged. Foreign replacement policy stays in Admission/existing conflict policy, not in the store's strengthened exact CAS.

Historical ADR text is preserved. This accepted decision governs the named contract changes; implementation and promotion must update the corresponding active-design clauses and guards together. Concrete protocols, the three-P1 correction trace and dependency units belong to [the change plan](../changes/change-20260905-fact-first-component-admission/design-plan/design.md). The prior design approval was withdrawn; fresh independent review of the revised contracts returned approved with no findings on 2026-09-05. Production implementation and vault acceptance remain unverified.

## Consequences

### Positive

Actions no longer validate their own identity assumptions. Already-converged components terminate normally; interrupted effects re-enter ordinary fact-based comparison. One terminal outcome governs checkpoint, input acknowledgment and user-visible completion. Existing public Admission, filesystem and IDB seams support discriminating tests.

### Negative

This is a coordinated Admission/executor/publication refactor rather than a conditional patch. Complex components are deliberately globally serial, so they may reduce concurrency; priority waits for that interval. Both-direction rename/edit, authorized foreign replacement, target-aware CAS, merge-base races, scope derivation and folder publication require interruption tests. Affected-endpoint proof may require targeted stat/read when existing metadata cannot prove content; no blanket scan/read expansion is authorized.

### Neutral

Four-stage ownership, conflict policy, configured inclusion policy, stores, action kinds and user commands remain. Scheduling and the narrowly permitted scope carrier/query change as stated above. No database bump, reset or migration is required. Acceptance of this decision is not evidence that the deployed vault is repaired.

## Alternatives

No-action alias bypass is rejected because it cannot prove identity or baseline completeness. A second no-op coverage evaluator is rejected because it retains action-derived identity policy. A new state machine/IR is rejected because existing owners and fixed action protocols suffice. The selected refactor removes the old policy path rather than retaining a feature-flag or fallback implementation.


{% transition from="proposed" to="accepted" date="2026-09-05" %}
User approved the responsibility-contract revision; implementation and vault verification remain pending.
{% /transition %}
