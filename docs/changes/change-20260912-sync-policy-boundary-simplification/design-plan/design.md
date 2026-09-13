# Sync policy boundary simplification — integrated design

Plan revision: `sync-policy-boundary-simplification-retry-r1`.

<!-- anchor: goal -->
## Goal and scope

Keep the accepted `Observation -> Admission -> Execution -> Commit/finalization` architecture and make conflict-policy flow easier to audit: the persisted `ConflictStrategy` is captured once per cycle, Observation uses it only to decide whether bounded proof acquisition is needed, Admission compiles every conflict into a closed typed execution policy, and downstream execution/audit consume that policy without reinterpreting the raw setting.

This is a behavior-preserving responsibility refactor. It does not add a fifth policy stage, a generic rule engine, a durable policy snapshot, a recovery marker, or another execution route. It does not change provider APIs, conflict-copy naming, action/component order, retry bounds, exact publication CAS, checkpoint closeout, the settings wire, or user-visible conflict outcomes.

In scope:

- the cycle-local strategy capture and Observation-only enrichment gate;
- Admission's conflict-policy compilation and action contract;
- executor/resolver consumption, fail-closed contract validation, and audit projection;
- focused behavior tests, AST ownership guards, active design documentation, and stale subsystem documentation only where touched statements would otherwise contradict the implemented policy boundary.

Out of scope:

- changing `auto_merge`, `prefer_local`, or `duplicate` semantics;
- changing identity-component construction, preservation-cover naming/ordering, scheduling, retry, publication, or working-view lifecycle;
- settings migration or normalization beyond the two sanctioned normalizations;
- provider/backend changes, new persistent schema, new user settings, generic policy DSL/registry, or retained decision evidence;
- resolving unrelated stale documentation about flat execution phases, compensating rollback, or unconditional state writes; those conflicts remain governed by accepted ADRs and need separate documentation cleanup unless an edited paragraph directly depends on them;
- creating or switching a Git branch, which is an execution concern outside this artifact-only draft.

<!-- anchor: approach -->
## Approach

Use one narrow typed boundary rather than another component. Add a required `ConflictExecutionPolicy` discriminated union to every Admission-produced `conflict` action:

```ts
type ConflictExecutionPolicy =
  | { readonly mode: "auto_merge"; readonly strategy: "auto_merge" }
  | { readonly mode: "local_win"; readonly strategy: "prefer_local" }
  | { readonly mode: "preserve"; readonly strategy: ConflictStrategy };
```

`strategy` is provenance for exact audit compatibility; `mode` is the only downstream behavior discriminator. Admission compiles this union from the captured strategy, the already-bound component facts, and the existing preservation-cover protocol. The existing optional `preferLocalDisposition` is retired. `ExecutionContext.conflictStrategy`, the resolver's raw-strategy parameter, and `toConflictRecords`' global strategy parameter are retired. The action itself carries the decision and provenance through execution, terminal result, and audit.

The raw setting remains intentionally visible at only three production concerns:

1. the orchestrator captures `settings.conflictStrategy` once above the attempt loop;
2. Observation uses a local pure predicate to gate Prefer-local SHA-256 acquisition after scope projection;
3. Admission compiles the closed execution policy.

No shared `strategy -> behavior` utility is introduced. Such a utility would become an attractive fifth policy owner. Small pure helpers stay inside their owning layer: an acquisition predicate in `sync-cycle-planning.ts`, a compiler in the Admission-owned identity materializer (or a private Admission-only file if the implementation chooses that layout), exhaustive policy dispatch in `conflict-resolver.ts`, and structural validation in `plan-executor.ts`.

This is `boundary-complete` granularity. The owner, wire shape, mapping table, failure behavior, lifecycle, and verification are fixed. Helper names and same-owner private placement remain reversible implementation discretion.

## Requirements

<!-- anchor: fr-sp-001 -->
### FR-SP-001 — four-owner invariant

The production sync pipeline shall retain exactly four top-level responsibility owners in forward order. Observation shall emit only immutable facts, Admission alone shall authorize actions and conflict policy, Execution shall perform only the exact authorized effects, and Commit/finalization shall publish only proven terminal outcomes and the clean-cycle checkpoint.

