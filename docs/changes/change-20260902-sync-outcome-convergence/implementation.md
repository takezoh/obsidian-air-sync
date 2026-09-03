---
change: change-20260902-sync-outcome-convergence
role: implementation
contracts:
- contract-fresh-state-classification
- contract-fresh-compound-execution
- contract-existing-conflict-adaptation
- contract-existing-recovery-finalization
contract_projections:
- id: contract-fresh-state-classification
  verifications:
  - verify-fresh-six-state-matrix
  - verify-legacy-edge-candidate-not-authority
  - verify-stale-cache-changed-remote-conflict
  discretion: []
- id: contract-fresh-compound-execution
  verifications:
  - verify-rename-write-terminal-commit
  - verify-partial-effect-next-fresh-state
  - verify-no-rollback-or-raw-rename-retry
  discretion: []
- id: contract-existing-conflict-adaptation
  verifications:
  - verify-rename-aware-auto-merge-inputs
  - verify-rename-aware-duplicate-preserves-remote
  - verify-single-existing-resolver-delegation
  discretion: []
- id: contract-existing-recovery-finalization
  verifications:
  - verify-existing-checkpoint-clean-only
  - verify-disconnected-progress-failed-checkpoint
  - verify-v6-exact-release-existing-finalization
  - verify-no-new-provider-or-store-surface
  discretion: []
adrs:
- adr-0001-metadata-cache-is-subordinate-to-commit-last
- adr-0002-backends-verified-by-shared-behaviour-contracts
- adr-0008-logical-identity-admission-fails-closed
- adr-20260831-admission-owns-identity-component-decisi
- adr-20260831-admission-owned-local-rename-constraint-lifecycle
- adr-20260902-authorized-operation-journal-with-nonreplaying-attention
- adr-20260902-compound-conflict-resolution-and-conditional-mutation
- adr-20260902-fresh-state-reconciliation-for-rename-edits
decision_dispositions:
- decision_input_ref: decision-input-explicit-operation-journal
  disposition: rejected by confirmed consultation; no durable operation carrier exists
  adr_refs:
  - adr-20260902-authorized-operation-journal-with-nonreplaying-attention
  - adr-20260902-fresh-state-reconciliation-for-rename-edits
- decision_input_ref: decision-input-remove-deferred-outcome
  disposition: adopted as invocation-local retry/error plus fresh next-sync recomputation
  contract_refs:
  - contract-fresh-state-classification
  - contract-existing-recovery-finalization
- decision_input_ref: decision-input-configured-conflict-resolver
  disposition: adopted through a transient path-aware adapter into existing auto_merge
    or duplicate
  contract_refs:
  - contract-existing-conflict-adaptation
- decision_input_ref: decision-input-conditional-remote-mutation
  disposition: rejected as a required new boundary; existing interface snapshot semantics
    remain explicit
  adr_refs:
  - adr-20260902-compound-conflict-resolution-and-conditional-mutation
  - adr-20260902-fresh-state-reconciliation-for-rename-edits
- decision_input_ref: decision-input-separate-journal-store
  disposition: rejected; no new store is introduced
  adr_refs:
  - adr-20260902-authorized-operation-journal-with-nonreplaying-attention
- decision_input_ref: decision-input-pinned-content
  disposition: rejected; current local content is acquired within each invocation
  contract_refs:
  - contract-fresh-compound-execution
- decision_input_ref: decision-input-observation-derived-phase
  disposition: adopted as wholly fresh classification with no phase field
  contract_refs:
  - contract-fresh-state-classification
- decision_input_ref: decision-input-smaller-nonjournal-reconstruction
  disposition: adopted by explicit consultation as current local/baseline/remote reconciliation
  adr_refs:
  - adr-20260902-fresh-state-reconciliation-for-rename-edits
- decision_input_ref: decision-input-accepted-deferral-adrs
  disposition: retain authority/commit-last/exact release and supersede deferred/replay
    interpretation
  adr_refs:
  - adr-0008-logical-identity-admission-fails-closed
  - adr-20260831-admission-owns-identity-component-decisi
  - adr-20260831-admission-owned-local-rename-constraint-lifecycle
  - adr-20260902-fresh-state-reconciliation-for-rename-edits
