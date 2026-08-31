---
change: change-20260831-sync-decision-resource-components
role: implementation
contracts:
- contract-path-proposal-table
- contract-identity-component-decision
- contract-single-build-structure
- contract-fs-evidence-conformance
- contract-crash-finalization-preservation
- contract-pipeline-migration
contract_projections:
- id: contract-path-proposal-table
  verifications:
  - verify-path-table
  - verify-path-order-cardinality
  discretion: []
- id: contract-identity-component-decision
  verifications:
  - verify-component-outcome-table
  - verify-component-permutation-scale
  - verify-rename-convergence
  - verify-executor-authority
  discretion:
  - discretion-component-index-representation
- id: contract-single-build-structure
  verifications:
  - verify-single-component-build
  - verify-no-refine-plan
  - verify-no-provider-branch
  discretion: []
- id: contract-fs-evidence-conformance
  verifications:
  - verify-shared-fs-contracts
  - verify-live-google
  - verify-live-dropbox
  - verify-live-onedrive
  discretion: []
- id: contract-crash-finalization-preservation
  verifications:
  - verify-pre-io-persistence
  - verify-checkpoint-retirement
  - verify-crash-replay
  discretion: []
- id: contract-pipeline-migration
  verifications:
  - verify-v6-wire-compatibility
  - verify-project-gate
  discretion: []
adrs:
- adr-0001-metadata-cache-subordinate-to-commit-last
- adr-0002-backends-verified-by-shared-behaviour-contracts
- adr-0006-remote-rename-detection-is-order-independent
- adr-0008-logical-identity-admission-fails-closed
- adr-20260825-issue43-destructive-authorization
- adr-20260831-admission-owned-local-rename-constraint-lifecycle
- adr-admission-owns-identity-component-decision
decision_dispositions:
- decision_input_ref: decision-input-simple-single-owner
  disposition: Adopt one Admission-owned identity-component decision without a replacement
    mega-compiler.
  adr_refs:
  - adr-admission-owns-identity-component-decision
  contract_refs:
  - contract-identity-component-decision
  - contract-single-build-structure
- decision_input_ref: decision-input-path-local-table
  disposition: Retain unchanged as proposal-only behavior.
  adr_refs:
  - adr-admission-owns-identity-component-decision
  contract_refs:
  - contract-path-proposal-table
- decision_input_ref: decision-input-admission-exclusive-authority
  disposition: Preserve Admission authority and extend it only to cross-path action
    shaping and lifecycle membership.
  adr_refs:
  - adr-0008-logical-identity-admission-fails-closed
  - adr-20260825-issue43-destructive-authorization
  - adr-admission-owns-identity-component-decision
  contract_refs:
  - contract-identity-component-decision
- decision_input_ref: decision-input-normative-rename-evidence
  disposition: Consume existing normative evidence directly with no optimizer-owned
    source.
  adr_refs:
  - adr-0006-remote-rename-detection-is-order-independent
  - adr-0008-logical-identity-admission-fails-closed
  contract_refs:
  - contract-identity-component-decision
  - contract-fs-evidence-conformance
- decision_input_ref: decision-input-optimizer-compatibility
  disposition: Preserve hash, reported-edge, complete-folder, occupancy, and source-recreation
    rules in the precedence table.
  adr_refs:
  - adr-0008-logical-identity-admission-fails-closed
  - adr-admission-owns-identity-component-decision
  contract_refs:
  - contract-identity-component-decision
- decision_input_ref: decision-input-no-general-framework
  disposition: Reject general or persisted resource graphs and retain only the private
    cycle-local partition.
  adr_refs:
  - adr-0008-logical-identity-admission-fails-closed
  - adr-admission-owns-identity-component-decision
  contract_refs:
  - contract-single-build-structure
- decision_input_ref: decision-input-backend-convergence
  disposition: Require shared faithful-fake/interface conformance, preserve ADR 0003
    opt-in live E2E, and target live preverification only at a backend with concrete
    representation-gap evidence; use separate design only for a proved unrepresentable
    real response.
  adr_refs:
  - adr-0002-backends-verified-by-shared-behaviour-contracts
  - adr-0006-remote-rename-detection-is-order-independent
  - adr-admission-owns-identity-component-decision
  contract_refs:
  - contract-fs-evidence-conformance
