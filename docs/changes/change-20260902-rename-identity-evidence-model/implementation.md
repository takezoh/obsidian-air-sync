---
change: change-20260902-rename-identity-evidence-model
role: implementation
contracts:
- contract-cycle-evidence
- contract-legal-normalization
- contract-total-admission
- contract-conflict-preparation
- contract-resolver-preservation
- contract-executor-effects-proof
- contract-per-file-cas
- contract-clean-finalization
contract_projections:
- id: contract-cycle-evidence
  verifications:
  - verify-candidate-derived-once
  - verify-deep-immutability
  discretion: []
- id: contract-legal-normalization
  verifications:
  - verify-legal-union-construction
  - verify-cartesian-illegal-states-unconstructible
  discretion: []
- id: contract-total-admission
  verifications:
  - verify-total-decision-matrix
  - verify-third-r-foreign-y-authority
  - verify-single-debt-membership-derivation
  discretion: []
- id: contract-conflict-preparation
  verifications:
  - verify-bounded-stable-byte-snapshot
  - verify-preparation-read-only
  - verify-preparation-terminal-failures
  discretion: []
- id: contract-resolver-preservation
  verifications:
  - verify-primary-additional-semantics
  - verify-all-output-visibility-and-bytes
  - verify-resolver-once-and-retry-numbering
  discretion: []
- id: contract-executor-effects-proof
  verifications:
  - verify-every-partial-cut-reclassifies
  - verify-terminal-old-target-bytes-proof
  - verify-no-raw-retry-or-rollback
  discretion: []
- id: contract-per-file-cas
  verifications:
  - verify-branded-proof-only-cas
  - verify-exact-baseline-cas
  discretion: []
- id: contract-clean-finalization
  verifications:
  - verify-checkpoint-before-exact-release
  - verify-nonclean-withholds-both
  - verify-disconnected-per-file-progress
  discretion: []
adrs:
- adr-0001-metadata-cache-is-subordinate-to-commit-last
- adr-20260831-admission-owns-identity-component-decisi
- adr-20260902-fresh-state-reconciliation-for-rename-edits
- adr-20260903-preserve-all-observed-remote-versions
decision_dispositions:
- decision_input_ref: decision-input-admission-owner
  disposition: adopted; Admission remains the sole normalization, authorization, and
    debt-membership owner.
  adr_refs:
  - adr-20260831-admission-owns-identity-component-decisi
  contract_refs:
  - contract-legal-normalization
  - contract-total-admission
- decision_input_ref: decision-input-fresh-reclassification
  disposition: adopted; every partial cut returns to ordinary fresh legal normalization
    without replay authority.
  adr_refs:
  - adr-20260902-fresh-state-reconciliation-for-rename-edits
  contract_refs:
  - contract-executor-effects-proof
  - contract-clean-finalization
- decision_input_ref: decision-input-multi-remote-preservation
  disposition: adopted by explicit user approval; preserve all observed remote versions
    then resolve primary tracked R once.
  adr_refs:
  - adr-20260903-preserve-all-observed-remote-versions
  contract_refs:
  - contract-conflict-preparation
  - contract-resolver-preservation
- decision_input_ref: decision-input-commit-last
  disposition: adopted; branded terminal proof gates per-file CAS and clean checkpoint
    precedes exact debt release.
  adr_refs:
  - adr-0001-metadata-cache-is-subordinate-to-commit-last
  contract_refs:
  - contract-per-file-cas
  - contract-clean-finalization
milestones:
- id: immutable evidence prerequisite
- id: legal evidence and total authority
- id: bounded preparation and single resolver output
- id: compound mutation and terminal proof
- id: durable commit boundaries
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Dependency order

1. `unit-cycle-evidence` — fold the shallow snapshot carrier into planning, derive the rename
   candidate once, and deep-freeze/copy the complete value.
2. `unit-normalization-admission` — implement the private legal union normalizer, exhaustive total
   Admission switch, and single debt membership derivation.
