# Case-alias postcondition proof unification

<!-- anchor: goal -->
## Goal

Repair the ordinary case-only parent retry that already reaches a complete normalized action set and is then rejected by a second, action-unaware stable-identity check. Admission remains the sole action authority: component-local helpers shape one candidate, `evaluateIdentityComponent` supplies the only final postcondition verdict, and `admitDestructivePlan` emits exactly one existing disposition from that verdict.

This is not a recovery feature. A valid target-keyed child `SyncRecord` is an ordinary terminal fact left by successful I/O. The next COLD, WARM, or HOT attempt re-observes current facts and uses the same Admission semantics. The change adds no persisted evidence, pending work, recovery instruction, action kind, disposition, failure reason, status, schema, provider behavior, executor inference, or correctness-critical memory.

<!-- anchor: scope -->
## Scope

The production repair is confined to the Admission orchestration and final identity-component proof in `src/sync/plan-admission.ts` and `src/sync/identity-component-decision.ts`. `src/sync/plan-admission-case-alias.ts` remains the existing candidate producer and `src/sync/plan-admission-graph.ts` remains the existing component carrier. Focused tests cover Admission, the production-shaped orchestrator path, execution/finalization compatibility, and the state-ownership guard. The persistent four-stage design and existing Admission ADR wording are clarified during implementation; no new ADR is needed.

Provider adapters, provider calls, action/disposition types, Observation facts, executor phases, per-file commit semantics, checkpoint lifecycle, schema, migration, and all cross-cycle recovery mechanisms are out of scope. Fresh dependency evidence is a hard pre-implementation gate: a newly observed caller, owner, or cross-boundary dependency stops work and returns this design for revision.

<!-- anchor: approach -->
## Chosen approach

Keep the existing component builder, case-alias parent normalizer, action vocabulary, executor phases, and two durable authorities. Reduce the conflicting Admission policy to one flow:

1. Build one exhaustive component from immutable current-cycle facts.
2. Shape all applicable local/native/case-alias actions into one candidate; shaping may decline or report existing malformed evidence but cannot authorize, settle, or emit a disposition.
3. Derive one validated topology-coverage relation from that final action candidate exactly once.
4. Have alias and stable-identity predicates consume that same relation while the final evaluator applies all existing negative predicates and reason precedence.
5. Emit exactly one existing component disposition, and expose actions to Execution only for an empty final reason set.

Coverage is not inferred from spelling or intended topology. For an opaque remote identity, the eligible stable edge is exactly its unique current occurrence to its unique committed baseline occurrence. A parent action covers that edge only when its already-validated complete descendant mapping contains that exact directed pair. An intended endpoint that does not contain the identity's unique baseline occurrence is not evidence and cannot substitute for it.

## Requirements

<!-- anchor: fr-capu-001 -->
### FR-CAPU-001 — one terminal postcondition owner

Every applicable case-alias parent component has one normalized candidate and reaches `evaluateIdentityComponent` exactly once before a disposition is emitted. `normalizeCaseAliasParentTransition`, `normalizeLocalMove`, and other shaping helpers may not return a terminal component authorization or settlement to `admitDestructivePlan`.

<!-- anchor: fr-capu-002 -->
### FR-CAPU-002 — ordinary mixed-record authorization

When complete current facts contain a valid target-keyed child `SyncRecord`, its unique current provider-old occurrence, retained child content work, and one complete included case-only parent mapping, Admission authorizes the existing content action(s) followed by exactly one existing parent `rename_remote` action.

<!-- anchor: fr-capu-003 -->
### FR-CAPU-003 — exact current-to-baseline identity coverage

A cross-path stable-identity edge without controlling reported rename evidence is covered only by the exact directed pair from the identity's unique current occurrence to its unique committed baseline occurrence in one validated complete parent mapping. A local intent, action destination, same-looking path, or baseline belonging to another identity cannot establish the edge.

<!-- anchor: fr-capu-004 -->
### FR-CAPU-004 — fail-closed negative preservation

Unrelated, absent, incomplete, crossed, duplicated, wrongly directed, out-of-scope, unresolved, or identity-conflicting coverage retains the existing applicable reason and yields no partial executable component action.

<!-- anchor: fr-capu-005 -->
### FR-CAPU-005 — compatibility

Reported native rename decisions, unbaselined single-file case-alias canonicalization, standalone deletion authority, reason vocabulary and precedence, and disconnected proposal order remain unchanged.