- decision_input_ref: decision-input-crash-commit-last
  disposition: Preserve v6 bounded replay, pre-I/O persistence, executor authority/order,
    and checkpoint-before-retirement.
  adr_refs:
  - adr-0001-metadata-cache-subordinate-to-commit-last
  - adr-0008-logical-identity-admission-fails-closed
  - adr-20260831-admission-owned-local-rename-constraint-lifecycle
  contract_refs:
  - contract-crash-finalization-preservation
  - contract-pipeline-migration
- decision_input_ref: decision-input-blank-file-unknown
  disposition: Exclude blank-file causality and resolution and exclude Issue 51 implementation
    or PR 53 from this package.
  adr_refs:
  - adr-20260831-admission-owned-local-rename-constraint-lifecycle
  - adr-admission-owns-identity-component-decision
  contract_refs:
  - contract-pipeline-migration
milestones:
- id: '0'
- id: '1'
- id: '2'
- id: '3'
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Responsibility design

The implementation preserves four owners:

1. `planSync` remains the path-local proposal owner.
2. Existing observation/scope/filesystem code remains the evidence producer.
3. PlanAdmission becomes the only cross-path identity-component decision owner. It builds components once and emits exact actions or no action, disposition/reasons, and local lifecycle membership together.
4. Orchestration/execution/finalization retain I/O, executor ordering, and commit-last responsibilities and consume Admission output mechanically.

No standalone `refinePlan` remains. The private component helper is not a replacement whole-plan compiler: it cannot perform I/O, own proposal semantics, construct `AuthorizedSyncPlan` outside Admission, expose provider branches, or build components again.

## Implementation contract

### Immutable input and single build

PlanAdmission receives the plain proposal plus normative identity/rename evidence, producer-qualified path observations, pre-filter scope projection for both endpoints, baseline membership, and cycle namespace/root in one immutable snapshot. Baseline membership proves membership only, never identity. Any mutation or root mismatch invalidates the cycle.

The component builder consumes this snapshot once. It may use a private map, set, union-find, or traversal representation only when deterministic membership/order and `O((V + E) log V)`-or-better time with `O(V + E)` auxiliary memory are preserved. The choice escalates if it changes outcome precedence, reason taxonomy, lifecycle membership, public/shared types, or cannot pass one-build/permutation/scale checks.

### Component result

One typed result owns:

- exhaustive outcome (`authorized`, `resolved_no_action`, or `deferred`) and typed reasons;
- exact actions permitted by the precedence table in `requirements.md`;
- exact `persistBeforeExecution` membership;
- exact `releaseAfterSafeCheckpoint` membership.

Default construction is fail closed: missing predicates, conflicting or multiple non-deferral matches, unsafe native projection, or an uncovered state produce whole-component deferral with no actions. The executor/finalizer cannot reopen this decision.

### Lifecycle and failures

Orchestration upserts exact local membership before any executor I/O or tracker acknowledgement. The executor receives only `AuthorizedSyncPlan` and preserves its current phase/lane/barrier ordering. A deferred component or action failure makes the cycle non-clean and withholds the checkpoint. Finalization commits checkpoint state first, then retires only exact release keys. Upsert failure produces zero plan I/O; checkpoint failure retains debt/evidence. SyncState remains v6 and remote evidence continues to replay by checkpoint withholding.

### Provider cutover

Unit 0 runs the mandatory shared faithful-fake behavior and interface-level conformance cases for Google Drive, Dropbox, and OneDrive: authority, identity continuity/replacement, absence/error, order-independent rename, and post-delta snapshots. A representable failure is fixed behind that provider's existing `IFileSystem` implementation/fake and rerun.