- decision_input_ref: decision-input-journal-attention-authority
  disposition: rejected; no attention workflow or explicit retry authority exists
  adr_refs:
  - adr-20260902-authorized-operation-journal-with-nonreplaying-attention
- decision_input_ref: decision-input-legacy-forward-only
  disposition: rejected; unchanged v6 evidence uses existing COLD and exact release
    without new rollout mode
  contract_refs:
  - contract-existing-recovery-finalization
- decision_input_ref: DI-CONV-001
  disposition: rejected as replay authority; retained only as candidate endpoint evidence
  contract_refs:
  - contract-fresh-state-classification
  - contract-existing-recovery-finalization
- decision_input_ref: DI-CONV-002
  disposition: rejected; consultation selected no journal
  adr_refs:
  - adr-20260902-authorized-operation-journal-with-nonreplaying-attention
- decision_input_ref: DI-CONV-003
  disposition: adopted as fresh six-state reconciliation
  contract_refs:
  - contract-fresh-state-classification
- decision_input_ref: DI-CONV-004
  disposition: rejected as independently schedulable actions; one compound action
    owns ordering
  contract_refs:
  - contract-fresh-compound-execution
- decision_input_ref: DI-CONV-005
  disposition: preflight-only atomicity claim rejected; existing snapshot boundary
    is stated without new guard
  contract_refs:
  - contract-fresh-compound-execution
- decision_input_ref: DI-CONV-006
  disposition: adopted; SyncState v6 remains physically unchanged with no migration
  contract_refs:
  - contract-existing-recovery-finalization
- decision_input_ref: DI-CONV-007
  disposition: rejected as rollout gate; current provider interfaces and shared contracts
    remain
  contract_refs:
  - contract-existing-recovery-finalization
milestones:
- id: '1'
- id: '2'
- id: '3'
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Contracts and seams

- Acquisition resolves current local `new`, committed old/new `SyncRecord`, fresh remote baseline identity, and both endpoints through existing interfaces. A v6 edge requests endpoint inclusion only.
- Admission exclusively selects `converged`, `post_rename_old_content`, `old_path_baseline`, remote/destination conflict, or retryable unknown. It emits one compound action and never independent delete/push fallback.
- The executor handles `old_path_baseline` as serial existing rename → observe → read current local → existing write → verify; `post_rename_old_content` skips rename; `converged` performs state-only repair. Baseline commit follows terminal verification.
- Failure commits no operation state. Existing action error/COLD recovery makes the next ordinary invocation recompute. No rollback rename or blind raw rename retry.
- A narrow transient adapter supplies target `new`, local read `new`, baseline content `old`, and current remote read path to the existing `auto_merge | duplicate` resolver. Each fresh invocation delegates at most once to existing resolver semantics. Content equality does not identify ownership of a prior conflict output, and no cross-invocation exactly-once artifact guarantee is added.
- Existing finalization commits a clean checkpoint then exact debt release. Legacy debt is unchanged candidate evidence, never action authority.

## Dependency order

1. `unit-fresh-classification-admission`: six-state classification, one compound action, candidate-only legacy edge, exhaustive stale/unknown/conflict tests.
2. `unit-fresh-execution-conflict`: ordered rename/write resume and path-aware existing resolver adaptation with crash/partial and single-delegation tests.
3. `unit-existing-finalization-observability`: existing commit-last/debt release, deferred/pending removal, docs/guards, and full gate.

## Fixed failure boundary

The current provider interface does not provide an atomic precondition against an external writer racing after the final snapshot. This change does not claim that guarantee. It guarantees that every observed changed state enters conflict, every failed/uncertain invocation commits no new baseline/checkpoint, and every later invocation starts from fresh evidence.

## Implementation discretion

Private helper/type names and file split are reversible within their owning unit. Escalate any choice that adds persistent state, changes provider/checkpoint interfaces, adds a conflict strategy, changes existing checkpoint/debt ordering, or weakens fresh evidence requirements.
