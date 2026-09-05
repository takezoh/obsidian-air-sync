---
change: change-20260904-remote-rename-alias-arbitration
role: implementation
contracts:
- contract-single-component-admission
- contract-authority-arbitration
- contract-root-proof-failure-semantics
- contract-provider-temperature-equivalence
- contract-execution-state-preservation
- contract-admission-architecture-conformance
contract_projections:
- id: contract-single-component-admission
  verifications:
  - verify-one-component-result
  - verify-private-component-importer
  discretion: []
- id: contract-authority-arbitration
  verifications:
  - verify-reported-over-alias
  - verify-conflict-no-fallback
  - verify-linear-authority-selection
  discretion: []
- id: contract-root-proof-failure-semantics
  verifications:
  - verify-exact-root-descendant-proof
  - verify-stable-reason-precedence
  - verify-no-synthetic-action-authority
  - verify-affine-read-bound
  discretion:
  - discretion-private-proof-index
- id: contract-provider-temperature-equivalence
  verifications:
  - verify-temperature-fact-equivalence
  - verify-three-backend-folder-rename-contract
  - verify-provider-delta-contracts
  discretion: []
- id: contract-execution-state-preservation
  verifications:
  - verify-post-success-opposite-rename
  - verify-execution-and-commit
  - verify-state-ownership-closed
  discretion: []
- id: contract-admission-architecture-conformance
  verifications:
  - verify-admission-authority-guard
  - verify-existing-state-owner-guard
  - verify-bot-and-doc-enforcement
  - verify-complete-repository-gate
  discretion: []
adrs:
- adr-20260904-remote-rename-alias-arbitration
- adr-0001-metadata-cache-is-subordinate-to-commit-last
- adr-0006-remote-rename-detection-is-order-independent
- adr-0008-logical-identity-admission-fails-closed
- adr-20260831-admission-owns-identity-component-decisi
- adr-20260903-four-stage-sync-pipeline
- adr-20260903-stateless-current-state-recovery
decision_dispositions:
- decision_input_ref: decision-input-structural-owner
  disposition: adopted; component-identity-component-authority is the sole rename-arbitration
    semantic owner, admitDestructivePlan is its public facade, one private decideIdentityComponent
    producer is called once per raw component, and a local conditional or second topology
    owner is rejected.
  adr_refs:
  - adr-20260904-remote-rename-alias-arbitration
  - adr-20260831-admission-owns-identity-component-decisi
  contract_refs:
  - contract-single-component-admission
  - contract-admission-architecture-conformance
- decision_input_ref: decision-input-reported-precedence
  disposition: adopted; a coherent effective reported family selects direction before
    aliases, while conflict fails without alias, ordinary-action, or report-subset
    fallback.
  adr_refs:
  - adr-20260904-remote-rename-alias-arbitration
  - adr-0008-logical-identity-admission-fails-closed
  contract_refs:
  - contract-authority-arbitration
- decision_input_ref: decision-input-root-descendant-authority
  disposition: adopted; one selected reported root governs only its correctly directed
    exact complete included unique descendant mapping through a subordinate call-local
    proof.
  adr_refs:
  - adr-20260904-remote-rename-alias-arbitration
  - adr-0008-logical-identity-admission-fails-closed
  contract_refs:
  - contract-root-proof-failure-semantics
- decision_input_ref: decision-input-closed-state
  disposition: adopted from existing authority; no persistence, intermediate checkpoint,
    recovery branch, orchestrator field, or correctness-critical cross-call owner
    is permitted.
  adr_refs:
  - adr-0001-metadata-cache-is-subordinate-to-commit-last
  - adr-20260903-stateless-current-state-recovery
  contract_refs:
  - contract-execution-state-preservation
  - contract-admission-architecture-conformance
- decision_input_ref: decision-input-stale-rename-debt-doc
  disposition: adopted as clause-level supersession in the new ADR and current-guide
    correction; accepted ADR files and completed changes remain immutable history.
  adr_refs:
  - adr-20260904-remote-rename-alias-arbitration
  - adr-20260903-stateless-current-state-recovery
  contract_refs:
  - contract-admission-architecture-conformance
- decision_input_ref: decision-input-google-attribution
  disposition: not_applicable; actor or raw-payload attribution may be separate diagnostics
    but is not an Admission authority input and cannot change handling of a valid
    report.
  contract_refs:
  - contract-provider-temperature-equivalence
