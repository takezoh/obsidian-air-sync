---
change: change-20260912-sync-policy-boundary-simplification
role: implementation
contracts:
- contract-observation-policy-gate
- contract-admission-policy-compiler
- contract-execution-policy-consumption
- contract-publication-lifecycle
- contract-cycle-audit-provenance
contract_projections:
- id: contract-observation-policy-gate
  verifications: [verify-observation-read-gate, verify-admission-owner-guard]
  discretion: [discretion-observation-predicate-shape]
- id: contract-admission-policy-compiler
  verifications: [verify-policy-mapping-matrix, verify-admission-owner-guard, verify-convergence-matrix]
  discretion: [discretion-policy-helper-placement]
- id: contract-execution-policy-consumption
  verifications: [verify-executor-policy-validation, verify-conflict-resolver-matrix, verify-interruption-convergence, verify-state-owner-guard]
  discretion: [discretion-policy-validator-shape]
- id: contract-publication-lifecycle
  verifications: [verify-proven-publication, verify-attempt-closeout, verify-state-owner-guard]
  discretion: []
- id: contract-cycle-audit-provenance
  verifications: [verify-cycle-strategy-consistency, verify-audit-projection]
  discretion: []
adrs:
- adr-20260831-admission-owns-identity-component-decisi
- adr-20260903-four-stage-sync-pipeline
- adr-20260905-fact-first-component-admission
- adr-0001-commit-last-recovery
milestones:
- id: '0'
- id: '1'
- id: '2'
- id: '3'
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

1. `unit-policy-contract-red`: add discriminating RED tests and guard fixtures for
   policy ownership, the closed mapping, malformed actions, and bounded reads.
2. `unit-admission-policy`: define required `ConflictExecutionPolicy`, retire the
   optional Prefer-local disposition, and compile the policy only in Admission.
3. `unit-execution-consumption`: remove raw strategy from execution/resolver inputs,
   validate before I/O, and dispatch exhaustively on the admitted policy while preserving
   the independent Commit/finalization lifecycle.
4. `unit-cycle-audit-docs`: project audit provenance from each action, update focused
   orchestration tests and active documentation, then run all ownership guards and the full gate.

Private pure helpers are explicit implementation discretion inside their owner. The full
file sets, dependencies, acceptance IDs, escalation conditions, and verification commands
are defined in `design-plan/spine.yaml`.

## Implemented shape

- Observation keeps a private pure acquisition predicate for Prefer-local hash
  enrichment; it returns no action or policy.
- Admission materializes every conflict as a `ConflictAction` with required `protocol`
  and `ConflictExecutionPolicy`.
- Execution validates that contract before I/O; the resolver dispatches on its closed
  mode and the audit record projects strategy provenance from the same action.
- The structural guard rejects the retired disposition, optional conflict contracts,
  and raw strategy interpretation in executor, resolver, or audit code.
- The executor validator checks preservation-cover relationships, not only field shapes:
  candidate paths are canonical full-SHA siblings, and preserved/executable paths retain
  their exact candidate-order partition. Tests pin every Prefer-local fallback predicate,
  all I/O aliases, mixed-action audit provenance, and equivalent raw-strategy access syntax.
