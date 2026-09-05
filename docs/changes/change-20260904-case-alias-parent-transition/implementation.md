---
change: change-20260904-case-alias-parent-transition
role: implementation
contracts:
- contract-fresh-evidence-and-regression
- contract-single-final-postcondition
- contract-exact-topology-coverage
- contract-current-fact-convergence
contract_projections:
- id: contract-fresh-evidence-and-regression
  verifications:
  - verify-fresh-dependency-surface
  - verify-production-shaped-red-and-negatives
  - verify-pre-evaluator-terminal-rejection
  discretion: []
- id: contract-single-final-postcondition
  verifications:
  - verify-one-final-verdict
  - verify-no-pre-evaluator-terminal-authorization
  - verify-admission-production-cut
  discretion: []
- id: contract-exact-topology-coverage
  verifications:
  - verify-exact-baseline-occurrence-coverage
  - verify-covered-plus-uncovered-partition
  - verify-native-and-single-file-compatibility
  - verify-linear-single-derivation
  discretion:
  - discretion-private-coverage-representation
- id: contract-current-fact-convergence
  verifications:
  - verify-cold-warm-hot-equivalence
  - verify-execution-and-finalization-unchanged
  - verify-state-ownership-guard
  - verify-full-project-gate
  discretion: []
adrs:
- adr-20260831-admission-owns-identity-component-decisi
- adr-0008-logical-identity-admission-fails-closed
- adr-20260903-four-stage-sync-pipeline
- adr-20260903-stateless-current-state-recovery
- adr-0001-metadata-cache-is-subordinate-to-commit-last
decision_dispositions:
- decision_input_ref: input-final-proof-owner
  disposition: adopted; evaluateIdentityComponent is the sole final postcondition
    owner after all component-local candidate shaping, and no normalizer may emit
    a terminal disposition.
  adr_refs:
  - adr-20260831-admission-owns-identity-component-decisi
  - adr-20260903-four-stage-sync-pipeline
  contract_refs:
  - contract-single-final-postcondition
- decision_input_ref: input-exact-descendant-coverage
  disposition: adopted; only the exact current occurrence to unique committed baseline
    occurrence pair of the same opaque identity inside one complete validated parent
    rename_remote mapping establishes coverage; intended-only endpoints are rejected.
  adr_refs:
  - adr-0008-logical-identity-admission-fails-closed
  contract_refs:
  - contract-exact-topology-coverage
- decision_input_ref: input-temperature-equivalence
  disposition: adopted; acquisition temperature remains outside Admission and equal
    complete facts have one result.
  adr_refs:
  - adr-0008-logical-identity-admission-fails-closed
  - adr-20260903-stateless-current-state-recovery
  contract_refs:
  - contract-current-fact-convergence
- decision_input_ref: input-no-recovery-authority
  disposition: adopted; no persistent or correctness-critical in-memory recovery authority
    is permitted.
  adr_refs:
  - adr-20260903-stateless-current-state-recovery
  - adr-0001-metadata-cache-is-subordinate-to-commit-last
  contract_refs:
  - contract-current-fact-convergence
- decision_input_ref: input-negative-boundary
  disposition: adopted; every existing fail-closed category and exact reason boundary
    is retained, with only the exact complete baseline-occurrence edge added as positive
    proof.
  adr_refs:
  - adr-0008-logical-identity-admission-fails-closed
  contract_refs:
  - contract-exact-topology-coverage
- decision_input_ref: input-native-and-single-file-compatibility
  disposition: adopted; reported native rename, unbaselined single-file canonicalization,
    and standalone delete paths remain distinct and unchanged.
  contract_refs:
  - contract-single-final-postcondition
  - contract-exact-topology-coverage
- decision_input_ref: input-stale-deferred-language
  disposition: adopted as documentation reconciliation; stale deferred or rename-debt
    wording is clarified against the accepted failed/stateless contract without a
    new ADR.
  adr_refs:
  - adr-20260831-admission-owns-identity-component-decisi
  - adr-20260903-stateless-current-state-recovery
  contract_refs:
  - contract-current-fact-convergence
