---
id: design-four-stage-sync-pipeline
kind: design
title: Four-stage sync pipeline responsibilities
status: active
created: '2026-09-03'
scope_type: area
responsibilities:
- id: RESP-001
  statement: Observation acquires and freezes local, remote, baseline, scope, and
    namespace facts without constructing actions.
- id: RESP-002
  statement: Admission alone constructs exact actions, resolves identity topology
    and conflict policy, and authorizes a plan.
- id: RESP-003
  statement: Execution performs only authorized effects and reports exact outcomes
    without rerouting.
- id: RESP-004
  statement: Commit and finalization persist only proven terminal outcomes and advance
    checkpoint state last.
invariants:
- id: INV-001
  statement: No executable action exists before Admission.
  enforcement: conformance
- id: INV-002
  statement: Every executed action belongs to the exact AuthorizedSyncPlan for the
    cycle.
  enforcement: contract
- id: INV-003
  statement: A cycle is clean only after every exact admitted obligation has successful
    terminal publication and the working view closes once. Sibling effects settle
    before commit or abort; incomplete attempts abort before classification or retry.
    Only clean completion acknowledges captured tracker generations.
  enforcement: test
- id: INV-004
  statement: Configured-scope projection removes excluded metadata and identity edges
    before BatchObservation. Every relation uses the same immutable cycle-local pure
    scope compatibility query; it performs no I/O and cannot bind identity or authorize
    actions.
  enforcement: test
- id: INV-005
  statement: Admission decisions depend only on current component facts and component-local
    terminal baseline; acquisition temperature, global store state, previous errors,
    and database version are not decision inputs.
  enforcement: test
- id: INV-006
  statement: Admission binds current component identity, endpoints and committed baseline
    before subordinate content comparison and constructs ordered actions once. Actions
    and intended effects never serve as identity or completeness evidence.
  enforcement: contract
- id: INV-007
  statement: Admission selects one authority family from current component facts and
    emits exactly one disposition. Coherent reports precede aliases; unresolved claims
    have no weaker-family fallback. A report is already satisfied only when its current
    endpoints and identity claims are positively accounted for.
  enforcement: contract
- id: INV-008
  statement: A selected folder-root claim governs only exact, complete, unique, suffix-preserving,
    included descendants proven by immutable call-local data that is discarded with
    the component decision.
  enforcement: test
- id: INV-009
  statement: Execution preserves component order through each action's terminal publication;
    failure blocks the suffix. Independent singleton transfers and same-key matches
    may pool, but all pool and active priority effects settle before the globally
    serial component interval, throughout which new priority effects are deferred.
  enforcement: test
- id: INV-010
  statement: Publication compares exact admitted source and destination records atomically;
    storage does not choose identity replacement policy. Parent publication consumes
    existing successful child receipts, not a second registry. Concurrent records
    and incompatible merge bases are protected by the same transaction.
  enforcement: test
- id: INV-011
  statement: 'Sync has exactly two durable authorities: successful per-file SyncRecords
    and the wholly clean-cycle remote cursor. Metadata cache and scope are derived
    final snapshots committed atomically with that cursor. Do not persist intent,
    evidence, failures or recovery instructions, or introduce another retained in-memory
    correctness owner.'
  enforcement: contract
boundaries:
  provides:
  - id: BOUNDARY-001
    statement: Fact-only BatchObservation input and exact AuthorizedSyncPlan output.
  consumes:
  - id: BOUNDARY-002
    statement: Committed baseline, current change-detection facts, identity evidence,
      observations, scope, and namespace.
  forbidden:
  - id: BOUNDARY-003
    statement: Observation importing or invoking action decision helpers.
  - id: BOUNDARY-004
    statement: Execution inventing, replacing, or rerouting actions.
  - id: BOUNDARY-005
    statement: Finalization inferring success from listing absence or partial completion.
  - id: BOUNDARY-006
    statement: BatchObservation carrying an excluded path, excluded-path disposition,
      or identity edge with an excluded endpoint.
  - id: BOUNDARY-007
    statement: Independent identity-policy stages, action-first normalization or repair
      APIs, action-bearing observations, and correctness proofs retained at module
      scope or across calls are forbidden.
  - id: BOUNDARY-008
    statement: Conflict resolution cannot mutate originals or select separate ordinary
      and rename execution routes. One capture and policy-required preservation contract
      precedes executor-owned effects, source revalidation, terminal proof and publication.
      Newly arriving destinations are precondition failures, never deletion authority;
      interrupted work is re-observed without compensating recovery state.
variability:
  fixed:
  - id: FIXED-001
    statement: The four top-level responsibility owners and their dependency direction.
  - id: FIXED-002
    statement: Admission ownership of identity topology, conflict, and destructive
      action selection.
  free:
  - id: FREE-001
    statement: Private helper layout inside a layer when dependency direction remains
      unchanged.
capabilities:
- id: cap:batch-observation
  uniqueness: per-boundary
- id: cap:action-admission
  uniqueness: per-boundary
- id: cap:effect-execution
  uniqueness: per-boundary
- id: cap:terminal-commit
  uniqueness: per-boundary
failure_responsibilities:
- id: FAILURE-001
  statement: Observation failures abort before authorization.
- id: FAILURE-002
  statement: Admission ambiguity fails closed with no executable destructive action.
- id: FAILURE-003
  statement: Execution failures remain exact per-action outcomes.