<!-- anchor: fr-capu-006 -->
### FR-CAPU-006 — acquisition-temperature equivalence

Equal complete immutable component facts produce the same actions, disposition, and reasons after COLD, WARM, or HOT acquisition. Temperature, global record count, schema version, and prior outcome are not decision inputs.

<!-- anchor: fr-capu-007 -->
### FR-CAPU-007 — unchanged commit and retry authority

Each file record remains post-I/O authority. Cursor, complete derived cache, and scope remain clean-cycle commit-last authority. Any incomplete attempt aborts its live view and retries through ordinary current-fact acquisition.

<!-- anchor: nfr-capu-001 -->
### NFR-CAPU-001 — closed mechanism set

The repair introduces no action, disposition, status, failure reason, evidence kind, provider branch, persisted field, schema, migration, recovery branch, exported policy owner, or correctness-critical in-memory owner.

<!-- anchor: nfr-capu-002 -->
### NFR-CAPU-002 — one linear coverage derivation

The evaluator derives one validated coverage relation exactly once per component, with no I/O, in `O(A + D + E + S)` time and `O(D)` auxiliary space. `A` is candidate actions, `D` mapped descendant pairs, `E` evidence items, and `S` relevant scope endpoints. Alias and stable-identity rules reuse that relation; repeated scans per edge or a separately derived second coverage notion are non-conforming.

<!-- anchor: nfr-capu-003 -->
### NFR-CAPU-003 — fresh implementation evidence

Dependency and change-surface evidence must be current and green before production edits. Unknown, stale, conflicting, or scope-expanding evidence stops implementation rather than being treated as confirmation.

## Accepted architecture context

<!-- anchor: adr-20260831-admission-owns-identity-component-decisi -->
`adr-20260831-admission-owns-identity-component-decisi` assigns component shaping, authorization, and disposition to Admission. Its older deferred/rename-debt wording is not current recovery authority and must be clarified against the later stateless decision.

<!-- anchor: adr-0008-logical-identity-admission-fails-closed -->
`adr-0008-logical-identity-admission-fails-closed` requires complete current component facts, exact included folder mappings, visible non-clean failure, and fact-equivalent decisions across acquisition temperatures.

<!-- anchor: adr-20260903-four-stage-sync-pipeline -->
`adr-20260903-four-stage-sync-pipeline` keeps Observation factual, Admission authoritative, Execution exact, and Commit terminal. The persistent design projection gains the clarified invariant that candidate normalization is non-terminal and one final Admission evaluator owns postcondition proof.

<!-- anchor: adr-20260903-stateless-current-state-recovery -->
`adr-20260903-stateless-current-state-recovery` prohibits persisted intent/failure recovery and requires ordinary re-observation after incomplete work.

<!-- anchor: adr-0001-metadata-cache-is-subordinate-to-commit-last -->
`adr-0001-metadata-cache-is-subordinate-to-commit-last` leaves exactly two durable authorities: successful per-file records and the wholly clean cursor/cache checkpoint.

No responsibility boundary, action vocabulary, public contract, or durable authority changes, so no new ADR is proposed.

<!-- anchor: component-admission-pipeline -->
## Component: compositional Admission pipeline

`src/sync/plan-admission.ts` owns production orchestration and component disposition construction. `src/sync/plan-admission-case-alias.ts` and existing local/native helpers shape candidate actions. `src/sync/identity-component-decision.ts` owns the generic final proof. `src/sync/plan-admission-graph.ts` carries the immutable connected component. The integration seam is the per-component loop in `admitDestructivePlan`; the deterministic test seam is `src/sync/plan-admission.test.ts`.

<!-- anchor: component-admission-regression-harness -->
## Component: Admission regression harness

`src/sync/plan-admission.test.ts` owns exact positive, negative, complexity-structure, and terminal-owner regressions. `src/sync/orchestrator.test.ts` owns production-shaped acquisition and retry observations. `sync-state-ownership-guard.test.mjs` rejects a third authority. Tests enter through existing public Observation/Admission seams and assert actions, disposition count/kind, reasons, event order, and checkpoint publication rather than private helper return values.

<!-- anchor: component-existing-execution-and-commit -->
## Component: existing Execution and Commit

`src/sync/plan-executor.ts`, `src/sync/state-committer.ts`, and `src/sync/sync-cycle-finalization.ts` consume the authorized plan and terminal results unchanged. They are compatibility owners, not implementation targets. Their tests prove that the Admission-only repair preserves content-before-structural ordering, post-I/O file commits, working-view abort, and clean-cycle checkpoint-last.

