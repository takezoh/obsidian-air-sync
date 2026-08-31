# Sync decision resource components — integrated design

## Outcome and boundary

This change preserves `planSync` as the existing path-local proposal table and moves only cross-path identity semantics into the existing PlanAdmission authority boundary. PlanAdmission builds the cycle-local component partition once from an immutable snapshot, then one private component decision owner shapes rename actions, authorizes every destructive consequence, emits a typed disposition, and decides exact local rename persistence/release membership.

The target pipeline is:

```text
Observe and project scope
  -> planSync(entries): plain path-local proposal
  -> immutable CycleAdmissionSnapshot
  -> PlanAdmission: one component build and one component outcome per component
  -> AuthorizedSyncPlan + dispositions + exact lifecycle membership
  -> persist-before-I/O -> execute in existing order -> checkpoint -> retire exact membership
```

There is no standalone `refinePlan`, no second component build, no provider switch in sync decision code, and no new general or persistent resource graph. This is deliberately smaller than a replacement “sync compiler”: path proposal, evidence acquisition, execution, and finalization remain separate owners.

In scope: the proposal/Admission boundary, rename action shaping, component-wide destructive authorization, lifecycle membership, provider cutover evidence, tests, and ownership documentation. Out of scope: executor lanes/barriers, conflict and scope policy, SyncState schema changes, provider-specific sync policy, Issue #51 implementation or PR #53, and any claim that this redesign causes or fixes blank files.

## Requirements

<!-- anchor: fr-sd-001 -->
### FR-SD-001 — Path-local proposal invariance

When a projected current path is proposed, the system MUST apply the existing baseline/local/remote decision table, emit at most one ordinary action for that path in input order, and MUST NOT propose deletion when no baseline exists.

<!-- anchor: fr-sd-002 -->
### FR-SD-002 — Single immutable component decision

While Admission evaluates a cycle, it MUST consume the immutable proposal/evidence/observation/scope snapshot, build one exhaustive cycle-local component partition exactly once, and emit exactly one component outcome for every relevant component, including zero-action evidence components.

<!-- anchor: fr-sd-003 -->
### FR-SD-003 — Exclusive cross-path authority

When identity-connected work is evaluated, PlanAdmission MUST be the sole owner of rename action shaping, component-wide destructive authorization, disposition, and local rename lifecycle membership. Earlier proposal/evidence stages and later executor/finalizer stages MUST NOT reinterpret identity evidence.

<!-- anchor: fr-sd-004 -->
### FR-SD-004 — Exact local lifecycle cases

When an unbaselined additive local component is completely proved, Admission MUST authorize only its terminal pushes and create no new binding debt. When current evidence proves an already-converged rename, Admission MUST emit `resolved_no_action` and place only matching replayed SyncState v6 debt in `releaseAfterSafeCheckpoint`. Every incomplete, conflicting, destructive, or otherwise unproved case MUST remain binding and/or defer; release MUST occur only after a clean commit-last checkpoint.

<!-- anchor: fr-sd-005 -->
### FR-SD-005 — Direction-specific identity proof

When evaluating a local native rename, Admission MUST require the existing content-preserving baseline/hash proof. When evaluating a remote native rename, Admission MUST require the backend-reported edge and same-root opaque identity evidence. It MUST NOT infer identity from path spelling or content equality.

<!-- anchor: fr-sd-006 -->
### FR-SD-006 — Commit-last consumption

When a component outcome is emitted, it MUST carry exact `persistBeforeExecution` and `releaseAfterSafeCheckpoint` membership. Orchestration MUST persist the former before plan I/O; Finalization MUST consume the latter mechanically only after successful consequences and checkpoint commit.

<!-- anchor: fr-sd-007 -->
### FR-SD-007 — Provider-neutral fail-closed evidence

When a filesystem producer cannot prove path authority, absence, stable identity, or complete rename mapping through the existing `IFileSystem` contract, acquisition MUST abort or represent the fact as unresolved, and Admission MUST defer without provider-specific fallback.

<!-- anchor: nfr-sd-001 -->
### NFR-SD-001 — Pure deterministic Admission

Admission MUST remain pure, cycle-local, deterministic, and snapshot-bound, and MUST preserve plain-proposal order among disconnected authorized actions.