<!-- anchor: fr-sp-002 -->
### FR-SP-002 — cycle-consistent strategy

When a cycle burst iteration starts, the orchestrator shall capture one valid normalized `ConflictStrategy` and use that immutable value for every attempt's acquisition and Admission. Changing settings after capture shall not change the actions or audit strategy of that cycle.

<!-- anchor: fr-sp-003 -->
### FR-SP-003 — bounded Observation enrichment

After scope projection and before Admission, Observation shall acquire the existing Prefer-local content hashes only when the captured strategy is `prefer_local`, and only for the existing baseline-backed, same-path, two-sided changed-file, non-topological candidates. `auto_merge`, `duplicate`, excluded paths, and topology-connected candidates shall add no proof reads.

<!-- anchor: fr-sp-004 -->
### FR-SP-004 — Admission-owned typed policy

For every admitted `conflict` action, Admission shall attach exactly one valid `ConflictExecutionPolicy` according to the closed mapping table below. No action or executable policy shall exist before Admission, and no downstream stage shall receive authority to convert a raw strategy into an effect mode.

<!-- anchor: fr-sp-005 -->
### FR-SP-005 — exact execution consumption

Execution and the resolver shall consume only the action's typed policy and fixed protocol. A missing, malformed, or protocol-incompatible policy shall fail fatally before conflict input reads, preservation writes, original-path effects, or publication. A proof mismatch or newly occupied destination shall remain blocked and shall not select another policy.

<!-- anchor: fr-sp-006 -->
### FR-SP-006 — outcome compatibility

For equal complete current facts and the same captured strategy, the refactored pipeline shall produce the same admitted actions, preservation requirements, resolver outcome, exact effects, ordered conflict paths, per-file publications, completion classification, and later retry convergence as the current pipeline.

<!-- anchor: fr-sp-007 -->
### FR-SP-007 — action-carried audit provenance

For each resolved conflict, audit projection shall record the `strategy` carried by that exact admitted action and the resolver's exact result. The best-effort 500-record history behavior shall remain supplementary and shall not affect cycle success or tracker acknowledgement.

<!-- anchor: nfr-sp-001 -->
### NFR-SP-001 — structural enforceability

Repository guards shall mechanically reject raw strategy interpretation in Execution/resolver/audit, conflict actions without the typed policy, imports that make a private Admission helper independently callable by another stage, action-bearing Observation, new retained proof/policy state, and new durable writers.

<!-- anchor: nfr-sp-002 -->
### NFR-SP-002 — no cost or state expansion

The refactor shall add no provider calls, no persistent or cross-cycle state, no new retry, and no extra read for `auto_merge` or `duplicate`. The existing transfer pool, globally serial complex-component interval, and commit/abort rules remain unchanged.

## Components and repository grounding

<!-- anchor: component-cycle-coordination -->
### component-cycle-coordination

Responsibility: capture the normalized strategy once per cycle burst, pass it to attempt-local Observation and Admission, and persist conflict audit records after closeout without becoming a policy owner.

- Kind/paths: existing; `src/sync/orchestrator.ts`, `src/sync/execution-result.ts`, `src/sync/conflict-history.ts`.
- Integration points: `executeWithRetry`, `executeSyncOnce`, `prepareSyncCycleSnapshotForExecution`, `admitBatchObservation`, `toConflictRecords`.
- Test seams: the mid-cycle setting-change regression and conflict-history projection tests.
- Accepted ADRs: `adr-20260903-four-stage-sync-pipeline`, `adr-20260905-fact-first-component-admission`, ADR 0001.
- Unresolved contract IDs: none.

<!-- anchor: component-observation -->
### component-observation

Responsibility: scope and freeze facts and perform only the strategy-gated acquisition required to make the already accepted Prefer-local Admission rule decidable.