<!-- anchor: contract-fresh-evidence-and-regression -->
## Contract: fresh evidence and discriminating regression lock

Before production edits, current evidence must confirm the single production path, owners, and files named by this plan. The positive target-record RED and the existing negative matrix are necessary but insufficient: the regression set must also reject each of the three critic-identified wrong implementations.

The terminal-owner discriminator constructs one component for which `normalizeLocalMove` returns a determinate candidate while the same remote-current `(side, phase, path)` slot carries a second, different opaque identity key. That second key is an evaluator-owned `conflicting_identity` fact that the current pre-evaluator terminal route ignores. The observable result must be exactly one `failed` disposition containing the existing `conflicting_identity` reason and zero executable actions. An `authorized` or `resolved_no_action` result, more than one disposition, or any action proves that terminal authorization still happened before the evaluator.

The edge-identity discriminator keeps the action destination/intended path fixed while moving or removing the same opaque identity's committed baseline occurrence. Only the exact unique baseline occurrence case may be covered. An intended endpoint with no matching baseline occurrence must remain `identity_postcondition_unproven`. Unrelated, partial, crossed, duplicated, reversed, covered-plus-uncovered, unresolved, and conflicting controls retain their existing reasons.

## Contract: one final postcondition evaluation

<!-- anchor: contract-single-final-postcondition -->
### Ownership and operational inputs

| Input | Producer and source | Lifetime | Invalid or unavailable result |
|---|---|---|---|
| `input-component-facts` | Observation plus committed records / immutable Admission component | One current cycle | Existing unresolved, scope, delete, alias, or identity reason; never fallback authorization |
| `input-normalized-actions` | Existing Admission shapers / one local candidate value | Same component, before final proof | Candidate absence leaves ordinary evaluation; malformed evidence retains its existing reason |
| `input-topology-coverage` | Final evaluator / validated normalized folder actions, evidence, and scope | Derived once, read-only, discarded before return | Missing edge is uncovered; invalid data cannot become heuristic coverage |
| `input-final-reasons` | `evaluateIdentityComponent` / existing reason vocabulary | One returned set per component | Any reason yields one failed, non-clean disposition |

`rule-candidate-only`: normalizers may shape actions or decline a shape. They do not append to `authorizedActions`, construct a disposition, or bypass the evaluator.

`rule-one-evaluator-call`: every normalized component reaches `evaluateIdentityComponent` exactly once. Its result is the only final reason set. `admitDestructivePlan` maps the returned reasons and candidate action count to exactly one existing disposition, with no pre- or post-evaluator allowlist.

`rule-negative-precedence`: unresolved observations, unknown observations/scope, conflicting identity, opposing deletes, alias mutation, unsafe reported rename, and unproven standalone delete retain their current reason precedence. Positive topology coverage is not a waiver.

The outcome partition remains determinate, unknown, inconclusive, or conflicting. Only a determinate empty final reason set authorizes or resolves no action. All other outcomes produce the existing failed/non-clean result and no executable action.

<!-- anchor: contract-exact-topology-coverage -->
## Contract: exact, shared, linearly bounded topology coverage

### Exact relation

For each `stable_identity(remote)` item relevant to a no-reported-rename cross-path proof:

- there must be exactly one current occurrence and exactly one committed baseline occurrence for the same opaque `identityKey` within the component;
- the covering action must be an existing `rename_remote(currentParent, targetParent, isFolder=true)` in that component;
- the action must first pass the existing full mapping constraints: aligned relative suffixes, included source and target endpoints, complete managed endpoint coverage, no crossed or duplicate endpoint, safe occupancy, and authoritative observations;
- the validated descendants must contain exactly the directed pair `currentOccurrence.path -> baselineOccurrence.path`;
- `targetParent` or another intended endpoint is immaterial unless it is also that identity's unique committed baseline occurrence.

Prefix membership alone, action destination alone, case-fold equality, equal content, another identity's baseline, a different parent action, an incomplete mapping, reverse direction, or a pair assembled from separate actions never establishes coverage. Every stable edge must be covered; a covered sibling cannot mask one uncovered edge.

### One derivation and cost convergence

The evaluator validates candidate folder actions and derives a single read-only coverage relation once. The relation is keyed by exact current/baseline occurrence coordinates and opaque identity, and contains only descendant pairs from complete validated mappings. Alias validation and stable-identity postcondition checks query that same relation. Construction plus all consumers are bounded by `O(A + D + E + S)` and auxiliary storage by `O(D)`; no network/storage I/O occurs. A per-evidence or per-edge rescan of actions/descendants, a second independently built coverage set, or retained cross-call state violates the contract.

