---
change: change-20260904-case-only-rename-continuity
role: implementation
contracts:
- contract-final-cache-projection
- contract-contextual-identity-continuity
- contract-actionless-rename-terminal
contract_projections:
- id: contract-final-cache-projection
  verifications:
  - verify-cache-projection-shared
  - verify-google-restart-projection
  - verify-cache-persist-failure
  - verify-full-gate
  discretion:
  - discretion-cache-touch-carrier
- id: contract-contextual-identity-continuity
  verifications:
  - verify-contextual-identity-evidence
  - verify-cold-folder-reconstruction
  - verify-ordinary-continuity-suppressed
  discretion:
  - discretion-folder-continuity-grouping
- id: contract-actionless-rename-terminal
  verifications:
  - verify-actionless-identity-partition
  - verify-cold-recovery-integration
  - verify-case-only-live-fidelity
  discretion: []
adrs:
- adr-0001-commit-last-cache
- adr-0002-backends-verified-by-shared-behaviour-contracts
- adr-0003-opt-in-e2e-validates-fakes-against-real-backends
- adr-0008-fail-closed-identity
- adr-four-stage-sync
- adr-stateless-current-recovery
decision_dispositions:
- decision_input_ref: decision-input-checkpoint-projection-strategy
  disposition: Adopt the existing touched-path projection for every successful cache
    mutation origin; this subsumes decision-input-checkpoint-projection and rejects
    provider-local pending state and ordinary full-store rewrites.
  adr_refs:
  - adr-0001-commit-last-cache
  - adr-stateless-current-recovery
  contract_refs:
  - contract-final-cache-projection
- decision_input_ref: decision-input-checkpoint-projection
  disposition: Subsumed by decision-input-checkpoint-projection-strategy with the
    same existing deferred Set and atomic clean commit.
  adr_refs:
  - adr-0001-commit-last-cache
  contract_refs:
  - contract-final-cache-projection
- decision_input_ref: decision-input-continuity-carrier
  disposition: Reuse relation-contextual stable_identity occurrences and existing
    current_state RenameEvidence; reject a new carrier and universal same-path emission.
  adr_refs:
  - adr-0008-fail-closed-identity
  - adr-four-stage-sync
  contract_refs:
  - contract-contextual-identity-continuity
- decision_input_ref: decision-input-actionless-status
  disposition: Subsumed by decision-input-actionless-partition; keep resolved_no_action
    and existing failures with no Orchestrator override or ambiguous status.
  adr_refs:
  - adr-0008-fail-closed-identity
  - adr-four-stage-sync
  contract_refs:
  - contract-actionless-rename-terminal
- decision_input_ref: decision-input-actionless-partition
  disposition: Require authoritative endpoints plus file X/X or a complete managed-descendant
    folder set; use resolved_no_action, exact match/cleanup baseline convergence,
    or existing fail-closed reasons.
  adr_refs:
  - adr-0008-fail-closed-identity
  - adr-stateless-current-recovery
  contract_refs:
  - contract-actionless-rename-terminal
- decision_input_ref: decision-input-provider-coverage
  disposition: Put deterministic projection coverage in the central Google Drive,
    Dropbox, and OneDrive contract matrix and retain one Google-shaped restart replay
    regression.
  adr_refs:
  - adr-0002-backends-verified-by-shared-behaviour-contracts
  - adr-0003-opt-in-e2e-validates-fakes-against-real-backends
  contract_refs:
  - contract-final-cache-projection
- decision_input_ref: decision-input-persisted-recovery
  disposition: Reject journal, pending status, receipt, folder SyncRecord, and schema
    migration; recompute a unique current-state relation and converge through existing
    bookkeeping actions.
  adr_refs:
  - adr-stateless-current-recovery
  contract_refs:
  - contract-contextual-identity-continuity
  - contract-actionless-rename-terminal
- decision_input_ref: decision-input-production-google-direction
  disposition: Treat unavailable raw event direction as optional live-fidelity evidence
    that does not block the deterministic projection, continuity, or COLD recovery
    contracts.
  adr_refs:
  - adr-0003-opt-in-e2e-validates-fakes-against-real-backends
  - adr-stateless-current-recovery
  contract_refs:
  - contract-final-cache-projection
  - contract-contextual-identity-continuity
milestones:
- id: cache-projection
- id: observation-admission
- id: integration-docs
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

### Responsibility boundaries

