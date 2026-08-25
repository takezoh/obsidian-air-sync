---
change: change-20260825-issue43-destructive-authorization
role: implementation
contracts:
- contract-proposal-boundary
- contract-admission-disposition
- contract-finalization-consumer
- contract-preadmission-recovery
contract_projections:
- id: contract-proposal-boundary
  verifications:
  - verify-direct-proposal-rejected
  - verify-snapshot-stability
  - verify-production-admission-path
  discretion: []
- id: contract-admission-disposition
  verifications:
  - verify-admission-disposition-matrix
  - verify-planning-composition
  discretion:
  - discretion-component-membership-carrier
- id: contract-finalization-consumer
  verifications:
  - verify-disposition-finalization
  - verify-cycle-status-and-recovery
  discretion: []
- id: contract-preadmission-recovery
  verifications:
  - verify-post-delta-exception-retention
  - verify-issue46-independent-causality
  discretion: []
adrs:
- adr-0008-logical-identity-admission
- adr-0001-commit-last
- adr-0006-order-independent-rename
- adr-issue43-destructive-authorization
decision_dispositions:
- decision_input_ref: input-single-authorization-owner
  disposition: adopted — Admission alone classifies final destructive permission and
    no-action safety.
  adr_refs:
  - adr-0008-logical-identity-admission
  - adr-issue43-destructive-authorization
  contract_refs:
  - contract-proposal-boundary
  - contract-admission-disposition
  - contract-finalization-consumer
- decision_input_ref: input-actionless-unresolved
  disposition: adopted — retain and visibly defer unresolved relevant components even
    with zero actions.
  adr_refs:
  - adr-0008-logical-identity-admission
  contract_refs:
  - contract-admission-disposition
  - contract-finalization-consumer
- decision_input_ref: input-disposition-carrier
  disposition: adopted — enrich cycle-local AdmissionResult and reject a lifecycle
    service or persistent graph.
  adr_refs:
  - adr-issue43-destructive-authorization
  contract_refs:
  - contract-admission-disposition
  - contract-finalization-consumer
- decision_input_ref: input-membership-encoding
  disposition: implementation_detail — private cycle-local encoding is delegated only
    by discretion-component-membership-carrier.
  contract_refs:
  - contract-admission-disposition
- decision_input_ref: input-preadmission-exception
  disposition: adopted — immediate session capture and later COLD apply only before
    Admission.
  adr_refs:
  - adr-0008-logical-identity-admission
  - adr-0001-commit-last
  - adr-issue43-destructive-authorization
  contract_refs:
  - contract-preadmission-recovery
- decision_input_ref: input-admission-purity-enforcement
  disposition: implementation_detail — deterministic tests and build enforce purity
    for this change; no lint-policy expansion is introduced.
  contract_refs:
  - contract-admission-disposition
- decision_input_ref: input-issue46-cache-causality
  disposition: adopted — keep OneDrive/backend cache evidence causality separate and
    independently verified.
  adr_refs:
  - adr-0006-order-independent-rename
  - adr-issue43-destructive-authorization
- decision_input_ref: input-authorized-plan-marker
  disposition: adopted — executePlan accepts only opaque or nominal AuthorizedSyncPlan
    issued by Admission.
  adr_refs:
  - adr-issue43-destructive-authorization
  contract_refs:
  - contract-proposal-boundary
- decision_input_ref: input-finalization-commit-last
  disposition: adopted — checkpoint commit precedes evidence and debt retirement.
  adr_refs:
  - adr-0001-commit-last
  contract_refs:
  - contract-finalization-consumer
- decision_input_ref: input-same-session-cold-recovery
  disposition: adopted — retained pre-Admission evidence is retried by a later COLD
    observation without a tight loop.
  adr_refs:
  - adr-0001-commit-last
  - adr-issue43-destructive-authorization
  contract_refs:
  - contract-preadmission-recovery
- decision_input_ref: decision-input-unified-final-authorization
  disposition: subsumed — input-single-authorization-owner fixes the same Admission-only
    authority boundary.
  adr_refs:
  - adr-0008-logical-identity-admission
  contract_refs:
  - contract-proposal-boundary
  - contract-admission-disposition
- decision_input_ref: decision-input-checkpoint-carrier-shape
  disposition: subsumed — input-disposition-carrier retains cycle-local dispositions
    and existing bounded debt or session carriers.
  adr_refs:
  - adr-0001-commit-last
  - adr-issue43-destructive-authorization
  contract_refs:
  - contract-finalization-consumer
- decision_input_ref: decision-input-actionless-component-retention
  disposition: subsumed — input-actionless-unresolved fixes exhaustive relevant-component
    retention.
  adr_refs:
  - adr-0008-logical-identity-admission
  contract_refs:
  - contract-admission-disposition
- decision_input_ref: decision-input-new-persistent-disposition
  disposition: rejected — persistent disposition state and lifecycle graphs add ownership
    without improving existing bounded recovery.
  adr_refs:
  - adr-issue43-destructive-authorization
  contract_refs:
  - contract-admission-disposition
  - contract-finalization-consumer
- decision_input_ref: decision-input-issue46-fold-in
  disposition: rejected — Issue 46 evidence-production causality remains independent
    from authorization and exception retention.
  adr_refs:
  - adr-0006-order-independent-rename
  - adr-issue43-destructive-authorization
- decision_input_ref: decision-input-api-rename
  disposition: adopted — API change is limited to nominal executor input and snapshot-bound
    Admission output; proposal APIs remain plain SyncPlan.
  adr_refs:
  - adr-issue43-destructive-authorization
  contract_refs:
  - contract-proposal-boundary
- decision_input_ref: decision-input-purity-lint
  disposition: rejected — do not expand lint policy without repository authority;
    deterministic contract tests and build are required.
  contract_refs:
  - contract-admission-disposition
milestones:
- id: '1'
- id: '2'
- id: '3'
- id: '4'
reference_algorithms: []
---

# Implementation