- Kind/paths: existing; `src/sync/sync-cycle-planning.ts`, `src/sync/change-hash-enrichment.ts`.
- Integration point: `prepareSyncCycleSnapshotForExecution` before `admitBatchObservation`.
- Test seams: `src/sync/sync-cycle-planning.test.ts` read spies and fact-only AST carrier inventory.
- Accepted ADRs: `adr-20260903-four-stage-sync-pipeline`, `adr-20260905-fact-first-component-admission`.
- Unresolved contract IDs: none.

<!-- anchor: component-admission -->
### component-admission

Responsibility: remain the sole conflict-policy authority, bind identity/topology/current facts, compile a complete action-level policy, and authorize the exact plan.

- Kind/paths: existing with an optional planned private helper location; `src/sync/plan-admission.ts`, `src/sync/identity-component-decision.ts`, `src/sync/types.ts`, optionally `src/sync/conflict-policy-admission.ts`.
- Integration points: `admitBatchObservation` and the canonical exact-path materializer.
- Test seams: `src/sync/plan-admission.test.ts`, `sync-admission-authority-guard.test.mjs`.
- Accepted ADRs: all three reviewed modern Admission ADRs.
- Unresolved contract IDs: none; helper placement is typed discretion, not a contract gap.

<!-- anchor: component-execution -->
### component-execution

Responsibility: validate and execute the typed policy and fixed protocol, revalidate exact inputs, and report exact terminal outcomes to the existing Commit/finalization owner.

- Kind/paths: existing; `src/sync/plan-executor.ts`, `src/sync/conflict-resolver.ts`, `src/sync/execution-result.ts`.
- Integration points: `executePlan`, `executeConflictAction`, `resolveConflict`, `toConflictRecords`, and the existing terminal handoff to `commitAction`.
- Test seams: `src/sync/plan-executor.test.ts`, `src/sync/conflict-resolver.test.ts`, `src/sync/fact-first-execution.test.ts`, `src/sync/convergence.test.ts`.
- Accepted ADRs: `adr-20260903-four-stage-sync-pipeline`, `adr-20260905-fact-first-component-admission`.
- Unresolved contract IDs: none.

<!-- anchor: component-terminal-publication -->
### component-terminal-publication

Responsibility: own the fourth forward stage by publishing a file's proven terminal `SyncRecord`, committing only a wholly clean cycle checkpoint, and aborting every incomplete or exceptional attempt before classification or retry.

- Kind/paths: existing; `src/sync/state-committer.ts`, `src/sync/sync-cycle-finalization.ts`.
- Integration points: `commitAction` consumes Admission-authored publication expectations plus ordered successful Execution receipts; `runSyncCycleAttempt` applies exactly one attempt closeout.
- Test seams: `src/sync/state-committer.test.ts`, `src/sync/sync-cycle-finalization.test.ts`, `src/sync/fact-first-execution.test.ts`, `src/sync/convergence.test.ts`, `sync-state-ownership-guard.test.mjs`.
- Accepted ADRs: `adr-20260903-four-stage-sync-pipeline`, `adr-20260905-fact-first-component-admission`, ADR 0001.
- Unresolved contract IDs: none. This is the already accepted fourth owner, not a new runtime component.

## Data flow and decision rules

The intended flow is:

```text
normalized setting
  -> orchestrator cycle capture (immutable ConflictStrategy)
  -> Observation acquisition gate -> fact-only BatchObservation
  -> Admission identity binding -> required ConflictExecutionPolicy per conflict action
  -> Execution validation -> resolver policy-mode dispatch / fixed preservation protocol
  -> terminal ExecutionResult -> Commit/finalization exact per-file publication
  -> wholly clean checkpoint commit or non-clean working-view abort
  -> action-carried strategy audit projection
```

Admission's mapping is exhaustive and ordered:

| Current admitted conflict shape | Captured strategy | Typed policy |
|---|---|---|
| `protocol.kind === preservation_cover` | any valid strategy | `{ mode: "preserve", strategy }` |
| ordinary conflict | `duplicate` | `{ mode: "preserve", strategy: "duplicate" }` |
| ordinary conflict with the existing complete local-win proof | `prefer_local` | `{ mode: "local_win", strategy: "prefer_local" }` |
| any other ordinary conflict | `prefer_local` | `{ mode: "preserve", strategy: "prefer_local" }` |
| ordinary conflict | `auto_merge` | `{ mode: "auto_merge", strategy: "auto_merge" }` |

