---
change: change-20260912-issue73-local-win
role: implementation
contracts:
- contract-pl-proof-acquisition
- contract-pl-admission
- contract-pl-execution
- contract-pl-settings
- contract-pl-verification
contract_projections:
- id: contract-pl-proof-acquisition
  verifications:
  - verify-pl-read-gate
  - verify-pl-temperature
  discretion: []
- id: contract-pl-admission
  verifications:
  - verify-pl-proof-table
  - verify-pl-admission-guard
  discretion:
  - discretion-pl-private-names
- id: contract-pl-execution
  verifications:
  - verify-pl-effects
  - verify-pl-lifecycle
  discretion: []
- id: contract-pl-settings
  verifications:
  - verify-pl-settings
  discretion: []
- id: contract-pl-verification
  verifications:
  - verify-pl-full-gate
  discretion: []
adrs: []
decision_dispositions:
- decision_input_ref: decision-admission-owner
  disposition: adopted
  contract_refs:
  - contract-pl-admission
- decision_input_ref: decision-attempt-evidence
  disposition: adopted
  contract_refs:
  - contract-pl-proof-acquisition
  - contract-pl-execution
- decision_input_ref: decision-single-route
  disposition: adopted
  contract_refs:
  - contract-pl-execution
- decision_input_ref: decision-two-publications
  disposition: adopted
  contract_refs:
  - contract-pl-execution
- decision_input_ref: decision-content-proof
  disposition: adopted
  contract_refs:
  - contract-pl-proof-acquisition
  - contract-pl-admission
milestones:
- id: '1'
- id: '2'
- id: '3'
- id: '4'
- id: '5'
- id: '6'
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Authority and seams

`identity-component-decision.ts` remains the only policy owner. The existing `change-hash-enrichment` path completes only missing current SHA-256 `FileEntity.hash` facts for qualified candidates; BatchObservation and Admission carry no exact content buffer. A Prefer-local conflict action carries exactly one attempt-local disposition, `local_win_allowed | preservation_required`; same-content, edit/delete survivor, and compound behavior stay on their existing match/action/topology paths. Resolver captures exact snapshots at application time and selects effects but never mutates original paths or re-decides eligibility; PlanExecutor retains source revalidation, original-path effects, preservation verification, terminal proof, ordering, and publication.

The common proof authority is non-empty `SyncRecord.hash` (SHA-256). For a qualified candidate, use the existing enrichment mechanism to calculate only missing current endpoint SHA-256 facts. A provider checksum may be a fast path only when its declared algorithm is SHA-256 and it participates in the same-algorithm comparison; otherwise the enrichment path reads and hashes the endpoint, then discards the buffer. `remoteChecksum` without a declared common algorithm, identity, mtime, size, record existence, and merge-base availability cannot substitute for the common baseline.

## Dependency-ordered chunks

1. **Strategy wire and setting:** update the closed strategy union, normalization tests, UI selector/description, and audit consumers. Keep default Auto merge and `ask -> duplicate`. Add only the attempt-local binary disposition carrier. Verify persistence and accessible association. Invalid wire fails type/focused tests; no rollback state.
2. **Strategy-gated fact completion:** extend `change-hash-enrichment` locally, with only necessary call-site changes, after scope projection. Apply one predicate: current normalized strategy is Prefer local, both endpoints are present, the candidate is baseline-backed simple same-path two-sided conflict, and the baseline hash is non-empty. Complete only missing current SHA-256 `FileEntity.hash` facts and never add exact-content fields to BatchObservation or Admission. Verify exact read counts, injected failures/mutation, checksum fast path, and COLD/WARM/HOT equality. Required acquisition failure is non-clean before action/publication.
3. **Admission partition:** in `identity-component-decision.ts`, with private placement in an existing helper only if useful, implement match -> existing survivor/compound route -> three-inequality `local_win_allowed` -> `preservation_required` -> typed failure precedence. Add exhaustive table tests for empty/missing hashes, algorithm mismatch, equal current values, fallback remote hash enrichment, edit/delete and compound cases, plus Admission authority guards. Do not require a new helper.
4. **Single-route effects:** extend `conflict-resolver.ts`/`plan-executor.ts` only to consume the binary disposition. At application time reacquire/revalidate exact snapshots. Proven local-win selects exact local bytes with no ordinary copy; uncertain uses Duplicate placement; compound preservation remains complete and verified before destruction. Missing/invalid disposition on a Prefer-local conflict is a fatal contract violation. Partial effects publish nothing and add no compensating rollback.
5. **Cycle/lifecycle closure:** add convergence, crash, finalization, per-strategy read-count and injected-read-failure tests across COLD/WARM/HOT. Verify no file record before terminal proof, no checkpoint for incomplete cycles, sibling settlement before abort, and current-facts retry with no marker.
6. **Docs and gate:** update README/architecture/conflict/pipeline/enforcement claims as needed; create no ADR. Run the complete repository gate.

## Implementation discretion

The default is a localized addition to existing `change-hash-enrichment` and private comparison at the existing Admission decision site; no new helper is mandatory. Private names and placement may vary within the owning existing modules. Escalate if this requires a public/persisted wire, Admission I/O, action-bearing observation, exact snapshot transport, another policy owner, new route, changed read count, or changed outcome.

## Minimality and expansion signals

The minimality audit classifies one shared-boundary change as necessary: localized Prefer-local-only current SHA-256 fact completion in existing enrichment. The strict gate prevents leakage to existing strategies. It does not authorize exact snapshot transport, a mandatory new helper, or a third disposition. No new ADR is needed; this design directly follows accepted repository ADRs and AGENTS.md authority.