<!-- anchor: nfr-sd-002 -->
### NFR-SD-002 — Compatibility and crash safety

The change MUST preserve `AuthorizedSyncPlan`, executor ordering, SyncState v6 `RenameDebt`, bounded replay, pre-I/O persistence, remote checkpoint replay, non-clean deferral, and checkpoint-before-retirement without persisted migration.

<!-- anchor: nfr-sd-003 -->
### NFR-SD-003 — Structural singularity

Production MUST contain one path proposal owner, one identity-component decision owner, one component build, no standalone whole-plan rename optimizer, no second Admission component build, and no provider-name decision branch.

<!-- anchor: nfr-sd-004 -->
### NFR-SD-004 — Component formation bound

For `V` path/fact vertices and `E` connectivity edges in one immutable cycle snapshot, component formation and indexing MUST complete in `O((V + E) log V)` time or better with `O(V + E)` auxiliary memory. It MUST perform no filesystem, network, settings, or persistence I/O and MUST NOT rescan or rebuild components per outcome row.

<!-- anchor: nfr-sd-005 -->
### NFR-SD-005 — Discriminating verification

Existing fixed-point, crash/delete safety, optimizer-compatibility, Admission, executor, and shared faithful-fake/interface contract tests MUST remain green at their owning boundary; new table, permutation, scale, and mutation counterexamples MUST reject unsafe fallback and quadratic/repeated construction without claiming an unmeasured runtime speedup. Live E2E remains the opt-in, non-CI backstop defined by ADR 0003.

## Components

<!-- anchor: component-path-proposal -->
### component-path-proposal

Existing `src/sync/decision-engine.ts` and its comparison helpers own only the compatibility-pinned per-path table. They emit a plain proposal and do not consume rename evidence or construct destructive authority.

<!-- anchor: component-plan-admission -->
### component-plan-admission

Existing PlanAdmission remains the only constructor of `AuthorizedSyncPlan`. A private component decision helper may index facts and calculate mappings, but cannot become a public stage, accept/return a whole-plan refinement, build components again, read I/O, or independently authorize fallback. Its one output per component contains executable actions or no action, typed reasons, and lifecycle membership.

<!-- anchor: component-cycle-evidence -->
### component-cycle-evidence

Existing change detection, path observation, scope projection, and filesystem contracts acquire and qualify facts. They own producer semantics such as `actual_resolved`, `requested_echo`, opaque same-root `identityKey`, reported `RenamePair`, and post-delta snapshots. They do not decide sync consequences.

<!-- anchor: component-execution-finalization -->
### component-execution-finalization

The orchestrator persists exact Admission membership before I/O and gives only `AuthorizedSyncPlan` to the executor. The executor preserves current phase/lane/barrier ordering and never validates identity. Finalization commits checkpoint state before exact retirement and never rereads evidence.

## Contracts

<!-- anchor: contract-path-proposal-table -->
### contract-path-proposal-table

The existing table, at-most-one-action rule, no-baseline delete prohibition, and input-order projection are unchanged. Rename semantics may shape the later component outcome but may not alter the path table's responsibility.

<!-- anchor: contract-identity-component-decision -->
### contract-identity-component-decision

Operational inputs are frozen for the cycle: plain proposal; normative identity/rename evidence; producer-qualified observations; projected scope for both endpoints before filtering; and baseline membership. Mutation or namespace/root mismatch invalidates the cycle. Baseline membership never proves identity.

The following precedence-ordered outcome table is exhaustive. A row may authorize only when all predicates in that row are affirmative and no earlier row applies. If two non-deferral rows match, evidence conflicts, or no row matches, row 8 applies.