- decision_input_ref: decision-input-live-provider-parity
  disposition: not_applicable to implementation selection; always-on registered-family
    contracts are mandatory and optional live evidence cannot weaken or fork the common
    contract.
  adr_refs:
  - adr-0006-remote-rename-detection-is-order-independent
  contract_refs:
  - contract-provider-temperature-equivalence
- decision_input_ref: decision-input-private-provenance
  disposition: implementation_detail; the proof must reference the selected immutable
    RenameEvidence directly and remain call-local, while only the private exact-pair
    map representation is delegated.
  contract_refs:
  - contract-root-proof-failure-semantics
- decision_input_ref: decision-input-root-carrier
  disposition: subsumed by decision-input-root-descendant-authority and decision-input-structural-owner;
    topology is not a separate component or authority.
  adr_refs:
  - adr-20260904-remote-rename-alias-arbitration
  contract_refs:
  - contract-single-component-admission
  - contract-root-proof-failure-semantics
- decision_input_ref: decision-input-descendant-governance
  disposition: subsumed by decision-input-root-descendant-authority; exact complete
    selected-root coverage is the single governing rule.
  contract_refs:
  - contract-root-proof-failure-semantics
- decision_input_ref: decision-input-no-new-state
  disposition: subsumed by decision-input-closed-state; the two-authority and stateless
    retry boundary remains unchanged.
  adr_refs:
  - adr-0001-metadata-cache-is-subordinate-to-commit-last
  - adr-20260903-stateless-current-state-recovery
  contract_refs:
  - contract-execution-state-preservation
- decision_input_ref: decision-input-provider-common-path
  disposition: adopted; provider-specific detection terminates at the common RenamePair/current-snapshot
    boundary and Admission contains no backend branch.
  adr_refs:
  - adr-0006-remote-rename-detection-is-order-independent
  contract_refs:
  - contract-provider-temperature-equivalence
- decision_input_ref: decision-input-doc-drift
  disposition: subsumed by decision-input-stale-rename-debt-doc; the new ADR supersedes
    stale present-tense clauses and current guides are corrected without historical
    edits.
  adr_refs:
  - adr-20260904-remote-rename-alias-arbitration
  - adr-20260903-stateless-current-state-recovery
  contract_refs:
  - contract-admission-architecture-conformance
milestones:
- id: discriminating-test-first-contract
- id: admission-authority-and-proof
- id: integration-and-compatibility
- id: static-and-durable-governance
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

## Responsibility boundary

component-identity-component-authority remains the sole rename-arbitration semantic
owner. Its public admitDestructivePlan facade partitions the immutable BatchObservation,
invokes one private component producer once per component, and maps the closed result
mechanically to one authorized, resolved_no_action, or failed disposition.
identity-component-decision.ts is that once-called private producer and performs report
classification, authority-family selection, one materialization, one proof consumption,
and one final predicate fold on behalf of the owning component.

The planned identity-component-report-family.ts is a pure decision-only classifier;
identity-component-topology.ts is a pure subordinate producer in the same
identity-component Admission component. It is not a component owner, evaluator,
authorizer, disposition owner, or lifecycle owner. Its immutable proof and pair index
are constructed and discarded in one decision call and are never exposed in an action,
evidence carrier, AuthorizedSyncPlan, schema, cache, orchestrator, or checkpoint.

Provider acquisition remains an operational-input producer, not a rename-arbitration
owner. Plan execution, SyncRecord publication, finalization, working-view abort, and
checkpoint publication retain their current owners and production code. The static
guards below verify and enforce the authority component's contracts; they do not form a
runtime semantic component.

## Implementation contracts

### contract-single-component-admission

- Input: one immutable raw identity component, its current scope projection, and its
  attached committed baselines.
- Rule: admitDestructivePlan calls decideIdentityComponent exactly once for each
  exhaustive component and maps its closed result exactly once.
- Rule: subordinate helpers cannot emit a public disposition or insert executable work.
- Output: one existing disposition; actions enter AuthorizedSyncPlan only when the
  component's final reason array is empty.
- Invalid internal duplicate/missing/impossible results fail fast as internal contract
  violations and do not create a new user-facing reason.

### contract-authority-arbitration

- Read all effective current-cycle reported claims from the unchanged raw component.
  Preserve the existing narrow classification of a proven non-binding local report and
  collapse only exact duplicates; never erase a normative conflict.
- If the effective report set is non-empty and coherent in root, direction, identity,
  and postcondition, select that reported family.