- decision_input_ref: input-dependency-freshness
  disposition: adopted as a pre-implementation evidence gate; stale, unknown, or expanded
    dependency evidence stops implementation.
  contract_refs:
  - contract-fresh-evidence-and-regression
- decision_input_ref: alternative-local-stable-identity-bypass
  disposition: rejected; fixture-specific suppression preserves split policy and can
    authorize unrelated identities.
  contract_refs:
  - contract-single-final-postcondition
  - contract-exact-topology-coverage
- decision_input_ref: alternative-proof-token-or-recovery-state
  disposition: rejected; a token, status, marker, or recovery branch creates another
    authority instead of making the final proof compositional.
  adr_refs:
  - adr-20260903-stateless-current-state-recovery
  contract_refs:
  - contract-current-fact-convergence
- decision_input_ref: decision-input-single-final-owner
  disposition: subsumed by input-final-proof-owner; candidate shaping is non-terminal
    and the existing evaluator owns the only final reasons and verdict.
  contract_refs:
  - contract-single-final-postcondition
- decision_input_ref: decision-input-stable-edge-coverage
  disposition: subsumed by input-exact-descendant-coverage; baseline means the unique
    committed baseline occurrence of the same identity, never a merely intended path.
  contract_refs:
  - contract-exact-topology-coverage
- decision_input_ref: decision-input-temperature
  disposition: subsumed by input-temperature-equivalence; equal complete facts have
    equal Admission meaning.
  contract_refs:
  - contract-current-fact-convergence
- decision_input_ref: decision-input-recovery-state
  disposition: subsumed by input-no-recovery-authority; ordinary current-fact replanning
    uses only existing durable facts.
  contract_refs:
  - contract-current-fact-convergence
- decision_input_ref: decision-input-helper-shape
  disposition: implementation detail; only the private Set-versus-Map representation
    of the single derived relation is delegated, while derivation count, complexity,
    edge identity, and consumers are fixed.
  contract_refs:
  - contract-exact-topology-coverage
- decision_input_ref: decision-input-dependency-freshness
  disposition: subsumed by input-dependency-freshness; refresh is a hard evidence
    gate before production editing.
  contract_refs:
  - contract-fresh-evidence-and-regression
- decision_input_ref: decision-input-stale-adr-wording
  disposition: subsumed by input-stale-deferred-language; clarify the existing authority
    without creating a new ADR or lifecycle.
  contract_refs:
  - contract-current-fact-convergence
milestones:
- id: evidence-and-test-first
- id: admission-policy-reduction
- id: integration-and-conformance
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

### Responsibility boundary

- Observation supplies immutable current endpoint, identity occurrence, committed baseline, scope, and proposal facts only.
- Admission's local/native/case-alias helpers shape one component candidate but emit no terminal component disposition.
- `evaluateIdentityComponent` derives one validated topology-coverage relation, applies every final negative predicate, and returns the only final reason set.
- `admitDestructivePlan` maps that result to exactly one existing disposition and exposes actions only after an empty final reason set.
- Execution, per-file `SyncRecord` commit, working-view abort, and clean-cycle checkpoint publication retain their current owners and behavior.

### Unit 0 — fresh evidence and regression lock

Files: `src/sync/plan-admission.test.ts` and `src/sync/orchestrator.test.ts`.

Before production edits, refresh current dependency/change-surface evidence for the declared Admission owner, producer, consumer, and test seams. Stop and return to design if another production caller, owner, or cross-boundary dependency appears.

Keep the production-shaped target-record RED and add four discriminators:

- exact same-identity current-to-unique-baseline descendant coverage succeeds;
- keeping the intended destination while removing or changing that identity's baseline occurrence fails with `identity_postcondition_unproven`;
- a determinate `normalizeLocalMove` candidate with a second opaque identity key at the same remote-current slot produces exactly one failed `conflicting_identity` disposition and zero executable actions;
- unrelated, absent, incomplete, crossed, duplicate, reversed, covered-plus-uncovered, unresolved, and conflicting edges retain exact existing reasons.