The existing local-win proof is unchanged: one non-topological same path; local, remote, and a non-empty same-key baseline present; complete hashes; both current hashes differ from the baseline and from one another; no move, replacement, additional endpoint, or alternate address. Incomplete facts fail or select preservation exactly as today; this change does not widen eligibility.

The union makes invalid combinations unrepresentable in normal TypeScript code: `local_win` cannot claim `duplicate`, and `auto_merge` cannot claim `prefer_local`. Runtime validation remains required at the executor boundary because tests, stale serialized fixtures, or unsafe casts can fabricate malformed actions. `preservation_cover` additionally requires `mode: preserve`; any other combination is a terminal invariant violation.

Operational-input continuity is closed as follows:

| ID | Kind / data scope | Owner / producer | Source and acquisition | Required until / preservation | Mutation, invalidation, and unavailable outcome |
|---|---|---|---|---|---|
| `input-cycle-strategy` | information / single value | `component-cycle-coordination` / normalized plugin settings | `settings.conflictStrategy`, captured at burst-iteration start above the retry loop | audit projection for every attempt / immutable value copied by value | settings may change later but cannot invalidate the captured primitive; missing/out-of-union input fails before Observation |
| `input-bound-conflict-facts` | information / full component | `component-admission` / existing fact indexing and identity binding | immutable `BatchObservation`, acquired while deciding one component | exact action materialization / current-call snapshot | immutable after capture; incomplete/contradictory facts retain existing Admission failure or preservation outcome |
| `input-action-policy` | authority / one action | `component-execution` / `component-admission` | required field on the exact `AuthorizedSyncPlan` conflict action, acquired with plan consumption | resolver outcome and audit projection / immutable value embedded in action | provider facts may change but policy may not; missing/malformed/incompatible policy is a terminal invariant error before I/O |
| `input-terminal-publication-evidence` | authority / one action plus one attempt | `component-terminal-publication` / Admission and Execution | admitted exact publication expectations plus ordered successful child receipts and settled attempt result | exact per-file CAS and one commit-or-abort closeout / attempt-local carriers only | missing terminal proof or CAS mismatch publishes no false record and makes the attempt non-clean; incomplete/exceptional closeout aborts the live derived view without changing durable checkpoint or provider content |

No external identity, clock, versioned service state, or new persistent source is required to make the policy decision. Existing current filesystem revalidation is deliberately not copied into the policy; its invalidation remains executor-owned block/failure evidence.

## Implementation contract candidates

<!-- anchor: contract-observation-policy-gate -->
### contract-observation-policy-gate

Dimension: control flow and resource management. Owner: `component-observation`. Requirements: FR-SP-002/003 and NFR-SP-002. Evidence mode: total.

Operational input `input-cycle-strategy` is an immutable normalized `ConflictStrategy` produced by `component-cycle-coordination`, captured at burst-iteration start, passed by value to every attempt, and required until Admission completes. Settings may mutate after acquisition; immutability of the captured primitive is the stability basis. If unavailable or outside the closed union, the cycle must fail before Observation rather than defaulting in a downstream layer.

Normal witness: `prefer_local` with one eligible same-path conflict performs the already bounded local/remote proof reads and Admission can prove local win. Adversarial witness (`boundary`, `scale`): a batch containing excluded, rename-connected, `auto_merge`, and `duplicate` candidates performs no additional proof reads for those candidates. Forbidden result: a shared helper turns the acquisition hint into an action or reads before scope projection. Verification: `verify-observation-read-gate`, `verify-admission-owner-guard`.

No cost-convergence profile is needed beyond the existing bounded candidate filter: the contract forbids new work rather than introducing a new scalable algorithm.

<!-- anchor: contract-admission-policy-compiler -->
### contract-admission-policy-compiler