- If it is non-empty and conflicting, stop with rename_mismatch and no candidate
  fallback.
- Consider an alias-only/current-fact family only when the effective report set is
  empty. Alias facts validate endpoint equivalence but never synthesize report authority.
- Represent the selection as one closed private union. Each candidate builder receives
  the immutable raw component and an already selected family variant; it cannot receive
  another builder's rewritten actions or enough unselected input to reselect authority.
- Materialize the chosen family once from the original actions. Remove the ordered
  cross-family normalizer chain.

### contract-root-proof-failure-semantics

- Start reported folder proof from the selected immutable RenameEvidence, never from a
  proposed action.
- Bind exactly one native folder action with equal old/new roots, correct folder kind,
  and report-side-derived direction.
- Index each strict descendant pair only when both endpoints are included, the relative
  suffix is exact, and neither endpoint is reused.
- Require every in-scope component endpoint below either root to occur exactly once.
  Missing, additional, deferred, unknown, crossed, duplicated, unrelated, or ambiguous
  pairs make the mapping incomplete.
- Only after complete proof, accept an alias as consistent when its unordered endpoints
  equal one exact indexed pair.
- Keep the established no-report local parent proof distinct; it uses complete current
  facts and must not fabricate a report.

The failure predicate is fixed and exclusive in this order:

| Priority | Predicate | Observable result |
|---|---|---|
| 0 | A selected alias/local candidate mechanism returns an existing EvidenceUnknownReason or EvidenceContradictionReason | That singleton existing reason; no later family |
| 1 | present_unresolved, unknown observation, conflicting identity, or opposing deletes | All true existing orthogonal reasons, deduplicated and lexically sorted |
| 2a | Normative report conflict, or selected report cannot bind uniquely to shaped root/action/direction/postcondition | rename_mismatch |
| 2b | Correctly bound folder root has empty, partial, unaligned, non-unique, non-exhaustive, ambiguous, deferred, or unknown-scope descendants | incomplete_folder_mapping |
| 2c | Correctly bound non-folder report has deferred or unknown scope | unknown_scope |
| 2d | Root proof is complete but an alias lies outside the exact pair set | alias_target_mutation |
| 3 | No-report stable identity is uncovered, an actionless component is unresolved, or standalone delete lacks authoritative absence | Existing identity_postcondition_unproven or unknown_observation predicate |

Within priority 2, the first matching row is the only rename-specific reason. Multi-
reason orthogonal results are deduplicated and sorted. Exact overlap expectations are:

- conflicting report plus complete alias: rename_mismatch;
- wrong root/direction plus partial descendants: rename_mismatch;
- correctly bound partial mapping plus alias: incomplete_folder_mapping;
- correctly bound unknown-scope descendant plus alias: incomplete_folder_mapping;
- complete root proof plus unrelated alias: alias_target_mutation;
- non-folder deferred scope: unknown_scope.

### contract-provider-temperature-equivalence

Owned by component-identity-component-authority, this decision contract consumes
provider-neutral RenamePair/current-snapshot facts, identity and alias observations,
scope, and committed baselines from the existing acquisition producers. Its signature
accepts no provider discriminator, acquisition temperature, prior error, database
version, global record count, or recovery marker. Equal complete facts from COLD, WARM,
HOT, Google Drive, OneDrive, or Dropbox produce the same actions, disposition, and
ordered reasons.

### contract-execution-state-preservation

AuthorizedSyncPlan remains the only execution input. Child content/conflict work drains
before the parent structural rename under the existing barrier. A SyncRecord commits
only after admitted I/O succeeds; remote cursor, complete derived cache, and scope
checkpoint publish only after a wholly clean cycle. Incomplete attempts use the existing
working-view abort and ordinary re-observation. Selected family, proof, reason, and
disposition are never persisted or retained for retry.

### contract-admission-architecture-conformance

This is verification and enforcement of component-identity-component-authority and its
single-owner contract, not a component or runtime decision owner.

Extend eslint.config.mts so identity-component-report-family.ts and
identity-component-topology.ts are pure transforms and so
production value imports of plan-admission-case-alias.ts, local-rename-admission.ts,
optimize-local-renames.ts, optimize-remote-renames.ts, and
identity-component-report-family.ts and identity-component-topology.ts are allowed only
from identity-component-decision.ts.
plan-admission.ts may value-import the component decision entry, not its subordinate
helpers. Type-only compatibility imports are inventoried separately and confer no
runtime capability.