- id: FAILURE-004
  statement: Finalization withholds the checkpoint for nonterminal outcomes and writes
    no recovery instruction.
trust_boundaries:
- id: TRUST-001
  statement: Remote and local filesystem observations are untrusted facts until Admission
    binds them into an authorized plan.
compatibility_policies:
- id: COMPAT-001
  statement: Preserve provider calls, checkpoint schema, conflict policy, priority
    semantics, and user-visible sync outcomes.
tags: []
owners: []
relations:
- {type: references, target: adr-20260905-fact-first-component-admission}
source_paths:
- src/sync/sync-cycle-planning.ts
- src/sync/plan-admission.ts
- src/sync/plan-executor.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/identity-component-decision.ts
- src/sync/conflict-resolver.ts
summary: Current responsibility and dependency boundaries for the four-stage sync
  pipeline.
updated: '2026-09-04'
---

## Purpose

Keep the sync engine structurally convergent by assigning every normal-cycle decision to one of four owners. The split is a dependency rule, not a naming exercise: facts flow forward, and executable authority begins only at Admission.

## Responsibilities

The pipeline is `Observation -> Admission -> Execution -> Commit/finalization`.

- Observation owns acquisition, configured-scope projection and a cut-consistent immutable carrier.
- Admission binds current identity and topology before subordinate pure content comparison, and owns conflict policy and exact authorization.
- Execution owns ordering and I/O for the authorized actions only.
- Commit/finalization owns per-action state publication, completion proof, and checkpoint commit-last.

## Boundaries

`BatchObservation` contains facts, never `SyncPlan` or another action carrier. `AuthorizedSyncPlan` can be created only by Admission. Execution and finalization consume that exact object and cannot call decision helpers.

Observation records current endpoint, content, alias and identity facts, including
reported rename notifications; it cannot manufacture action intent. Admission binds
one connected component, resolves coherent reports before aliases, compares content
only after identity binding, and emits one disposition with ordered actions. An
unresolved claim has no weaker-family fallback. Neither a proposed effect nor an
unrelated destination baseline proves that a reported move is complete.

A complete parent mapping concerns exact current occurrences and their committed
baselines, not intended destinations. COLD/WARM/HOT are acquisition strategies only;
whole-store count, schema version and prior failures are not policy inputs. Execution
uses the fixed admitted protocol and never reinterprets a precondition mismatch as a
different action or permission to overwrite a newly arrived version.

Configured-scope filtering is the entrance to this boundary. Paths rejected by that
filter, observations that disclose them, and identity edges with an excluded endpoint
must be removed before `BatchObservation` is constructed. Admission and later stages
have no excluded-path disposition or excluded metadata inventory. Every report-,
alias-, endpoint- and baseline-derived relation uses the same captured pure scope
compatibility query. Its immutable private scope surface and settings answer inclusion
compatibility only; they perform no I/O and do not bind identity or authorize work.

## Invariants

Rename plus content change is ordinary evidence and converges to the new path and
content. Compare proven current equality before changes against the baseline. Conflicts
use existing policy over bound versions, including baseline-absent disagreement and
foreign destination versions that must be preserved. Structural ambiguity fails closed.

Successful file records and the wholly clean-cycle remote cursor are the only durable
authorities. Cache and scope are derived final snapshots published atomically with the
cursor. No evidence, failure, intent or recovery marker becomes persistent state, and
no additional retained in-memory correctness owner is introduced.

## Collaboration

The orchestrator sequences the four owners but owns none of their policy. Independent
singleton transfers and same-key matches may pool. Pool and active priority effects
settle before the globally serial component interval; new priority effects wait until
it ends. Each component action publishes before its successor, and failure blocks the
suffix. Parent publication consumes the existing successful child receipts. There is
no dependency graph, additional receipt registry or recovery queue.

All conflicts share capture and policy-required preservation before executor-owned
original-path effects. Sources are revalidated before destruction, required copies
and terminal endpoints are verified before publication, and exact record CAS protects
concurrent records. The resolver does not mutate originals or choose a separate
ordinary-conflict execution route. Stored bytes may be proven by authoritative
checksums; only affected endpoints lacking that proof require fallback reads.

## Failure Responsibility

Observation and Admission failures do not authorize effects. Execution reports exact
outcomes; already successful file publications remain durable when later work fails.
Finalization settles siblings and closes each attempt exactly once: commit only when
wholly clean, otherwise abort the live derived view before classification or retry,
without erasing the durable checkpoint. Only clean completion acknowledges captured
tracker generations. Interrupted work is re-observed under the same rules, including
partial merges; no compensating rollback or recovery instruction is required.

## Variability

Private names and helper placement may change. The four owners, action-authority boundary, exact-plan consumption, and commit-last rule may not.

## Conformance

AST guards close the identity-policy imports, fact-only carriers, retired API surface,
durable writers and retained orchestrator fields. Contract and public pipeline tests
pin component order, scope compatibility, exact publication, source/copy integrity,
attempt closeout and ordinary convergence after interruption. The repository gate
verifies lint, Dashboard reproduction, build and coverage; actual Obsidian acceptance
is separate from fake-backed test success.

## Related Decisions

- `adr-20260903-four-stage-sync-pipeline`
- `adr-20260831-admission-owns-identity-component-decisi`
- `adr-20260902-fresh-state-reconciliation-for-rename-edits`
- [Fact-first component Admission](../adr/adr-20260905-fact-first-component-admission.md) supersedes earlier action-first and flat-phase contracts.
