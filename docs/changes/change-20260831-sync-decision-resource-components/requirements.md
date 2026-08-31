---
change: change-20260831-sync-decision-resource-components
role: requirements
functional_requirements:
- id: FR-SD-001
  statement: When a projected current path is proposed, the existing path-local table
    MUST emit at most one ordinary action in input order and MUST NOT propose deletion
    without a baseline.
  priority: must
- id: FR-SD-002
  statement: Admission MUST consume one immutable cycle snapshot, build one exhaustive
    cycle-local component partition exactly once, and emit one outcome for every relevant
    component.
  priority: must
- id: FR-SD-003
  statement: PlanAdmission MUST be the sole owner of cross-path rename action shaping,
    component-wide destructive authorization, disposition, and local lifecycle membership.
  priority: must
- id: FR-SD-004
  statement: Proved unbaselined additive work MUST authorize only terminal pushes
    with no new debt; proved already-converged work MUST resolve without action and
    release only matching replayed v6 debt after a clean checkpoint; all other unproved
    cases MUST remain binding or defer.
  priority: must
- id: FR-SD-005
  statement: Local native rename MUST require baseline/hash proof, remote native rename
    MUST require backend-reported same-root evidence, and identity MUST NOT be inferred
    from spelling or content equality.
  priority: must
- id: FR-SD-006
  statement: Every component outcome MUST carry exact persist-before-execution and
    release-after-safe-checkpoint membership that orchestration and finalization consume
    mechanically in commit-last order.
  priority: must
- id: FR-SD-007
  statement: Unprovable filesystem evidence MUST remain unresolved or abort through
    existing IFileSystem semantics, and Admission MUST defer without provider-specific
    fallback.
  priority: must
- id: NFR-SD-001
  statement: Admission MUST remain pure, deterministic, cycle-local, snapshot-bound,
    and proposal-order-preserving for disconnected authorized work.
  priority: must
- id: NFR-SD-002
  statement: AuthorizedSyncPlan, executor ordering, SyncState v6 RenameDebt, bounded
    replay, pre-I/O persistence, and checkpoint-before-retirement MUST remain compatible
    without persisted migration.
  priority: must
- id: NFR-SD-003
  statement: Production MUST have one path proposal owner, one identity-component
    owner, one component build, no standalone whole-plan optimizer, no second build,
    and no provider-name decision branch.
  priority: must
- id: NFR-SD-004
  statement: For V path/fact vertices and E connectivity edges, one pure component
    build MUST run in O((V + E) log V) time or better with O(V + E) auxiliary memory
    and no I/O or repeated component construction.
  priority: must
- id: NFR-SD-005
  statement: Existing safety and convergence suites plus exhaustive-table, permutation,
    scale, mutation, and mandatory shared faithful-fake/interface checks MUST remain
    discriminating and green; ADR 0003 live E2E remains opt-in and non-CI.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Intended outcome

Preserve the existing path-local sync decision table while making PlanAdmission the single owner of cross-path identity/rename action shaping, component-wide destructive authorization, disposition, and local rename lifecycle membership. The cycle uses one immutable snapshot and one component build. The change removes the standalone whole-plan refinement stage without replacing the pipeline with a general sync compiler.

## Functional requirements

- `FR-SD-001` — When a projected current path is proposed, the system MUST apply the existing baseline/local/remote table, emit at most one ordinary action for that path in input order, and MUST NOT propose deletion when no baseline exists.
- `FR-SD-002` — While Admission evaluates a cycle, it MUST consume the immutable proposal/evidence/observation/scope snapshot, build one exhaustive cycle-local component partition exactly once, and emit exactly one outcome for every relevant component, including zero-action evidence components.
- `FR-SD-003` — When identity-connected work is evaluated, PlanAdmission MUST be the sole owner of rename action shaping, component-wide destructive authorization, disposition, and local lifecycle membership. Proposal, evidence, executor, and finalization stages MUST NOT reinterpret that evidence.
- `FR-SD-004` — When an unbaselined additive local component is completely proved, Admission MUST authorize only terminal pushes and create no new debt. When evidence proves an already-converged rename, Admission MUST emit `resolved_no_action` and release only matching replayed SyncState v6 debt after a clean checkpoint. Every incomplete, conflicting, destructive, or otherwise unproved case MUST remain binding and/or defer.
- `FR-SD-005` — A local native rename MUST require the existing content-preserving baseline/hash proof. A remote native rename MUST require the backend-reported edge and same-root opaque identity evidence. Identity MUST NOT be inferred from path spelling or content equality.
- `FR-SD-006` — Every component outcome MUST carry exact `persistBeforeExecution` and `releaseAfterSafeCheckpoint` membership. Orchestration MUST persist before plan I/O; Finalization MUST retire only exact matching membership after successful consequences and checkpoint commit.
- `FR-SD-007` — When an `IFileSystem` producer cannot prove path authority, absence, stable identity, or complete mapping, acquisition MUST abort or preserve unresolved evidence and Admission MUST defer without provider-specific fallback.

## Non-functional requirements

