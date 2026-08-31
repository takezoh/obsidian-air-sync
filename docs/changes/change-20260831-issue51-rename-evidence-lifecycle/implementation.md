---
change: change-20260831-issue51-rename-evidence-lifecycle
role: implementation
contracts:
- contract-candidate-proof
- contract-admission-lifecycle
- contract-v6-persistence
- contract-commit-last-retirement
contract_projections:
- id: contract-candidate-proof
  verifications:
  - verify-candidate-proof
  discretion: []
- id: contract-admission-lifecycle
  verifications:
  - verify-fresh-unbaselined
  - verify-ambiguous-retention
  - verify-lifecycle-membership
  discretion: []
- id: contract-v6-persistence
  verifications:
  - verify-replayed-false-v6
  - verify-persistence-abort
  - verify-lifecycle-diagnostics
  discretion: []
- id: contract-commit-last-retirement
  verifications:
  - verify-finalization-faults
  - verify-repository-gate
  discretion: []
adrs:
- adr-20260831-admission-owned-local-rename-constraint-lifecycle
- adr-0008-logical-identity-admission-fails-closed
- adr-20260825-issue43-destructive-authorization
decision_dispositions:
- decision_input_ref: decision-input-admission-owner
  disposition: adopted — Admission solely owns candidate promotion and exact persistence/release
    membership; pre-Admission scope-only debt policy is removed.
  adr_refs:
  - adr-0008-logical-identity-admission-fails-closed
  - adr-20260825-issue43-destructive-authorization
  - adr-20260831-admission-owned-local-rename-constraint-lifecycle
  contract_refs:
  - contract-admission-lifecycle
- decision_input_ref: decision-input-v6-shape
  disposition: adopted — Keep the unchanged v6 wire shape, replay rows as candidates,
    and reclassify from current authoritative facts.
  adr_refs:
  - adr-20260831-admission-owned-local-rename-constraint-lifecycle
  contract_refs:
  - contract-candidate-proof
  - contract-v6-persistence
- decision_input_ref: decision-input-false-runtime
  disposition: adopted — Use the narrow positive additive-unbaselined component proof
    and reject push-spelling-only release.
  adr_refs:
  - adr-20260831-admission-owned-local-rename-constraint-lifecycle
  contract_refs:
  - contract-admission-lifecycle
- decision_input_ref: decision-input-fail-closed
  disposition: adopted — Unknown, conflicting, synchronized, destructive, or incomplete
    candidates remain retained fail closed.
  adr_refs:
  - adr-0008-logical-identity-admission-fails-closed
  - adr-20260831-admission-owned-local-rename-constraint-lifecycle
  contract_refs:
  - contract-candidate-proof
  - contract-admission-lifecycle
- decision_input_ref: decision-input-finalization
  disposition: adopted — Finalization consumes exact consequence-bound release membership
    after checkpoint and never reclassifies facts.
  adr_refs:
  - adr-20260825-issue43-destructive-authorization
  - adr-20260831-admission-owned-local-rename-constraint-lifecycle
  contract_refs:
  - contract-commit-last-retirement
- decision_input_ref: decision-input-blank-unknown
  disposition: not_applicable — Blank-file causality lacks second-device evidence
    and is excluded from this design and success claim.
  adr_refs:
  - adr-20260831-admission-owned-local-rename-constraint-lifecycle
  contract_refs: []
- decision_input_ref: decision-input-scope-bounded
  disposition: adopted — Repair only the rename evidence lifecycle boundary and reject
    broad rollback or generalized identity infrastructure.
  adr_refs:
  - adr-20260831-admission-owned-local-rename-constraint-lifecycle
  contract_refs:
  - contract-candidate-proof
  - contract-v6-persistence
milestones:
- id: acquisition
- id: admission
- id: persistence
- id: finalization
- id: verification
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation — Issue #51 rename evidence lifecycle

## Goal

Move the decision “this local report must survive as a durable safety constraint” into
Admission, while leaving acquisition factual, persistence mechanical, and Finalization
commit-last. Preserve `RenameEvidence`, SyncState v6, exact destructive authorization,
and existing backend ownership.

## Implementation contracts

### contract-candidate-proof

`component-cycle-acquisition` constructs one immutable cross-component proof projection:
edge identity, origin, namespace, authoritative local/remote endpoint observations,
baseline membership, identity/alias/conflict facts, folder/chain completeness, proposal
membership, and fresh current scope. Old v6 dispositions are historical conservative
hints only. Missing facts stay unknown. There is no implementation discretion to pass a
different shared proof shape or to let Admission depend on mutable `MixedEntity` internals.

### contract-admission-lifecycle

`component-plan-admission` applies a positive additive-unbaselined whitelist to each
connected candidate component. Every other case is safety-binding/inconclusive and
passes through existing exact consequence checks. `AdmissionResult` exposes exact
`persistBeforeExecution` and `releaseAfterSafeCheckpoint` edge membership associated
with dispositions. A successful synchronized rename is in both; deferred is
persist-only; fresh additive is in neither; loaded false v6 is release-only.

### contract-v6-persistence

`component-rename-debt-carrier` maps only explicit persistence membership to the
unchanged v6 row. The orchestrator completes every upsert before executor I/O or tracker
acknowledgement. Any failed upsert aborts the cycle visibly before both side effects and
preserves loaded and pending retry evidence. Loaded non-binding rows remain stored until
Finalization. Structured lifecycle diagnostics contain paths/stage/reason, not content
or credentials.

### contract-commit-last-retirement

`component-cycle-finalization` deletes an exact release member only after its associated
`resolved_no_action`, or successful `authorized` disposition, and checkpoint commit.
Deferred, failed, blocked, unassociated, or checkpoint-failed membership remains. It
does not stat, project scope, inspect baselines, rebuild graphs, or infer membership from
actions.

## Dependency-ordered units

### acquisition — fixed candidate proof

Files: `change-detector.ts`, `path-observation.ts`, `identity-evidence.ts`,
`cycle-admission-snapshot.ts`, `sync-cycle-planning.ts`, and focused tests. Carry fresh
and replayed candidates in the fixed projection. Prove stat authority, fresh current
scope, and explicit unknowns. Do not decide lifecycle membership.

### admission — promotion and lifecycle output

Files: `plan-admission.ts`, `plan-admission-graph.ts`, `local-rename-admission.ts`, and
tests. Add the pure additive classifier and exact memberships. Prove fresh additive, synchronized native,
destructive mismatch, current-scope unknown, chain conflict, and incomplete folder cases.

### persistence — v6 and orchestration integration

Files: `rename-debt.ts`, `state.ts`, `orchestrator.ts`, and tests. Remove the scope-only
policy role from `collectLocalRenameDebts`; retain at most a mechanical serializer.
Upsert Admission membership before I/O, abort on any failure, replay v6 rows as
candidates, and prove compatibility plus diagnostics.

### finalization — consequence-bound retirement

Files: `sync-cycle-finalization.ts` and tests. Consume exact release membership and its
disposition completion, checkpoint first, then delete. Cover action failure, blocking,
deferral, missing association, and checkpoint failure.

### verification — rationale and full gate

Update stable architecture/pipeline text only where the owner boundary is documented,
retain the accepted ADR, run focused tests and the full gate, and keep blank-file
causality outside completion claims.

## Implementation discretion

Private helper names and placement within each listed unit are free only if they preserve
the fixed projection, owner, memberships, failure ordering, and verification outcomes.
Any change to those shared contracts requires design review; there is no open cross-unit
design choice.