Dimension: integration contract and control flow. Owner: `component-admission`. Requirements: FR-SP-001/004/006 and NFR-SP-001. Evidence mode: total.

Inputs are immutable `input-cycle-strategy` and `input-bound-conflict-facts`. The latter is produced by the existing Admission identity materializer from the current `BatchObservation`; it is a current-call snapshot required only until the `AuthorizedSyncPlan` is returned and is never retained. Incomplete identity/content evidence follows existing Admission failure/preservation rules; the policy compiler cannot request I/O, repair facts, or choose identity.

The compiler applies the exhaustive table above and emits `input-action-policy`, an immutable value embedded in the exact action and required through audit projection. Normal witnesses cover all five rows. Adversarial witness (`malformed`, `boundary`): a Prefer-local compound conflict whose simple path happens to have hashes must still compile to `preserve`; moving the hash predicate into a generic strategy helper would incorrectly emit `local_win` and fail the focused Admission matrix.

Observable: equal complete component facts and equal strategy produce one equal typed policy and the same action/protocol order. Forbidden: optional/default policy, raw strategy on ExecutionContext, a callable cross-stage policy registry, or module-scope retained proof. Verification: `verify-policy-mapping-matrix`, `verify-admission-owner-guard`, `verify-convergence-matrix`.

Contract-evolution profile: the private TypeScript action seam changes from optional `preferLocalDisposition` plus out-of-band `ExecutionContext.conflictStrategy` to required `ConflictExecutionPolicy`. All production constructors, test fixtures, resolver calls, and audit projection migrate atomically in one change. Persisted settings and `ConflictRecord.strategy` remain wire-compatible; there is no database migration or mixed-version runtime fallback. Rollback is a single source commit reverting all consumers.

<!-- anchor: contract-execution-policy-consumption -->
### contract-execution-policy-consumption

Dimension: failure recovery and integration contract. Owner: `component-execution`. Requirements: FR-SP-005/006 and NFR-SP-001/002. Evidence mode: fallible.

Operational input `input-action-policy` is produced by Admission, embedded in the immutable authorized action, and remains valid for that action's attempt through resolver outcome and audit. Execution must not reacquire settings. Existing current filesystem state remains the authority for pre-effect revalidation; it may change after Admission, in which case the existing block/failure semantics apply without policy conversion.

Outcome partition:

- determinate: valid policy and current preconditions produce the policy's existing exact resolver/preservation outcome and terminal evidence for Commit/finalization;
- inconclusive: source/destination/proof changed or became unprovable, so the action blocks or fails under existing typed error semantics and hands a non-success result to Commit/finalization without policy conversion;
- unknown: the typed policy is missing, malformed, or protocol-incompatible, so a terminal invariant error occurs before conflict I/O and the cycle abort route remains authoritative.

Normal witness: ordinary Auto merge consumes `mode:auto_merge` and preserves current merge/newer/tie behavior. Adversarial witnesses (`stale`, `recovery`, `malformed`): a destination arrives after Admission; a later child fails after a preservation prefix; an unsafe-cast action lacks policy. Forbidden: fallback to duplicate, rereading settings, compensating rollback, replaying the completed prefix, or publication after invalid policy. Verification: `verify-executor-policy-validation`, `verify-conflict-resolver-matrix`, `verify-interruption-convergence`, `verify-state-owner-guard`.

<!-- anchor: contract-publication-lifecycle -->
### contract-publication-lifecycle

Dimension: state lifecycle and concurrency. Owner: `component-terminal-publication`. Requirements: FR-SP-001/005/006 and NFR-SP-002. Evidence mode: fallible.

Operational input `input-terminal-publication-evidence` is produced from the Admission-authored exact publication expectation and Execution's ordered successful child receipts after scheduled siblings settle. It is attempt-local, is required through per-file publication and attempt closeout, and is not retained as recovery evidence. Commit/finalization does not interpret `ConflictExecutionPolicy`, choose identity, replay effects, or mutate the provider.

Outcome partition:

