---
change: change-20260904-case-alias-parent-transition
role: implementation
contracts:
- contract-production-shape-gate
- contract-provider-resolved-topology
- contract-admission-parent-transition
- contract-exact-execution-and-checkpoint
contract_projections:
- id: contract-production-shape-gate
  verifications:
  - verify-cold-production-shape
  - verify-provider-paired-controls
  discretion: []
- id: contract-provider-resolved-topology
  verifications:
  - verify-google-provider-topology
  - verify-onedrive-provider-topology
  - verify-dropbox-provider-topology
  - verify-three-backend-cache-contract
  discretion: []
- id: contract-admission-parent-transition
  verifications:
  - verify-same-cycle-mixed-admission
  - verify-temperature-independent-decision
  discretion: []
- id: contract-exact-execution-and-checkpoint
  verifications:
  - verify-executor-phase-order
  - verify-checkpoint-last
  - verify-state-ownership-guard
  - verify-full-repository-gate
  discretion: []
adrs:
- adr-0001-commit-last-cache
- adr-0008-fail-closed-identity
- adr-four-stage-sync-pipeline
decision_dispositions:
- decision_input_ref: input-requested-echo
  disposition: 'adopted: Requested echo is retained only as an untrusted lookup or
    caller echo and is prohibited from proving or re-keying topology.'
  adr_refs:
  - adr-0008-fail-closed-identity
  contract_refs:
  - contract-provider-resolved-topology
- decision_input_ref: input-backend-only
  disposition: 'rejected: Provider targeting is necessary but cannot replace the explicit
    parent topology effect or make mutually invalidating child topology actions jointly
    executable.'
  contract_refs:
  - contract-provider-resolved-topology
  - contract-admission-parent-transition
- decision_input_ref: input-admission-owns-topology
  disposition: 'adopted: Admission remains the sole owner that converts complete component
    evidence into authorized topology actions.'
  adr_refs:
  - adr-0008-fail-closed-identity
  contract_refs:
  - contract-admission-parent-transition
- decision_input_ref: input-executor-exact-actions
  disposition: 'adopted: Execution retains the existing exact-plan transfer, serial-conflict,
    and structural phases without inference.'
  adr_refs:
  - adr-four-stage-sync-pipeline
  contract_refs:
  - contract-exact-execution-and-checkpoint
- decision_input_ref: input-no-third-authority
  disposition: 'adopted: The design uses only cycle evidence, per-file SyncRecords,
    and the clean remote checkpoint; no state owner is added.'
  adr_refs:
  - adr-0001-commit-last-cache
  contract_refs:
  - contract-exact-execution-and-checkpoint
- decision_input_ref: decision-input-repair-topology
  disposition: 'adopted: The repair is one same-cycle Admission normalization plus
    a subordinate provider-truth boundary, not a recovery flow.'
  contract_refs:
  - contract-admission-parent-transition
  - contract-provider-resolved-topology
- decision_input_ref: decision-input-compound-protocol
  disposition: 'rejected: Existing action types and phase barriers express the joint
    plan without new partial-effect or resume semantics.'
  adr_refs:
  - adr-four-stage-sync-pipeline
  contract_refs:
  - contract-admission-parent-transition
- decision_input_ref: decision-input-generic-dag
  disposition: 'rejected: A dependency graph would duplicate Admission reasoning in
    Execution and add bookkeeping not required by the single parent transition.'
  adr_refs:
  - adr-four-stage-sync-pipeline
  contract_refs:
  - contract-exact-execution-and-checkpoint
- decision_input_ref: decision-input-filesystem-only
  disposition: 'rejected: The shared filesystem correction is necessary but the reproduced
    control proves it is insufficient without Admission parent normalization.'
  contract_refs:
  - contract-provider-resolved-topology
  - contract-admission-parent-transition
- decision_input_ref: decision-input-new-state
  disposition: 'rejected: Persisted intent, recovery status, pending work, and additional
    correctness memory violate the closed authority model and are unnecessary.'
  adr_refs:
  - adr-0001-commit-last-cache
  - adr-0008-fail-closed-identity
  contract_refs:
  - contract-exact-execution-and-checkpoint
- decision_input_ref: decision-input-durable-authority
  disposition: 'adopted: Per-file SyncRecords remain post-I/O authority and cursor
    plus complete cache remain clean-cycle commit-last authority.'
  adr_refs:
  - adr-0001-commit-last-cache
  contract_refs:
  - contract-exact-execution-and-checkpoint
- decision_input_ref: decision-input-cache-topology
  disposition: 'adopted: The metadata cache remains a provider-derived working projection
    and never records requested or intended topology as fact.'
  adr_refs:
  - adr-0001-commit-last-cache
  contract_refs:
  - contract-provider-resolved-topology
- decision_input_ref: decision-input-admission-owner
  disposition: 'subsumed: Closed by input-admission-owns-topology and the same Admission
    contract.'
  contract_refs:
  - contract-admission-parent-transition
- decision_input_ref: decision-input-folder-component
  disposition: 'adopted: A complete folder component is the current parent identity
    plus the full managed descendant identity set, not a new persistent folder identity.'
  adr_refs:
  - adr-0008-fail-closed-identity
  contract_refs:
  - contract-admission-parent-transition
- decision_input_ref: decision-input-executor-boundary
  disposition: 'adopted: Executor performs authorized actions exactly and does not
    infer ancestor renames or re-admit actions.'
  adr_refs:
  - adr-four-stage-sync-pipeline
  contract_refs:
  - contract-exact-execution-and-checkpoint