| Priority | Outcome | Required observations and predicates | Exact permitted actions | `persistBeforeExecution` | `releaseAfterSafeCheckpoint` |
|---:|---|---|---|---|---|
| 0 | acquisition failure | list/stat/provider call throws or snapshot cannot be frozen | abort before Admission; no plan | none | none |
| 1 | deferred invalid evidence | unresolved/echoed authority, conflicting identity, opposing delete, alias-target mutation, unknown/mobile scope, incomplete folder mapping, or occupied destination without source-recreation proof | none; whole component deferred | every matching safety-binding local candidate, including replayed debt | none |
| 2 | already converged | for each reported edge, both sides authoritatively prove old absent and new exact/current; scope is compatible; no conflicting occurrence/action | none; `resolved_no_action` | none | only matching replayed v6 debt keys |
| 3 | unbaselined additive | no baseline; authoritative local old absent/new exact; authoritative remote old/new absent; compatible complete scope; component has only local report(s) and terminal non-destructive pushes | terminal `push(new)` actions only, in proposal order | none | none |
| 4 | native rename | direction-specific normative edge; compatible scope; complete file/folder mapping; destination occupancy, content/hash (local origin), identity (remote origin), and all postconditions proved | exact `rename_remote` or `rename_local` projection, including complete descendants, with absorbed fallback actions omitted | matching local candidates that must survive action/crash | the same exact keys after clean checkpoint |
| 5 | source recreation | stable identity proves moved occurrence while a distinct current identity proves recreated source; all occurrences, destinations, scope, and mappings are complete | exact projection preserving both occurrences; no overwrite/delete of either survivor | matching local candidates | the same exact keys after clean checkpoint |
| 6 | proved ordinary consequence | native/additive/recreation rows do not apply, but authoritative observations, baseline comparison, scope, identity separation, occupancy, and complete mappings prove every resource survivor and every delete/transfer consequence for the entire component | only the existing base actions whose full component predicates are proved | matching local candidates | the same exact keys after clean checkpoint |
| 7 | non-rename ordinary component | component has no rename/alias identity edge and existing Admission checks prove all ordinary actions | Admission-checked base actions in proposal order | none | none |
| 8 | default deferred | missing predicate, incomplete or contradictory facts, multiply matching non-deferral rows, unsafe native projection, or uncovered state | none; whole component deferred | every matching safety-binding local candidate | none |

This partition distinguishes `determinate-authorized` (rows 3–7 with actions), `determinate-resolved` (row 2), `unknown`/`inconclusive` (missing proof), `conflicting` (incompatible or multiply matching facts), and `failure` (row 0). Native projection failure is never, by itself, proof for row 6.

Normal and adversarial witnesses include local/remote file and folder moves, complete chains, destination occupancy, local hash mismatch, incomplete descendants, source recreation, alias/request echo, zero-action uncertainty, and conflicting rows. Each row has a table-driven positive case; failed native projection, ambiguous survival, or multiple matches must produce row 8.

<!-- anchor: contract-single-build-structure -->
### contract-single-build-structure

One pure component builder consumes the immutable snapshot once. A private map/set/union-find/traversal representation is allowed only if it preserves deterministic membership/order and NFR-SD-004. Production imports and source checks must prove the absence of `refinePlan`, a second build, and provider-specific branches.

<!-- anchor: contract-fs-evidence-conformance -->
### contract-fs-evidence-conformance

The mandatory cutover gate is the shared faithful-fake behavior contract and interface-level conformance for Google Drive, Dropbox, and OneDrive. Every provider must pass the shared `IFileSystem` authority, identity continuity/replacement, absence/error, order-independent rename-edge, and post-delta snapshot cases. A representable failure is fixed behind that provider's existing implementation/fake and rerun; no provider-specific sync policy is introduced.

ADR 0003 remains authoritative for live E2E: it is opt-in, local/manual, non-CI, and missing credentials warn and skip rather than fail. A live run is not a universal prerequisite for this redesign. If code review, a shared-contract mismatch, provider documentation, or an observed API payload gives concrete reason to suspect that one backend's real response cannot be represented by current `PathAuthority`, `identityKey`, `RenamePair`, or snapshot semantics, that backend alone enters targeted live preverification. Pending or failed targeted evidence holds only changes for that backend; it does not block unrelated providers or the central Admission refactor after the mandatory shared gate passes. A proven unrepresentable live response stops that backend change and opens a separate interface-design decision.

<!-- anchor: contract-crash-finalization-preservation -->
### contract-crash-finalization-preservation