The third fixture is mandatory because it fails only when the current pre-evaluator terminal branch remains: its candidate is locally determinate, but its final component fact is rejecting. Tests must assert disposition count and kind, exact reason, and executable action count.

### Unit 1 — unified final postcondition

Files: `src/sync/plan-admission.ts`, `src/sync/identity-component-decision.ts`, and focused Admission tests. `src/sync/plan-admission-case-alias.ts` changes only if needed to make its already-existing return explicitly candidate-only; its activation and mapping semantics remain unchanged.

Remove terminal disposition construction from the `normalizeLocalMove` branch of `admitDestructivePlan`. After all component-local shaping, construct one final `AdmissionComponent`, call `evaluateIdentityComponent` exactly once, and emit one existing disposition from its reasons and action count. No normalizer can append authorized actions, settle no-action, or return an independently final failure.

Inside `identity-component-decision.ts`, validate candidate folder mappings and derive one read-only topology-coverage relation exactly once. For each no-reported-rename remote stable identity, require exactly one current occurrence and exactly one committed baseline occurrence for that same opaque identity. Enter only the exact directed descendant pair `currentOccurrence.path -> baselineOccurrence.path` from a complete validated parent `rename_remote`. An action destination or intended endpoint lacking that unique baseline occurrence never qualifies.

Alias and stable-identity predicates consume the same relation. Total evaluation is `O(A + D + E + S)` time and `O(D)` auxiliary storage, with no I/O; repeated per-edge action/descendant scans and a separately derived second relation are forbidden. A private `Set` or `Map` representation may be selected inside this file only. Escalate if the choice changes edge identity, reason precedence, complexity, consumers, file boundary, or lifetime.

Preserve all existing reason strings and precedence, reported native rename behavior, unbaselined single-file canonicalization, standalone deletion authority, and disconnected proposal order. Do not filter evidence or synthesize rename evidence to create success.

### Unit 2 — convergence, documentation, and enforcement

Files: `src/sync/plan-admission.test.ts`, `src/sync/orchestrator.test.ts`, existing executor/committer/finalizer tests, `sync-state-ownership-guard.test.mjs`, `docs/design/design-four-stage-sync-pipeline.md`, `docs/adr/adr-20260831-admission-owns-identity-component-decisi.md`, and `docs/adr/adr-20260903-stateless-current-state-recovery.md`.

Prove equal complete COLD/WARM/HOT facts yield identical Admission action, disposition, and reason projections. Prove child content precedes the structural parent rename, successful file records remain valid, any incomplete attempt leaves cursor/cache/scope unpublished and aborts its working view, and the next attempt uses ordinary current facts.

Upsert the candidate-only/one-final-evaluator invariant into the active four-stage design. Clarify the existing Admission ownership ADR's stale deferred/rename-debt wording against the later accepted stateless ADR. Do not create a new ADR or change historical decision status.

### Dependency order

`Unit 0 -> Unit 1 -> Unit 2`. Unit 0 is a hard production-change gate. Unit 1 is the only production repair. Unit 2 verifies integration and materializes the already-governing invariant; it cannot widen the production surface.

### Commit and abort semantics

A successful child action may commit its own `SyncRecord`. Cursor plus complete derived cache and scope remain unpublished until every authorized action has terminal success. Any missing proof, rejection, block, exception, or precondition change keeps the cycle non-clean, waits for scheduled sibling effects, and uses the existing working-view abort lifecycle. No compensation, recovery marker, prior-error input, or pending work is added.

### Design constraints

The implementation must preserve `contract-fresh-evidence-and-regression`, `contract-single-final-postcondition`, `contract-exact-topology-coverage`, and `contract-current-fact-convergence`. There are no open architecture choices. The only discretion is the file-private Set-versus-Map representation of the one coverage relation; it must preserve exact occurrence identity, single derivation, linear bound, reason partition, action/disposition observations, and cycle-local lifetime.