- `NFR-SD-001` — Admission MUST remain pure, deterministic, cycle-local, snapshot-bound, and proposal-order-preserving for disconnected authorized work.
- `NFR-SD-002` — `AuthorizedSyncPlan`, executor ordering, SyncState v6 `RenameDebt`, bounded replay, pre-I/O persistence, remote checkpoint replay, non-clean deferral, and checkpoint-before-retirement MUST remain compatible without persisted migration.
- `NFR-SD-003` — Production MUST contain one path proposal owner, one identity-component decision owner, one component build, no standalone whole-plan optimizer, no second component build, and no provider-name branch under sync decision code.
- `NFR-SD-004` — For `V` path/fact vertices and `E` connectivity edges, one pure component build MUST run in `O((V + E) log V)` time or better with `O(V + E)` auxiliary memory, no I/O, and no per-outcome rescan/rebuild.
- `NFR-SD-005` — Existing safety/convergence suites and new exhaustive-table, mutation, permutation, scale, and mandatory shared faithful-fake/interface checks MUST remain discriminating and green. ADR 0003 live E2E remains opt-in and non-CI. The change MUST NOT claim an unmeasured runtime speedup.

## Exhaustive component outcomes

Rows are precedence ordered. A row authorizes only when all predicates are affirmative and no earlier row applies. Multiple non-deferral matches, missing proof, or an uncovered state select the final deferral row.

| Priority | Outcome | Required proof | Observable result | Local lifecycle |
|---:|---|---|---|---|
| 0 | acquisition failure | observation/provider call throws or snapshot cannot freeze | abort before Admission; no plan | persist none; release none |
| 1 | invalid/unresolved | unresolved authority, conflict, opposing delete, alias mutation, unknown/mobile scope, incomplete mapping, or unsafe occupancy | whole-component deferral; no actions | persist every matching safety-binding candidate; release none |
| 2 | already converged | old absent and new exact/current on both sides, compatible scope, no conflict | `resolved_no_action` | persist none; release only matching replayed v6 debt after clean checkpoint |
| 3 | unbaselined additive | no baseline; local old absent/new exact; remote endpoints absent; complete compatible scope; terminal pushes only | terminal pushes in proposal order | no new debt; release none |
| 4 | native rename | normative direction-specific edge plus complete occupancy/content/identity/mapping proof | exact native rename projection | persist matching local candidates; release same exact keys after clean checkpoint |
| 5 | source recreation | moved stable identity plus distinct recreated-source identity; all occurrences proved | exact projection preserving both resources | persist matching local candidates; release same exact keys after clean checkpoint |
| 6 | proved ordinary consequence | full-component survival/delete/transfer proof after earlier rows do not apply | only existing base actions whose predicates are proved | persist matching local candidates; release same exact keys after clean checkpoint |
| 7 | non-rename ordinary | no rename/alias identity edge and existing Admission predicates all pass | Admission-checked base actions in proposal order | persist none; release none |
| 8 | default deferred | missing, conflicting, multiply matching, failed-native-only, or uncovered state | whole-component deferral; no actions | persist every matching safety-binding candidate; release none |

Failed native projection alone is never proof for an ordinary fallback.

## Failure modes

| Failure | Required recovery | Forbidden result |
|---|---|---|
| list/stat/provider observation throws | visible abort/retry before Admission | fabricate absence or deferred proof |
| unresolved component proof | defer whole component and retain replay evidence | exact/destructive authority |
| mandatory shared provider conformance fails | fix behind that provider boundary and withhold the affected backend change | provider branch in sync decision |
| concrete real-response representation gap is suspected | targeted opt-in live preverification; hold only that backend change | block unrelated providers or extend the central interface speculatively |
| debt upsert fails | zero plan I/O and tracker acknowledgement | execute and persist later |
| action fails/blocks or any component defers | non-clean cycle; checkpoint withheld | partial checkpoint advance |
| checkpoint commit fails | retain debt/evidence | release first |
| release-key mismatch | fail closed and retain unmatched debt | prefix/broad retirement |

## Acceptance criteria

- `AC-SD-001`: The complete path table, input order, one-action maximum, and no-baseline delete prohibition remain unchanged.
- `AC-SD-002`: Production has one proposal owner, one component build, one identity decision owner, no standalone `refinePlan`, and no provider branch.
- `AC-SD-003`: Every outcome-table row has a positive test; unmatched, multiple, conflicting, unsafe-native, and ambiguous-survival cases defer; action/disposition/lifecycle come from one result.
- `AC-SD-004`: Already-converged evidence emits no action and releases only matching replayed v6 debt after a clean checkpoint; action, persistence, or checkpoint failure withholds release.
- `AC-SD-005`: Pre-I/O persistence, zero I/O on upsert failure, replay, executor ordering, checkpoint-before-retirement, and SyncState v6 remain green.
- `AC-SD-006`: Google Drive, Dropbox, and OneDrive pass mandatory shared faithful-fake/interface cases. ADR 0003 live E2E remains opt-in/non-CI and skips without credentials. Concrete representation-gap evidence triggers targeted live preverification and holds only the affected backend change.
- `AC-SD-007`: Component construction is deterministic, happens once, and meets the linearithmic-or-better time and linear-memory bounds under permutation and scale-sensitive verification.
- `AC-SD-008`: Architecture, ADR proposal, source, and project gate agree; no blank-file causality/resolution claim and no Issue #51 or PR #53 implementation is included.

## Non-goals

- No executor scheduling/barrier redesign, conflict-policy change, or scope-policy change.
- No SyncState schema migration, new persistent identity graph, or public provider abstraction.
- No provider-specific decision behavior; differences remain behind `IFileSystem`.
- No claim that this redesign fixes the blank-file report.
- No Issue #51 implementation or PR #53 content in this change package.