- determinate: terminal proof succeeds and exact compare-and-put/delete/move/rewrite CAS publishes the file's `SyncRecord`; if every admitted action completes cleanly, the same attempt commits the remote cursor/derived cache/scope checkpoint exactly once;
- conflicting: terminal proof or exact CAS disagrees with current durable state, so that action publishes no success and the attempt is non-clean without overwriting a newer record;
- inconclusive: any action is blocked/failed or the attempt throws, so scheduled siblings first settle and the live derived working view aborts exactly once before classification or retry; existing successful per-file publications remain, durable checkpoint/provider content are not cleared, and the next attempt re-observes current facts.

Normal witness: a wholly clean attempt publishes each proven action and then its checkpoint. Adversarial witnesses (`state_lifecycle`, `concurrency`, `recovery`): I/O succeeds but terminal proof or CAS fails; one preservation child succeeds and a later suffix fails; attempt code throws after siblings were scheduled. Forbidden: Execution owning `commitAction`, unconditional record writes, checkpoint commit on partial success, abort before sibling settlement, rollback, prefix replay, or retained recovery/policy state. Verification: `verify-proven-publication`, `verify-attempt-closeout`, `verify-state-owner-guard`.

<!-- anchor: contract-cycle-audit-provenance -->
### contract-cycle-audit-provenance

Dimension: user observability and state lifecycle. Owner: `component-cycle-coordination`. Requirements: FR-SP-002/006/007. Evidence mode: total.

Audit consumes only resolved conflict results whose actions already carry `input-action-policy`; `toConflictRecords` projects `policy.strategy` and exact result fields. A mid-cycle settings mutation cannot affect the record. The JSON append remains capped at 500 and best-effort after attempt closeout.

Normal witness: a captured Prefer-local cycle whose setting changes to Auto merge records `prefer_local` and `kept_local`/`duplicated` according to the admitted policy. Adversarial witness (`concurrency`, `repeated_usage`): multiple conflicts with distinct action instances are projected without one global current-setting argument; an audit write failure logs once and does not change a clean completion or tracker acknowledgment. Verification: `verify-cycle-strategy-consistency`, `verify-audit-projection`.

Input closure: session id and resolution timestamp are existing supplementary immutable values and do not decide sync behavior. No new operational authority or persistent versioned state is introduced.

## Accepted ADR context and decision inputs

Accepted ADR search completed over `docs/adr/`, with `adr-20260903-four-stage-sync-pipeline`, `adr-20260831-admission-owns-identity-component-decisi`, `adr-20260905-fact-first-component-admission`, and ADR 0001 reviewed and applicable. This plan implements their existing ownership claims more literally; it does not require a new ADR. The persistent active design `design-four-stage-sync-pipeline` should receive a small upsert stating that Admission emits the closed action-level conflict policy and Execution/audit do not reinterpret the setting. No responsibility or owner is added or retired.

<!-- anchor: adr-20260831-admission-owns-identity-component-decisi -->
<!-- anchor: adr-20260903-four-stage-sync-pipeline -->
<!-- anchor: adr-20260905-fact-first-component-admission -->
<!-- anchor: adr-0001-commit-last-recovery -->

Decision inputs and dispositions:

| ID | Source kind / ref | Authority | Candidate | Requirement refs | Classification | Comparison baseline | Disposition |
|---|---|---|---|---|---|---|---|
| `decision-input-user-simplify-boundaries` | user requirement / `planning-source.txt:1` | candidate | simplify scattered strategy/conditions through responsibility boundaries | FR-SP-001/004/005 | design choice | retain current raw parameters and conditionals | adopt one Admission-produced typed action boundary |
| `decision-input-user-helper-option` | user requirement / `planning-source.txt:3` | candidate | use helper functions/modules | FR-SP-004, NFR-SP-001 | design choice | shared strategy service or no extraction | allow only responsibility-local pure helpers; placement is discretion |
| `decision-input-four-stage-ownership` | accepted ADR / `adr-20260903-four-stage-sync-pipeline` | constraint | exactly four owners and forward dependency | FR-SP-001 | design choice | add a policy stage/service | preserve unchanged; reject a fifth owner |
| `decision-input-admission-single-authority` | accepted ADR / `adr-20260831-admission-owns-identity-component-decisi` | constraint | Admission owns component policy and exact action authorization | FR-SP-004/005 | design choice | resolver reinterprets raw settings | compile once in Admission; consume downstream |
| `decision-input-fact-only-observation` | repository policy / `AGENTS.md` and active design BOUNDARY-003/010 | constraint | Observation carries facts and bounded acquisition only | FR-SP-003 | design choice | action/policy-bearing observation | preserve fact-only carrier |
| `decision-input-cycle-strategy-capture` | repository policy / `src/sync/orchestrator.ts:167-214` | constraint | one cycle value across attempts and audit | FR-SP-002/007 | design choice | reread settings at each stage | preserve capture; carry provenance on action |
| `decision-input-prefer-local-safety` | repository policy / current Admission tests and `AGENTS.md` | constraint | exact local-win proof, otherwise preservation | FR-SP-004/006 | design choice | widen eligibility or permissive default | preserve exact partition in compiler |
| `decision-input-unified-conflict-route` | repository policy / `AGENTS.md` and active design BOUNDARY-008 | constraint | one conflict resolver/executor route with preservation before effects | FR-SP-005/006 | design choice | strategy-specific executor paths | preserve one route and typed mode dispatch |
| `decision-input-ordered-publication` | accepted ADR / `adr-20260905-fact-first-component-admission` | constraint | ordered serial complex interval and exact publication | FR-SP-006, NFR-SP-002 | design choice | regroup by strategy/action kind | preserve unchanged |
| `decision-input-stateless-retry` | accepted ADR / `0001-metadata-cache-is-subordinate-to-commit-last.md` | constraint | close attempt once and re-observe from durable A/B | FR-SP-005/006 | design choice | retain policy/failure/recovery marker | preserve stateless retry |
| `decision-input-settings-wire` | repository policy / `src/sync/types.ts`, `src/settings-normalize.ts` | constraint | keep closed persisted union and audit field | FR-SP-002/006 | design choice | new wire value or migration | retain wire/default/normalization unchanged |
| `decision-input-structural-verification` | repository policy / `docs/code-enforcement.md` and ownership guards | constraint | reject merely relocated conditionals and new owners | NFR-SP-001 | design choice | behavior tests alone | extend structural plus behavior verification |

The three recovered documentation conflicts are evidence conflicts, not candidate authorities. They are explicitly excluded from this implementation except for directly touched sentences, and cannot override accepted ADRs.

The supplied recovery also contains two medium runtime unknowns: whether the current branch passes the full gate and whether Prefer-local is already shipped or only branch-local. Neither changes the selected internal boundary because this design preserves both current behavior and the persisted wire. They remain verification/rollout facts, not open design choices. Refreshed startup evidence is likewise verification input, not a design premise.

## Typed implementation discretion

`discretion-policy-helper-placement` belongs to `unit-admission-policy`. The implementer may keep the pure compiler private in `identity-component-decision.ts` or place it in a new `src/sync/conflict-policy-admission.ts` imported only by that Admission owner. The choice must preserve `contract-admission-policy-compiler` and its structural/mapping verification. Escalate if another production stage imports the compiler, the helper accepts filesystem/state capabilities, it retains module state, it decides identity eligibility, or the split requires files outside the declared unit.

`discretion-policy-validator-shape` belongs to `unit-execution-consumption`. The implementer may use an exhaustive local assertion or an exhaustive `switch` with a `never` check, provided unsafe-cast malformed actions fail before I/O. Escalate if validation defaults a missing variant, changes public error/status behavior, or becomes a second policy compiler.

No evidence-seeking design decision is required. Repository code and focused tests already expose every needed seam. The unknown full-gate status is handled by verification, not a spike.

## Dependency-ordered implementation units

### unit-policy-contract-red — pin ownership and compatibility first

Add RED mapping/negative tests and extend the structural guard to define the permitted raw-strategy interpretation sites, required conflict policy, Admission-only compiler import, no retained state, and no downstream defaults. Do not change production behavior in this unit. Exit when tests distinguish the planned boundary from both the current scattered flow and a merely relocated generic helper.