| Failure condition | Required result | Forbidden result |
|---|---|---|
| list/stat/provider observation throws | abort before Admission; normal visible retry/error path | fabricate absence or deferred proof |
| unresolved observation or component proof | whole-component deferral; hold checkpoint/evidence | exact presence or destructive authority |
| mandatory shared provider conformance fails | fix behind that provider boundary and withhold the affected backend change | provider branch in sync decision |
| concrete real-response representation gap is suspected | targeted opt-in live preverification; hold only that backend change | block unrelated providers or extend the central interface speculatively |
| debt upsert fails | zero plan I/O and zero tracker acknowledgement | execute and persist afterward |
| action fails/blocks or any component defers | non-clean cycle; checkpoint withheld; replay retained | partial checkpoint advance |
| checkpoint commit fails | debt/evidence retained | release or delete membership first |
| exact release-key mismatch | fail closed; retain unmatched debt | broad/prefix retirement |
| deterministic/performance invariant fails | implementation verification fails | order-dependent or quadratic production accepted |

SyncState remains v6. Remote evidence replays by withholding its checkpoint; local safety-binding debt is serialized before I/O; retirement is exact and occurs only after the checkpoint succeeds.

<!-- anchor: contract-pipeline-migration -->
### contract-pipeline-migration

The source migration is atomic: stop calling `refinePlan`, pass the immutable plain proposal into Admission, move component-local action shaping into its private owner, migrate behavior tests, then delete the standalone optimizer API/module. No dual production path or compatibility shim is permitted. `AuthorizedSyncPlan`, executor order, settings, command IDs, checkpoint/SyncRecord formats, SyncState v6 and `RenameDebt` wire shape remain unchanged. Rollback is a normal code rollback because no persisted format changes.

## ADR

<!-- anchor: adr-admission-owns-identity-component-decision -->
### Proposed ADR: Admission owns identity-component decision

An ADR is required because this changes a persistent responsibility boundary and narrows an accepted ADR consequence. Proposed decision: retain the path-local proposal table; make PlanAdmission the single owner of cross-path action shaping, destructive authorization, disposition, and lifecycle membership; build components once; retire the standalone optimizer stage.

The proposal preserves ADR 0001 commit-last, ADR 0002 shared backend contracts, ADR 0003 opt-in/non-CI live backstop and credential skip, ADR 0006 producer-owned remote rename reporting, ADR 0008 normative evidence/fail-closed rules except its standalone optimizer consequence, the Issue #43 immutable Admission authority, and the Issue #51 exact local lifecycle owner. Alternatives rejected: moving all decisions into `planSync`; keeping `refinePlan` as a trusted transform; sharing helpers between two semantic owners; creating a general/persistent resource graph; or letting the executor select fallback after runtime failure.

<!-- anchor: adr-0001-metadata-cache-subordinate-to-commit-last -->
### Existing ADR 0001

Remains accepted and governs checkpoint commit-last compatibility.

<!-- anchor: adr-0002-backends-verified-by-shared-behaviour-contracts -->
### Existing ADR 0002

Remains accepted and governs shared provider behavior contracts.

<!-- anchor: adr-0006-remote-rename-detection-is-order-independent -->
### Existing ADR 0006

Remains accepted and governs order-independent provider rename evidence.

<!-- anchor: adr-0008-logical-identity-admission-fails-closed -->
### Existing ADR 0008

Remains accepted except for the standalone optimizer ownership consequence explicitly narrowed by the proposed ADR.

<!-- anchor: adr-20260825-issue43-destructive-authorization -->
### Existing Issue #43 ADR

Remains accepted and governs immutable Admission-issued destructive authority.

<!-- anchor: adr-20260831-admission-owned-local-rename-constraint-lifecycle -->
### Existing Issue #51 lifecycle ADR

Remains accepted and governs exact local membership; this package neither implements Issue #51/PR #53 nor claims blank-file causality.

## Implementation units

### unit-0-provider-evidence-preverification

Run and strengthen mandatory shared faithful-fake/interface contracts for Google Drive, Dropbox, and OneDrive. Fix representable deviations only behind the existing provider boundary. Run targeted live preverification only for a backend with concrete evidence of a possibly unrepresentable response; pending evidence holds that backend's change only, and a proven gap exits to a separate interface design.

### unit-1-single-identity-component-owner

After the mandatory shared provider gate passes, add table-first tests, then make PlanAdmission build components once and call one private decision owner. Implement the precedence table, exact outcome/action/disposition/lifecycle result, deterministic projection, and bounded private indexing. Remove edge-filter/rebuild semantics while preserving the path table. A pending targeted-live question holds only its backend-specific change.

### unit-2-pipeline-and-lifecycle-migration