3. `unit-conflict-resolution` — add bounded read-only snapshot preparation and extend the existing
   resolver's single result to cover ordered primary/additional preservation outputs.
4. `unit-executor-terminal-proof` — sequence resolver then compound effects and construct branded
   proof through a private predicate/helper in `plan-executor.ts`.
5. `unit-commit-finalization` — require proof for per-file CAS and retain separate checkpoint-first,
   exact-release finalization.

## Contracts and seams

| Boundary | Owner | Input → output | Test seam |
|---|---|---|---|
| immutable cycle evidence | planning | raw observations → deeply immutable evidence + one candidate | pure capture/candidate helper |
| normalization | Admission | immutable evidence → legal discriminated union | table-driven pure normalizer |
| total admission | Admission | legal union → disposition + action/debt membership | exhaustive pure switch |
| preparation | conflict resolver component | authorized conflict → exact immutable snapshots/obligations | injected existing `IFileSystem` stat/read |
| conflict output | configured resolver | prepared ordered inputs → verified primary result + all visible outputs | existing conflict allocator and fake filesystems |
| effects/proof | executor | resolver result → mutations → branded proof or typed failure | private proof predicate and fault-injected filesystem |
| per-file persistence | state committer | branded proof + exact baseline → CAS result | existing state store fake |
| global persistence | cycle finalizer | terminal result set → checkpoint then exact release | existing checkpoint/state fakes |

No new terminal-proof component is introduced. Preparation and executor contain no artifact naming
policy. Admission contains no I/O. State committer and finalizer are not wrapped in a composite owner.

## Closed type handoffs

- `CycleEvidence` is deeply readonly and contains the candidate derived once.
- `NormalizedRenameState` is the only normalized product; independent location/occupancy/version
  fields are private raw inputs and never cross the normalizer boundary.
- `PreparedConflict` is `prepared_no_rotation | prepared_rotation_required`; the latter requires
  source identity, stability witness, exact snapshots, and obligations together.
- `ResolverResult` contains the configured primary result plus one verified output per ordered
  obligation. Missing output is failure.
- `TerminalFreshProof` is executor-private and is the only fresh CAS input.

## Primary/additional resolver algorithm

For the accepted multi-remote row, prepare `primary = R`, `additional = [Y]`, in that fixed order.
Within one resolver invocation:

1. Allocate primary then additional paths through the existing cross-filesystem conflict allocator.
2. Write each exact snapshot to the same relative output path on local and remote.
3. Read back both copies and verify exact bytes before any original mutation.
4. Apply configured `auto_merge | duplicate` to local/base/primary R only. Under duplicate, reuse the
   primary preservation path. Additional Y remains an exact visible conflict output.
5. Return the primary action and complete verified output list to executor.

If any step fails, the resolver returns typed external failure and executor starts no destructive
rotation. Already verified outputs remain ordinary user-visible files. On a later fresh invocation,
the allocator can produce further numbered files; it must not infer prior ownership from bytes.

## Fixed resource and concurrency bounds

The multi-remote legal row contains exactly two observed remote versions (R and Y). Each
metadata-insufficient source uses at most two reads with bracketing stats. Preparation memory and
resolver preservation I/O are O(total bytes of those at-most-two versions). No polling or unbounded
retry occurs. Existing external-writer race limits remain: a changed re-read or terminal observation
blocks commit and is not treated as linearizable success.

## Error triage

Admission owns `evidence_unknown | evidence_contradicted` and both imply zero action. Executor maps
external transport failures to `failed`, auth failures to `blocked` plus existing auth signaling,
and proof mismatches to `blocked`. An impossible branded-value mismatch fails fast. Finalization
consumes these terminal results directly and does not invent another retryable-unknown vocabulary.

## Implementation discretion

None. All units have `implementation_decisions_remaining = []`; private names may follow repository
conventions only where renaming does not constitute a design choice or alter a contract.