- decision_input_ref: decision-input-retry-model
  disposition: 'adopted: Any incomplete attempt aborts its live view and the next
    COLD, WARM, or HOT acquisition decides only from current facts and committed records.'
  adr_refs:
  - adr-0001-commit-last-cache
  - adr-0008-fail-closed-identity
  contract_refs:
  - contract-exact-execution-and-checkpoint
milestones:
- id: test-only-evidence-gate
- id: shared-filesystem-boundary
- id: admission-normalization
- id: integration-and-recurrence-guard
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

### Responsibility boundary

- Observation supplies current endpoint and baseline facts only.
- Admission owns complete-component authorization and emits existing action types only.
- The cache-backed filesystem owns provider-resolved mutation targeting and the attempt-local derived projection; requested paths are untrusted addresses.
- Execution runs the immutable authorized plan through the existing transfer, serial-conflict, and structural phases.
- Existing state owners retain post-I/O per-file commits and wholly-clean cursor/cache commit-last.

### Unit 0 — production-shape gate

Files: `src/sync/orchestrator.test.ts`, `src/sync/plan-admission.test.ts`, and the Google Drive, OneDrive, and Dropbox adapter tests.

Before any production change, enter through the real COLD Observation→Decision→Admission path. Record the exact parent stable identity, complete managed descendant set, and proposed/admitted action subtypes for local-only, remote-only, conflict, unchanged, and topology-only children. Include a remote-only delta case that would be lost by a parent-only clean checkpoint.

For every adapter, add paired controls: an alias lookup returning provider `Templates` must not re-key; an explicit rename response returning provider `TemplateS` must re-key. A manually constructed `AuthorizedSyncPlan` is not sufficient evidence. If required carriers are absent or controls conflict, stop before production edits and revise the design.

### Unit 1 — provider-resolved topology

Files: `src/fs/caching/metadata-cache.ts`, `src/fs/caching/path-authority.ts`, `src/fs/caching/remote-fs.ts`, the three backend implementations/tests, `tests/fs/contracts/caching-remote-fs.contract.ts`, and the central remote backend contract composition.

Keep requested spelling separate from effective provider topology. Resolve each previously unresolved parent segment once per attempt through the existing live cache. Resolve the existing child at most once per mutation. Use one provider-returned target lineage for identity/CAS, provider I/O, and the live projection. Later siblings reuse the resolved parent with zero additional parent lookups.

Requested echo never re-keys. Provider-resolved mutation metadata may update topology; when a provider returns sparse metadata, only the successful endpoint of an explicit rename may do so. A sparse write response refreshes the identity at its current path without moving it. Google Drive's single child lookup must expose enough cardinality to distinguish zero, one, and multiple results; ambiguity on any backend rejects the mutation. Do not prefetch, add a resolver cache, infer an ancestor rename, or fall back from ambiguous identity to create.

### Unit 2 — Admission parent transition

Files: `src/sync/plan-admission.ts`, `src/sync/plan-admission-graph.ts`, `src/sync/plan-admission-case-alias.ts`, `src/sync/optimize-local-renames.ts`, `src/sync/types.ts`, and focused tests.

Using the current immutable component evidence, prove one same-identity parent mapping, local/baseline case intent, inclusion scope, destination non-foreignness, and the complete managed descendant identity set. Preserve every `push`, `pull`, and `conflict` action. Remove only descendant `rename_remote` actions whose sole effect is the same parent casing transition. Emit exactly one existing parent `rename_remote(oldParent, newParent, isFolder=true)`.

Any incomplete, crossed, ambiguous, foreign, recreated, or unclassified component retains existing fail-closed behavior. Do not create a parent-only defer, new disposition/status, action type, generic DAG, executor metadata, late re-admission, or state outside the cycle snapshot.

### Unit 3 — convergence and enforcement

Files: integration tests, `sync-state-ownership-guard.test.mjs` at repository root, `AGENTS.md`, `docs/code-enforcement.md`, ADR 0001, ADR 0008, and the four-stage pipeline design.

Prove exact provider event order: transfer content, serial conflict, structural parent rename, then clean cursor/cache publication. Prove a content or parent-rename failure prevents checkpoint publication while successful per-file records retain their existing semantics and an ordinary later COLD/WARM/HOT cycle re-evaluates current facts.

Register the shared provider behavior for Google Drive, OneDrive, and Dropbox. Clarify the existing documents and guards in place; do not add an ADR, schema, runtime registry, state taxonomy, orchestrator field, or provider-specific recovery policy.

### Dependency order

`Unit 0 → Unit 1 → Unit 2 → Unit 3`. Unit 0 is a hard production-change gate. Units 1 and 2 may not be merged independently because provider target truth and Admission plan completeness are both necessary for convergence.

### Commit and abort semantics

A successful child action may commit its own `SyncRecord`. Cursor plus complete derived cache remain unpublished until every authorized action, including the remote-only child and parent folder rename, has terminal success. Any missing proof, rejection, block, provider ambiguity, or precondition change makes the cycle non-clean and uses the existing working-view abort lifecycle. No compensation or recovery marker is added.

### Design constraints

The implementation must preserve `contract-production-shape-gate`, `contract-provider-resolved-topology`, `contract-admission-parent-transition`, and `contract-exact-execution-and-checkpoint` from the canonical design. There are no open architecture choices. Private helper placement and backend request syntax may vary only if the named verification observes identical action sets, failure behavior, provider-call counts, and checkpoint order.