### unit-admission-policy — materialize the typed policy in Admission

Define `ConflictExecutionPolicy`, make it required on conflict actions, replace `preferLocalDisposition`, and compile it in the canonical Admission materialization path using the closed table. Update Admission fixtures and focused tests. Keep identity, component, action order, protocol, and publication facts unchanged. Depends on `unit-policy-contract-red`.

### unit-execution-consumption — remove downstream raw policy authority

Remove `ExecutionContext.conflictStrategy`; validate the action policy before conflict I/O; make resolver dispatch on `policy.mode`; keep preservation protocol and all exact revalidation/effect behavior unchanged. Preserve the separate Commit/finalization owner by leaving `state-committer.ts` and `sync-cycle-finalization.ts` behavior unchanged and pinning proven publication plus one-closeout semantics in their focused tests. Depends on `unit-admission-policy`.

### unit-cycle-audit-docs — close cycle provenance and documentation

Make conflict audit projection read each action policy's `strategy`, delete the global strategy argument, retain cycle-capture behavior, update focused orchestration/history tests, and update the active four-stage design plus directly affected pipeline/conflict docs. Run ownership/state guards and the complete repository gate. Depends on `unit-execution-consumption`.

## Verification and acceptance

- `acceptance-policy-owner`: static inspection/AST guard finds raw `ConflictStrategy` interpretation only in normalization/UI, cycle capture/acquisition gating, and Admission compilation; Execution, resolver, and audit contain no raw-strategy branch or settings lookup. Covers FR-SP-001/004/005 and NFR-SP-001.

- `acceptance-policy-matrix`: focused Admission/resolver tests cover every mapping-table row, including preservation cover under all three provenance values, exact Prefer-local local-win proof, every fallback-to-preserve condition, and Auto merge merge/newer/tie outcomes. Covers FR-SP-004/006.

- `acceptance-read-bound`: read spies prove no added proof read for Auto merge, Duplicate, excluded paths, or topology-connected candidates, while eligible Prefer-local remains decidable. Covers FR-SP-003 and NFR-SP-002.

- `acceptance-malformed-fail-closed`: missing/invalid/incompatible action policy reaches terminal invariant failure before read/write/delete/rename/commit; a fresh destination or proof mismatch blocks without policy conversion. Covers FR-SP-005.

- `acceptance-cycle-audit`: changing settings after cycle capture does not change execution or the recorded strategy; ordered duplicate paths and the compatibility first path remain unchanged; audit failure stays best-effort. Covers FR-SP-002/007.

- `acceptance-state-and-retry`: interruption/convergence tests prove no new persistent or in-memory owner, successful child publications remain, incomplete attempts abort once after siblings settle, and retries re-observe current facts. Covers FR-SP-006 and NFR-SP-002.

- `acceptance-repository-gate`: `npm run lint`, `npm run lint:bot-repro`, `npm run build`, and `npm run test:coverage` all pass without rule suppression; actual Obsidian/live-backend acceptance remains separate because no provider behavior changes. Covers NFR-SP-001/002.

## Resolved issues

The canonical `resolved_issues` ledger closes every `verdict:Y` critique item one-to-one:

- `issue_ref: issue-commit-owner-grounding` — patch adopted exactly at the existing boundary: `component-terminal-publication` and `contract-publication-lifecycle` now own `src/sync/state-committer.ts`, `src/sync/sync-cycle-finalization.ts`, proven per-file publication, clean-cycle checkpoint commit, and non-clean abort. Those paths and responsibilities were removed from `component-execution`. This adds no runtime owner or mechanism; it makes the accepted fourth owner independently attributable and prevents implementations from relocating `commitAction` or attempt closeout into Execution while satisfying only the policy-consumption contract.

## Open questions

There is no consequential open design choice. The integrator should preserve the helper-placement and validator-shape discretion above. Before implementation is declared complete, the current branch's full gate must be executed. Release planning may separately establish whether Prefer-local has shipped, but no compatibility fork or migration is authorized by that uncertainty.