The only implementation discretion is a file-private `Set` versus `Map` representation inside `identity-component-decision.ts`. It must be constructed once, discarded before return, and cannot alter identity, direction, reason precedence, complexity, or consumers.

### Existing failure semantics

- `present_unresolved`, `unknown_observation`, and `unknown_scope` remain missing-authority failures.
- `conflicting_identity` and `opposing_deletes` retain precedence over positive coverage.
- `alias_target_mutation` remains the result for an uncovered alias relation.
- `incomplete_folder_mapping` and `rename_mismatch` remain the reported-rename mapping failures.
- `identity_postcondition_unproven` remains the result for a cross-path stable identity without exact coverage.
- standalone deletion continues to require its existing exact absence authority.

Reported native renames continue through the existing rename rules. Unbaselined single-file case aliases continue through their exact identity/content canonicalization path. Neither borrows a broad parent exception.

<!-- anchor: contract-current-fact-convergence -->
## Contract: current-fact convergence and unchanged authorities

Equal complete `input-component-facts` yield the same action kinds/endpoints, disposition, and reasons after COLD, WARM, or HOT acquisition. A prior child success may leave a valid target-keyed record while the provider remains at old casing; that state is evaluated by the exact same current/baseline occurrence rule, not a prior-failure branch.

Execution continues to run child transfer/conflict work before the structural parent rename. A successful child record is not rolled back. A child or parent failure keeps the cycle non-clean, waits for scheduled sibling effects, aborts the live remote view, and withholds cursor/cache/scope publication. The next attempt performs ordinary observation from the prior checkpoint and current endpoints. No recovery marker, debt, pending action, status, or additional correctness owner exists.

## Witnesses and verification

- `witness-mixed-target-record` (normal/recurrence): one child has a valid target-keyed baseline occurrence, its same opaque identity has one provider-old current occurrence, and the complete parent action contains their exact pair. Admission retains content work, adds exactly one parent rename, and reports no failure.
- `witness-intended-is-not-baseline` (adversarial/data loss): the action targets the intended child path but that path is not the same identity's unique committed baseline occurrence. The component remains `identity_postcondition_unproven` with no executable action.
- `witness-pre-evaluator-conflict` (adversarial/authority): a determinate `normalizeLocalMove` candidate carries a second different opaque identity at its remote-current slot. Exactly one failed `conflicting_identity` disposition and zero actions prove that candidate shaping cannot terminate authorization.
- `witness-covered-plus-uncovered` (adversarial/partial proof): one stable edge has an exact pair and another does not. The whole component remains failed with no partial action.
- `witness-incomplete-or-crossed-map` (adversarial/data loss): omit, duplicate, reverse, or cross one descendant. The existing applicable mapping or postcondition reason remains visible.
- `witness-temperature-equivalence` (normal/lifecycle): COLD-, WARM-, and HOT-labelled fixtures expose equal complete facts and therefore identical Admission outputs.
- `witness-no-third-authority` (adversarial/state): any new persisted marker, action/status kind, orchestrator correctness field, or cursor writer fails review and the ownership guard.

T0 uses `npm test -- --run src/sync/plan-admission.test.ts` for exact actions, one disposition, exact reason strings, the current-to-baseline distinction, the pre-evaluator conflict, and compatibility controls. T1 uses `npm test -- --run src/sync/orchestrator.test.ts` for the production entry and acquisition/retry observations; existing executor, committer, and finalizer tests cover effect/commit compatibility. The root ownership guard and mandatory full repository gate complete the verification.

## Recovered authority trace