Remove `refinePlan` from cycle planning and retire the standalone optimizer API/module/tests after moving behavioral witnesses. Preserve pre-I/O persistence, `AuthorizedSyncPlan`, executor ordering, commit-last finalization, v6 replay, and exact retirement. Update diagnostics to component outcomes.

### unit-3-architecture-and-conformance

After code and tests stabilize, update architecture/pipeline and ADR ownership text, record the proposed ADR disposition, and add/adjust structural checks. Do not mix Issue #51 implementation or PR #53 into this package.

## Verification and acceptance

### AC-SD-001

The complete path table remains behaviorally identical, including input order, one action maximum, and no deletion without a baseline.

### AC-SD-002

Production has one proposal owner, one component build, one identity decision owner, and no standalone `refinePlan` or provider branch.

### AC-SD-003

Every precedence-table row has a positive case, every unmatched/multiple/conflicting case defers, and exact action/disposition/lifecycle membership derives from the same component result.

### AC-SD-004

Already-converged evidence emits no action and releases only matching replayed v6 debt after a clean checkpoint; action, persistence, or checkpoint failure withholds release.

### AC-SD-005

Crash/failure tests prove pre-I/O persistence, zero I/O on upsert failure, non-clean replay, executor ordering, checkpoint-before-retirement, and unchanged SyncState v6.

### AC-SD-006

Google Drive, Dropbox, and OneDrive pass the mandatory shared faithful-fake/interface contract. Live E2E remains opt-in/non-CI and skips without credentials; only a backend with concrete representation-gap evidence requires targeted live preverification, which holds that backend's change without blocking unrelated work.

### AC-SD-007

Component construction is deterministic under non-semantic input permutations, occurs once, meets linearithmic-or-better time and linear auxiliary memory bounds, and rejects scale behavior consistent with repeated/quadratic rescans.

### AC-SD-008

Architecture, ADR proposal, source, and full project gate agree; no blank-file causality/resolution claim or Issue #51/PR #53 implementation is included.

## Decision dispositions

- `decision-input-simple-single-owner`: adopted as one Admission-owned identity component decision without a replacement mega-compiler.
- `decision-input-path-local-table`: retained unchanged as proposal-only behavior.
- `decision-input-admission-exclusive-authority`: preserved and extended only to cross-path action shaping and lifecycle membership.
- `decision-input-normative-rename-evidence`: consumed directly; no optimizer-owned evidence collection.
- `decision-input-optimizer-compatibility`: local hash, remote report, complete folder mapping, occupancy, and recreation rules move into the component table.
- `decision-input-no-general-framework`: general/persistent resource graph rejected.
- `decision-input-backend-convergence`: mandatory shared faithful-fake/interface conformance, ADR 0003 opt-in live backstop, and targeted live preverification only for a backend with concrete representation-gap evidence; interface redesign only after an unrepresentable real response is proved.
- `decision-input-crash-commit-last`: v6, replay, executor ordering, and commit-last preserved.
- `decision-input-blank-file-unknown`: blank-file causality and resolution excluded.

## Resolved critique issues

- `issue-ordinary-consequence-proof-open`: resolved by the exhaustive precedence table, exact actions/membership, default deferral, and discriminating row/multiple-match tests.
- `issue-additive-lifecycle-contradiction`: resolved by mutually exclusive additive and already-converged rows; only matching replayed v6 debt from the converged row is releasable after a clean checkpoint.
- `issue-provider-cutover-evidence-partition`: resolved by a mandatory per-provider shared faithful-fake/interface gate plus a user-approved ADR 0003-preserving evidence partition: live E2E is opt-in/non-CI and skips without credentials, while concrete representation-gap evidence triggers targeted live preverification and holds only the affected backend.
- `issue-component-cost-bound-missing`: resolved by NFR-SD-004, one-build enforcement, permutation and scale tests, `O((V+E) log V)`-or-better time, and `O(V+E)` auxiliary memory.

## Scope expansion inventory

Provider conformance is the only retained shared-boundary expansion. Mandatory shared faithful-fake/interface verification is required by FR-SD-007/NFR-SD-005 and ADR 0002; ADR 0003 keeps live E2E opt-in, with targeted live preverification only for concrete representation-gap evidence. No new component or interface is introduced; a proved interface gap returns to a separate design rather than expanding this package.