ADR 0003 remains unchanged: real-provider E2E is opt-in, local/manual, non-CI, and missing credentials warn and skip. It is not a universal cutover gate. If code review, shared-contract mismatch, provider documentation, or an observed API payload provides concrete evidence that one backend's real response may be unrepresentable by current `PathAuthority`, `identityKey`, `RenamePair`, or snapshot semantics, run targeted live preverification for that backend. Pending or failed evidence holds only that backend's change. A proven unrepresentable response requires a separate interface design; it does not authorize an interface extension or provider-specific sync branch here.

## Dependency-ordered units

### Unit 0 — Provider evidence preverification

Target: shared filesystem/caching contracts, Google Drive/Dropbox/OneDrive fakes and opt-in live suites.

Produce mandatory shared conformance results for all three providers and add any missing interface-level cases. Fix only representable backend-local deviations. Trigger targeted live preverification only for a backend with concrete representation-gap evidence; hold only that backend change while evidence is pending. Do not touch sync decision code, weaken shared cases, or make live credentials a global prerequisite. Unit 1 depends on the shared conformance gate, not on optional live execution.

### Unit 1 — Single identity-component owner

Depends on Unit 0 shared conformance pass. A pending targeted-live question holds only its backend-specific change.

Add the exhaustive outcome-table tests first. Refactor PlanAdmission to build components once and call one private decision helper. Move local/remote file/folder shaping, additive classification, already-converged release, source recreation, ordinary consequence proof, exact disposition, and lifecycle membership into that result. Preserve proposal order and delete the edge-filter/rebuild behavior. Add permutation/scale checks and mutations for remote absence, local hash, folder completeness, conflicting/multiple rows, and fallback rejection.

### Unit 2 — Pipeline and lifecycle migration

Depends on Unit 1.

Remove `refinePlan` from cycle planning, pass the immutable plain proposal directly into Admission, migrate behavior-focused optimizer tests to the component seam, then retire the standalone optimizer API/module. Update diagnostics to component outcomes. Preserve `AuthorizedSyncPlan`, pre-I/O upsert, executor ordering, checkpoint replay, exact retirement, and SyncState v6. No shim or dual production path is allowed.

### Unit 3 — Architecture and conformance

Depends on Unit 2.

Update `ARCHITECTURE.md`, `docs/sync-pipeline.md`, relevant ADR ownership text, and structural enforcement after code stabilizes. Document one proposal owner and one Admission component owner, provider cutover, and the blank-file non-claim. Keep Issue #51 implementation and PR #53 out of this package.

## Test seams

- Path table: existing pure `planSync` tests.
- Component decision: immutable fixture input and typed result; no filesystem mocking required.
- Filesystem evidence: existing shared `IFileSystem` and caching-remote contract runners are mandatory; ADR 0003 live suites remain opt-in backstops and become targeted evidence-seeking only for a concrete backend representation-gap suspicion.
- Orchestration/finalization: existing state store, executor, tracker, and checkpoint seams with call-order assertions.
- Structural rules: source/import checks for one component build, no `refinePlan`, and no provider-name branch under `src/sync/`.

## ADR proposal

One ADR is required because the change moves a persistent responsibility boundary and narrows ADR 0008's statement that optimizers remain plan-shaping steps.

Proposed decision: preserve the path-local proposal table; make PlanAdmission the sole owner of all cross-path identity/rename action shaping, destructive authorization, disposition, and lifecycle membership; build components once; retire the standalone whole-plan optimizer stage.

The proposal preserves ADR 0001 commit-last, ADR 0002 shared backend behavior, ADR 0003 opt-in/non-CI live E2E with credential-missing skip, ADR 0006 producer-owned remote rename detection, ADR 0008's normative evidence/fail-closed rules, Issue #43 Admission authority, and Issue #51 exact membership. It rejects moving all decisions into `planSync`, retaining a trusted `refinePlan`, sharing semantics between two owners, introducing a general/persistent resource graph, or allowing executor fallback.

The ADR remains a proposal in this design package; its acceptance/materialization is part of Unit 3. No additional ADR is needed for private index choice, provider-specific fixes behind the current interface, or unchanged v6/finalization behavior.