Add sync-admission-authority-guard.test.mjs using the installed TypeScript AST and a
closed source inventory. For identity-component-decision.ts,
identity-component-report-family.ts, and identity-component-topology.ts, allow imports,
exported types/interfaces, pure function
declarations, and primitive-literal const declarations. Reject top-level let/var,
class/enum, object/array/Map/Set or other mutable const initializers, assignment/update
expressions, and new production value importers. Synthetic fixtures must prove that a
module-scope proof Map and a foreign helper importer fail and that a pure call-local
module passes. Register the guard in lint:bot-repro. Do not alter
sync-state-ownership-guard.test.mjs or its ownership fixture.

## Dependency-ordered units

### Unit 1 — pin RED and negative contracts

Dependencies: none.

Targets:

- src/sync/plan-admission.test.ts

Retain the production-shaped three-alias, one-remote-folder-report, two-stable-identity
recurrence as RED before production repair. Add permutations of actions, reports,
observations, and aliases; coherent/conflicting reports; the no-report control; exact
root mappings; synthetic-action authority rejection; and every overlap reason above.
Each negative asserts one component disposition, the exact reason array, and zero
executable actions.

Instrument collection wrappers in tests, without a production counter, for connected
fixtures of sizes 64 and 512. Both must satisfy
reads <= 32 * (A + D + E + O + S) + 128; the larger balanced fixture must reject an
all-pairs scan.

Acceptance: tests fail for the current alias-first/action-derived behavior and pass only
for the closed selection/proof/reason contract.

### Unit 2 — centralize the component decision

Dependencies: Unit 1.

Targets:

- src/sync/plan-admission.ts
- src/sync/identity-component-decision.ts
- src/sync/identity-component-report-family.ts
- src/sync/identity-component-topology.ts
- src/sync/plan-admission-case-alias.ts
- src/sync/local-rename-admission.ts
- src/sync/optimize-local-renames.ts
- src/sync/optimize-remote-renames.ts

Move every runtime candidate-selection edge behind decideIdentityComponent. Classify
reports over immutable raw facts, select the closed family once, materialize once,
derive one subordinate proof, fold the fixed predicates once, and return one closed
result. Remove ordered cross-family normalization and action-derived synthetic
RenameEvidence. Preserve public carrier shapes, public vocabulary, and unrelated
path-local behavior.

Acceptance: Unit 1 becomes green; code search and call counts show one decision and one
materialization per component with no public proof carrier.

### Unit 3 — prove common acquisition, execution, and state contracts

Dependencies: Unit 2.

Targets:

- src/sync/orchestrator.test.ts
- existing sync executor/committer/finalization tests
- tests/fs/remote-backend-contracts.test.ts and the four registered contract harnesses

Add a lifecycle witness: a clean local parent transition followed by an opposite
provider-current reported root and unchanged aliases. Verify equal COLD/WARM/HOT fact
fixtures, child-before-parent execution, post-I/O SyncRecords, abort on incomplete
attempts, and clean checkpoint publication. Run the shared Google Drive, OneDrive, and
Dropbox folder-rename contract matrix.

Acceptance: common tests are green without production edits to provider, executor,
committer, finalizer, checkpoint, or state modules. A need for such an edit returns the
package to design.

### Unit 4 — enforce and publish the boundary

Dependencies: Unit 3.

Targets:

- eslint.config.mts
- sync-admission-authority-guard.test.mjs
- package.json
- docs/adr/adr-20260904-remote-rename-alias-arbitration.md
- docs/design/design-four-stage-sync-pipeline.md
- AGENTS.md
- ARCHITECTURE.md
- docs/sync-pipeline.md
- docs/code-enforcement.md

Add and register the discriminating guard. Promote INV-007, INV-008, and BOUNDARY-007.
Make current guides describe the stateless Admission boundary and link the new ADR.
Leave accepted ADR files and completed changes byte-for-byte historical.

Acceptance: both independent architecture guards, docs conformance, and the full
repository gate pass.

## Implementation discretion and escalation

The only local discretion is the collision-safe private exact-pair index inside
identity-component-topology.ts: a composite-key ReadonlyMap or nested ReadonlyMaps is
acceptable. Escalate to this design if implementation would change any public/exported
type, observable reason, component ownership, state or proof lifetime, complexity bound,
provider branch, executor order, commit rule, or checkpoint behavior. There are no open
product decisions.
