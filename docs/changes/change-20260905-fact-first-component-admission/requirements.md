---
change: change-20260905-fact-first-component-admission
role: requirements
---

# Requirements

The requested outcome is repeated normal convergence after Obsidian rename, not a stopped-vault recovery routine. Production changes are not part of this design-only delivery.

The EARS requirements FR-001–FR-006 and NFR-001, with counterexamples and acceptance criteria, are in [the design plan](design-plan/design.md#requirements). They require fact-first identity/content decisions, baseline-complete no-op, version-preserving rename/edit, one captured pure configured-scope compatibility query, exact atomic terminal publication, and one completion result for checkpoint, tracker and UI.

Hard constraints: ADR 0001's two durable publications only; no new correctness owner, intermediate persistence, action kind, special recovery branch, DB-version decision, feature flag or dual-run path. COLD/WARM/HOT differ only in acquisition. Existing conflict policies and excluded-scope behavior are unchanged.

Approved contract corrections: Admission emits readonly ordered existing actions per existing component, closed over real endpoints/publication keys/overlapping effect namespaces. Each action's terminal publication precedes the next; a failed prefix blocks the suffix. Only independent singleton transfer or same-key match components use the existing pool; it settles before complex/conflict/structural components run globally serially with all priority work deferred. This replaces flat action phases without a DAG, queue or new owner.

Admission may authorize foreign destination replacement under the selected conflict policy. Executor proves required versions preserved; the existing store compares exact expected source/destination records or absence without identity policy. Source deletion, destination replacement and incompatible merge-base invalidation are atomic; best-effort base refresh is CAS-bound to its terminal record. Concurrent records survive mismatch and ordinary re-observation handles I/O success followed by publication failure.

The existing ScopeProjection exposes one fixed pure compatibility query over privately captured immutable pre-projection scope surface and settings. Every report/alias/actual-endpoint/baseline-derived relation must use it. This changes the earlier fully-data-only/no-additional-scope-information boundary, not inclusion policy. No live callback, I/O, clock, tracker lookup, duplicated candidate enumeration, excluded metadata in the identity graph or all-physical-subtree scan is allowed. Compatibility is only an inclusion prerequisite; Admission still proves identity and completeness. Equal complete inputs include the captured scope surface, not only included identity facts.

Acceptance is not merely a green rename operation: run subsequent cycles and inverse rename, with edits and partial I/O, until current endpoints/content/SyncRecords agree and repeated cycles are clean. Unknown/contradictory included facts remain failed. Missing baseline requires successful match publication before a no-op.