- `CachingRemoteFs` owns the live cache, deferred affected-path projection, and the
  existing atomic file-map/cursor/scope checkpoint. Provider subclasses identify exact
  paths at their existing cache-mutation seams; `MetadataStore` does not infer them.
- Observation owns cycle-local facts. It reuses `stable_identity` and the existing
  WARM/COLD `current_state` rename inference; it performs no persistence and Admission
  performs no filesystem reads.
- Admission owns file/folder continuity, relation-local alias handling, and
  authorization. Folder continuity is a complete included managed-descendant identity
  set, not a new root identity.
- Execution keeps existing actions. A recovered stale baseline may use only `match` at
  proved new paths and `cleanup` at corresponding old records; these change SyncRecords,
  not either filesystem. The Orchestrator remains sequencing-only.

### Contract 1 — Final cache projection

Broaden the existing touched-path set from delta-only bookkeeping to every successful
live-cache mutation. Register in the same cache-mutex critical section:

- the write/mkdir path and every created or adopted implicit parent;
- both roots and every old/new descendant of a folder rename;
- every root/descendant removed by delete; and
- any path re-keyed or displaced by the applied cache mutation.

Do not register a mutation skipped by the existing stale guard. At clean checkpoint,
read final present/absent values from the live cache and use the existing atomic
transaction. Clear only after successful commit; full scan and reset keep their existing
supersession semantics. Public checkpoint methods, cursor keys, and store schema do not
change.

### Contract 2 — Contextual identity and COLD relation recovery

For a relation-connected target, preserve baseline/current occurrences even at the same
path. Keep X/X under one `stable_identity`, X/Y as distinct phase-qualified facts, and
invent nothing for a missing key. Ordinary unrelated same-path rows stay suppressed.

Extend current-state case inference with a grouped folder form. A relation is emitted
only when one old/new folder-root pair explains the complete included managed file set:

- roots differ only by casing and all descendant mappings preserve exact suffixes;
- every suffix occurs exactly once at baseline and once in current local/remote state;
- every pair has the same non-empty baseline/current remote identity;
- at least one managed descendant exists;
- old/new endpoint observations are authoritative; and
- no unmatched descendant, duplicate folded target, independent occupant, or second
  root mapping exists.

At least one baseline descendant must use the old root for relation-loss recovery.
Emit the existing folder/child `RenameEvidence` with `authority: current_state`; add no
new carrier or durable fact.

### Contract 3 — Admission terminality and baseline convergence

For a file, zero-action terminality requires authoritative endpoint convergence and an
equal non-empty baseline/current target identity. For a folder, it requires the complete
non-empty descendant set above. A reported folder identity may confirm the current root
but cannot replace descendant continuity because no committed root identity exists.

Allow `alias_target_mutation` bypass only for exact file or folder/suffix pairs in the
proved relation. For a complete `current_state` relation whose baseline is still at the
old root, authorize only the already proposed `match` targets and `cleanup` sources so
the existing state committer converges the records. Do not construct a new action and do
not authorize push, pull, delete, rename, or conflict through this recovery rule.

Reuse current outcomes: X/X can be `resolved_no_action`; X/Y is
`conflicting_identity`; missing or empty proof is `identity_postcondition_unproven`;
incomplete/duplicate mapping is `incomplete_folder_mapping`; unrelated alias remains
`alias_target_mutation`.

### Dependency-ordered units

1. **Final cache projection.** Implement exact mutation-footprint recording in
   `src/fs/caching/remote-fs.ts`, the metadata cache as needed, and all three backend
   mutation seams. Make the Google restart RED and central caching contract green.
2. **Contextual folder continuity.** Implement sparse same-target evidence, unique
   grouped COLD inference, and Admission's complete descendant-set and bookkeeping-only
   rules. Pair every safe fixture with foreign, missing, empty, partial, duplicate,
   multi-root, and unrelated-alias fixtures.
3. **Integration and documentation closure.** Prove reported self echo and pre-existing
   COLD recovery through Orchestrator tests, run the shared three-backend matrix, add the
   optional live case-only folder scenario, and narrowly update the active four-stage
   design, ADR 0001/0008 clarification, sync pipeline, and stale Dropbox lifecycle text.

### Explicit non-goals

No Orchestrator policy, persisted rename/folder identity, operation receipt or journal,
new status/disposition/evidence kind, provider-specific Admission rule, path/content
identity inference, public API change, schema migration, or per-action full-cache scan.
