---
change: change-20260831-issue51-rename-evidence-lifecycle
role: requirements
functional_requirements:
- id: FR-RENAME-001
  statement: Only Admission shall classify fresh or replayed local rename candidates
    and emit exact pre-I/O persistence and post-checkpoint release membership.
  priority: must
- id: FR-RENAME-002
  statement: A positively proven additive unbaselined local rename component shall
    authorize terminal pushes without rename_mismatch and a fresh report shall create
    no debt.
  priority: must
- id: FR-RENAME-003
  statement: Synchronized, destructive, scope-transitioning, unknown, conflicting,
    or incomplete rename components shall remain safety binding and fail closed unless
    their exact consequence is proven.
  priority: must
- id: FR-COMPAT-001
  statement: Existing false SyncState v6 debt shall be reclassified from current authoritative
    facts and retired only after successful admitted progress and a safe checkpoint
    without reset or migration.
  priority: must
- id: FR-PERSIST-001
  statement: If any retained rename constraint cannot be upserted, the cycle shall
    fail visibly before executor I/O or tracker acknowledgement and shall preserve
    retry evidence.
  priority: must
- id: FR-FINALIZE-001
  statement: Finalization shall retire exact release membership only after its corresponding
    disposition succeeds or resolves with no action and the clean checkpoint commits.
  priority: must
- id: NFR-SAFETY-001
  statement: Admission-only executable authority, stat-backed absence, fresh current-scope
    authority, and fail-closed handling of incomplete facts shall remain intact.
  priority: must
- id: NFR-OBSERVE-001
  statement: Structured non-sensitive diagnostics shall distinguish report, replay,
    promotion, non-binding, retention, release, and persistence-failure lifecycle
    stages.
  priority: must
- id: NFR-SCOPE-001
  statement: The correction shall reuse the RenameEvidence tuple and SyncState v6
    and shall not add a general identity graph, persistent state machine, blanket
    deletion, or blank-file claim.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements — Issue #51 rename evidence lifecycle

## Functional requirements

### FR-RENAME-001 — Admission-owned promotion

When a cycle contains a fresh tracker rename or replayed v6 debt, the system shall carry
it as a candidate until Admission classifies the whole connected component and emits
exact persistence and release membership. Planning and Finalization shall not infer
membership from raw reports, scope alone, or action names.

### FR-RENAME-002 — proven additive progress

When current authoritative facts prove that a connected local rename component has no
baseline, remote identity, conflict, destructive consequence, or incomplete coverage,
and its only actions are pushes to exact current terminal paths, Admission shall
authorize those pushes without `rename_mismatch` and shall create no fresh debt.

### FR-RENAME-003 — fail-closed safety

When baseline membership, remote identity, destructive/native consequence, current
scope transition, unknown/conflicting observation, incomplete folder/chain coverage, or
mixed evidence exists, Admission shall classify the component safety-binding or
inconclusive. It shall admit only the existing exact postcondition or defer the whole
component with zero destructive I/O.

### FR-COMPAT-001 — v6 compatibility

When an existing v6 row is replayed, Admission shall reclassify it from the same fresh
proof projection. A proven false row may become release-eligible but shall remain stored
through execution and be deleted only after its associated successful disposition and
checkpoint. Ambiguous or genuine rows remain stored. No migration or manual reset is
allowed.

### FR-PERSIST-001 — persistence failure abort

When any safety-binding local constraint cannot be durably upserted, the cycle shall end
as a visible failure before executor I/O or tracker acknowledgement. Loaded debt and
pending in-memory evidence shall remain available for retry.

### FR-FINALIZE-001 — consequence-bound retirement

While a row is release-eligible, Finalization shall delete its exact key only after the
associated disposition resolves with no action or all authorized actions succeed and
the clean checkpoint commits. Deferral, failure, blocking, absent association, or
checkpoint failure retains it.

## Invariants and non-functional requirements

- `NFR-SAFETY-001`: only Admission creates executable authority; endpoint absence is
  authoritative, current scope is freshly projected, stale v6 scope cannot fill current
  unknown, and incomplete evidence fails closed.
- `NFR-OBSERVE-001`: diagnostics distinguish fresh, replayed, promoted, non-binding,
  retained, released, and persistence-failed stages without content or credentials.
- `NFR-SCOPE-001`: reuse `RenameEvidence` and SyncState v6; do not add a general identity
  graph, persistent state machine, blanket cleanup, or blank-file success claim.

## Acceptance scenarios

1. Given a never-synchronized local `old.md -> new.md` rename with exact observations
   and only `push(new.md)`, when Admission runs, then the push is executable, no
   `rename_mismatch` occurs, and no debt is created.
2. Given the same current facts plus a stored v6 row, when execution and checkpoint
   succeed, then the row is deleted after checkpoint; a checkpoint failure retains it.
3. Given a baseline/remote anchor at `old.md`, when the optimizer proposes an exact
   native rename, then the edge is persisted before I/O and retired after action plus
   checkpoint; a mismatched proposal defers and retains it.
4. Given a v6 row whose old scope says included but current scope is unknown, when
   Admission runs, then the old value does not authorize additive release.
5. Given an injected debt-upsert failure, when the cycle reaches the persistence cut,
   then executor I/O and tracker acknowledgement are both zero and retry evidence stays.

## Non-goals

This change does not prove or fix blank-file creation, redesign remote rename authority,
roll back unrelated `ff87f7d` changes, change SyncState schema, or add generalized
identity infrastructure.