| Recovery item | Final disposition |
|---|---|
| `discovered-four-responsibility-boundary` | Preserved by `contract-single-final-postcondition` and `contract-current-fact-convergence`. |
| `discovered-admission-current-fact-equivalence` | Preserved by FR-CAPU-006 and the current-fact contract. |
| `discovered-two-durable-authorities` | Preserved by FR-CAPU-007 and NFR-CAPU-001. |
| `discovered-failure-reason-is-cycle-local` | Preserved by existing failure semantics; no persistence or recovery meaning is added. |
| `discovered-case-alias-component-contract` | Preserved by FR-CAPU-002 and exact topology coverage. |
| `discovered-action-order-and-vocabulary` | Compatibility-only; Execution and action types are unchanged. |
| `discovered-fail-closed-negative-boundary` | Preserved and strengthened by FR-CAPU-003/004 and the adversarial matrix. |
| `discovered-duplicated-postcondition-conflict` | Repaired by one candidate flow and one final evaluator; it is evidence of drift, not a new authority. |
| `discovered-partial-success-retry-regression` | Captured by the mixed target-record and ordinary-retry witnesses. |
| `discovered-shared-backend-admission` | Preserved by a backend-independent Admission-only repair; provider code remains out of scope. |
| `discovered-local-alias-scope` | Existing activation preconditions remain unchanged and feed the candidate only. |
| `discovered-native-and-single-file-paths-remain-distinct` | Preserved by FR-CAPU-005 and compatibility controls. |
| `discovered-stale-disposition-documentation` | Reconciled against the later accepted stateless ADR; it does not justify debt or a new lifecycle. |
| `discovered-case-alias-recurrence` | Addressed by the production-shaped positive plus distinct authority, edge-identity, and negative regressions. |

Recovery unknowns are closed as follows: the existing final evaluator is the single owner; equal complete facts, not acquisition capability, define temperature equivalence; the combined negative interactions are made discriminating tests; and stale dependency evidence is resolved only by a fresh pre-implementation gate. None is promoted into a new runtime fact.

## Critique issue resolution

The following table is the final `resolved_issues` ledger; each `issue_ref` corresponds one-to-one with a `verdict: Y` input and records the material patch-hint disposition.

| `issue_ref` | Resolution and patch-hint disposition |
|---|---|
| `issue-final-owner-verification-gap` | Adopted materially. `witness-pre-evaluator-conflict`, AC-CAPU-003, and Unit 0 require an evaluator-owned `conflicting_identity` fact on a determinate `normalizeLocalMove` candidate, exactly one failed disposition, and no actions. The existing early terminal route cannot pass. |
| `issue-baseline-intended-edge-ambiguity` | Adopted materially. Every requirement, rule, witness, and acceptance criterion uses the exact unique current occurrence to unique committed baseline occurrence of the same opaque identity; intended-only endpoints are explicitly non-evidence. |
| `issue-coverage-cost-bound-open` | Adopted materially. One relation is derived once in `O(A + D + E + S)` time and `O(D)` auxiliary space and consumed by both predicates. Discretion is narrowed to Set-versus-Map representation; repeated scans are forbidden. |

All `verdict: Y` issues are closed. There are no critique blockers remaining and no scope-expansion signal: the final components and normative contracts were already present in draft 2, and the critic changes sharpen their semantics and tests rather than add a boundary.

## Implementation units and order

### Unit 0 — fresh evidence and regression lock

Refresh dependency evidence against the current worktree before production edits. Keep the production-shaped mixed-record RED, add the exact baseline-versus-intended controls, and add the pre-evaluator conflict fixture. Assert exact dispositions, existing reasons, and zero executable actions for all negatives. Stop on any additional owner or cross-boundary dependency.

### Unit 1 — unified final postcondition

Route every normalized candidate through `evaluateIdentityComponent`; remove terminal disposition construction from the `normalizeLocalMove` branch. Derive one validated topology-coverage relation once inside `identity-component-decision.ts`, use it for both alias and stable-identity checks, and authorize only exact current-to-unique-baseline occurrence pairs. Preserve all existing reason strings and precedence.

### Unit 2 — convergence, documentation, and gate

Run production-shaped equal-fact and partial-success retry tests, execution/finalization compatibility tests, the root state-ownership guard, and the mandatory project gate. Upsert the one-final-evaluator invariant into the active four-stage design and clarify stale deferred/debt text in the existing Admission ADR against the accepted stateless ADR. Do not create an ADR.

The dependency order is `Unit 0 -> Unit 1 -> Unit 2`. Unit 0 is a hard production-change gate. No implementation unit may absorb a newly discovered provider, executor, persistence, or migration change.

## Decision closure

All planner decision inputs are represented in `spine.yaml`. Draft-1 aliases are explicitly subsumed by the canonical draft-2 inputs. Owner, producer, boundary, edge identity, direction, failure partition, complexity, lifecycle, and verification are fixed. The only implementation discretion is the private Set-versus-Map representation of the single coverage relation; it is local, reversible, bounded by the same contract, and must escalate if it affects any observable, file boundary, complexity bound, or authority.

There are no open product or architecture questions.
