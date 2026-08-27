---
change: change-20260827-late-bound-sync-execution
role: implementation
contracts:
- contract-component-authority
- contract-current-observation
- contract-late-bound-decision
- contract-route-isolation
- contract-churn-progress
- contract-baseline-commit
- contract-no-action-freshness
- contract-component-finalization
- contract-checkpoint-replay
contract_projections:
- id: contract-component-authority
  verifications:
  - verify-component-authority
  discretion: []
- id: contract-current-observation
  verifications:
  - verify-detached-current-observation
  - verify-provider-identity-path-pair
  - verify-google-occupant-pagination
  discretion: []
- id: contract-late-bound-decision
  verifications:
  - verify-current-decision
  - verify-all-member-obligations
  discretion: []
- id: contract-route-isolation
  verifications:
  - verify-effect-scheduler-isolation
  - verify-priority-safe-point
  discretion:
  - discretion-private-route-isolation
- id: contract-churn-progress
  verifications:
  - verify-churn-quantum
  discretion: []
- id: contract-baseline-commit
  verifications:
  - verify-effect-shape-commit
  - verify-no-schema-growth
  discretion: []
- id: contract-no-action-freshness
  verifications:
  - verify-no-action-freshness
  discretion: []
- id: contract-component-finalization
  verifications:
  - verify-exact-component-finalization
  - verify-exact-member-finalization
  discretion: []
- id: contract-checkpoint-replay
  verifications:
  - verify-last-committed-replay
  - verify-incremental-replay
  - verify-cursor-expiry-partition
  discretion:
  - discretion-private-checkpoint-replay
adrs:
- adr-late-bound-component-execution
- adr-20260827-file-open-fast-pass-preserves-remote-change-batches
- adr-20260825-issue43-destructive-authorization
- adr-0001-metadata-cache-is-subordinate-to-commit-last
decision_dispositions:
- decision_input_ref: decision-input-execution-time-direction
  disposition: adopted; each member direction is selected from current Local, paired
    Remote identity/path-occupant evidence, and current SyncRecord only after component
    ownership.
  adr_refs:
  - adr-late-bound-component-execution
  contract_refs:
  - contract-component-authority
  - contract-late-bound-decision
- decision_input_ref: decision-input-dynamic-routing
  disposition: adopted as observable effect-by-scheduler-state forbidden overlaps
    that preserve existing ordering and concurrency; a private mechanism is delegated
    and later-is-stricter claims are rejected.
  adr_refs:
  - adr-late-bound-component-execution
  contract_refs:
  - contract-route-isolation
  - contract-churn-progress
- decision_input_ref: decision-input-no-version-ordering
  disposition: adopted; provider tokens are equality-only evidence.
  adr_refs:
  - adr-late-bound-component-execution
  contract_refs:
  - contract-current-observation
- decision_input_ref: decision-input-no-cold-restart
  disposition: adopted for ordinary incomplete work while the committed cursor is
    usable; provider rejection/expiry retains the existing typed COLD policy, ordinary
    drift/failure is not a COLD reason, and private CachingRemoteFs realization is
    delegated.
  adr_refs:
  - adr-late-bound-component-execution
  contract_refs:
  - contract-checkpoint-replay
- decision_input_ref: decision-input-cas-no-schema
  disposition: adopted as existing two-argument whole-record compareAndPut(expectedRecord,
    nextRecord) for single-record content only, with path carried by the records;
    structural effects retain current component-owned ordered writes plus commit-last
    replay, while new atomic/precommit, multi-path, and expected-absence APIs are
    rejected.
  adr_refs:
  - adr-late-bound-component-execution
  contract_refs:
  - contract-baseline-commit
- decision_input_ref: decision-input-tracker-authority
  disposition: adopted clarification; external generation producers remain independent
    while Air Sync validation, effects, and exact acknowledgement are ownership-bound.
  adr_refs:
  - adr-late-bound-component-execution
  contract_refs:
  - contract-baseline-commit
  - contract-no-action-freshness
- decision_input_ref: decision-input-strict-priority
  disposition: retained; PriorityCoordinator remains the safe-point owner.
  adr_refs:
  - adr-20260827-file-open-fast-pass-preserves-remote-change-batches
  contract_refs:
  - contract-route-isolation
  - contract-component-finalization
- decision_input_ref: decision-input-detached-observation
  disposition: retained and generalized into paired admitted-identity plus independent
    provider-grounded current path-occupant/absence evidence; it remains request-local
    and does not prove structural completeness.
  adr_refs:
  - adr-late-bound-component-execution
  - adr-20260827-file-open-fast-pass-preserves-remote-change-batches
  contract_refs:
  - contract-current-observation
- decision_input_ref: decision-input-admission-authority
  disposition: retained with direction-free stable component/member-obligation IDs,
    exact member sets, and latest in-memory authorization epochs.
  adr_refs:
  - adr-late-bound-component-execution
  - adr-20260825-issue43-destructive-authorization
  contract_refs:
  - contract-component-authority
- decision_input_ref: decision-input-commit-last
  disposition: retained for cache/cursor atomic commit-last, crash replay, and clean
    component/member finalization; proposed ADR supersedes only ADR 0001 Decision
    2's mandatory same-session recoverViaColdScan after ordinary incomplete work with
    a usable cursor, while cursor expiry/reset/scope-widening COLD remains.
  adr_refs:
  - adr-0001-metadata-cache-is-subordinate-to-commit-last
  contract_refs:
  - contract-component-finalization
  - contract-checkpoint-replay
- decision_input_ref: issue-phase-order-is-not-isolation-order
  disposition: resolved by observable effect-by-scheduler-state forbidden overlaps,
    preservation of existing ordering/concurrency, and an escalation-bounded private
    mechanism.
  contract_refs:
  - contract-route-isolation
- decision_input_ref: issue-structural-topology-authority-gap
  disposition: resolved by same stable ID, revocable in-memory epoch, full-union acquisition,
    and final owned re-observation.
  contract_refs:
  - contract-component-authority
  - contract-current-observation
- decision_input_ref: issue-current-observation-does-not-prove-component-completeness
  disposition: resolved by freezing structural completeness at authoritative batch
    or delta evidence and rejecting point-read expansion.
  contract_refs:
  - contract-current-observation
- decision_input_ref: issue-checkpoint-replay-closure-missing
  disposition: resolved for a usable committed cursor by observable target-plus-sibling
    replay under CachingRemoteFs ownership, with private reversible mechanics and
    escalation for shared API, persistence, or provider calls.
  contract_refs:
  - contract-checkpoint-replay
- decision_input_ref: issue-cas-coverage-diverges-by-effect-shape
  disposition: resolved by existing two-argument whole-record compareAndPut(expectedRecord,
    nextRecord), whose records carry the path, for single-record content only and
    current component-owned ordered structural writes with no-success/commit-last/replay
    failure behavior; draft-2 multi-path expected-absence transaction is rejected.
  contract_refs:
  - contract-baseline-commit
- decision_input_ref: issue-bounded-churn-changes-mandatory-outcome
  disposition: resolved by bounded nonterminal scheduling quanta and no current_state_churn
    terminal failure.
  contract_refs:
  - contract-churn-progress
- decision_input_ref: issue-finalization-identity-after-readmission
  disposition: resolved by exact component/member-obligation membership plus latest
    in-memory epoch validation.
  contract_refs:
  - contract-component-authority
  - contract-component-finalization
- decision_input_ref: issue-no-action-receipt-can-mask-uncommitted-observation
  disposition: resolved by paired identity/path-occupant freshness witnesses, Local
    and record revalidation, and remote-after-cut incremental preservation.
  contract_refs:
  - contract-no-action-freshness
  - contract-checkpoint-replay
- decision_input_ref: issue-private-discretion-is-not-typed
  disposition: resolved by typed private discretion on contract-route-isolation and
    contract-checkpoint-replay with exact unit, file/component scope, preservation
    constraints, verification refs, and escalation triggers.
  contract_refs:
  - contract-route-isolation
  - contract-checkpoint-replay
- decision_input_ref: issue-structural-precommit-authority-is-ungrounded
  disposition: resolved by withdrawing atomic transaction/precommit claims and specifying
    current component-owned ordered writes, no successful receipt/checkpoint on failure,
    and incremental replay convergence without new API or schema.
  contract_refs:
  - contract-baseline-commit
  - contract-checkpoint-replay
- decision_input_ref: issue-current-absence-authority-unproved
  disposition: resolved by pairing admitted-identity observation with independent
    provider-grounded path-occupant/authoritative-absence observation; identity missing
    alone is not absence and replacement/structural/unverifiable pairs emit no I/O
    or no-action completion.
  contract_refs:
  - contract-current-observation
  - contract-no-action-freshness
- decision_input_ref: issue-component-receipt-does-not-prove-all-effects
  disposition: resolved by stable direction-free member-obligation IDs, per-member
    late-bound terminal completion, one exact latest-epoch component receipt, and
    all-component/all-member equality at finalization; partial member success followed
    by failure emits no component receipt/checkpoint.
  contract_refs:
  - contract-component-authority
  - contract-late-bound-decision
  - contract-component-finalization
- decision_input_ref: issue-replay-cold-scope-conflict
  disposition: resolved by limiting no-COLD target-plus-sibling replay to a usable
    last committed cursor, retaining the existing typed provider cursor rejection/expiry
    COLD policy, and forbidding ordinary drift/failure from selecting COLD.
  contract_refs:
  - contract-checkpoint-replay
- decision_input_ref: issue-google-path-occupant-is-not-authoritative
  disposition: resolved by forbidding findChildByName(pageSize=1) as absence authority,
    paginating all Google Drive same-parent/name candidates into the 0/1/>1 absence/current/conflicting
    partition, and requiring the same request-local partition for Dropbox/OneDrive.
  contract_refs:
  - contract-current-observation
- decision_input_ref: issue-accepted-adr0001-recovery-conflict
  disposition: resolved by the proposed ADR's explicit narrow supersession of accepted
    ADR 0001 Decision 2's mandatory same-session recoverViaColdScan rule for ordinary
    usable-cursor incomplete cycles; all other commit-last and cursor-expiry/reset/scope-widening
    COLD rules remain, and ADR rejection marks the no-COLD requirement/contracts rework_required.
  adr_refs:
  - adr-late-bound-component-execution
  - adr-0001-metadata-cache-is-subordinate-to-commit-last
  contract_refs:
  - contract-checkpoint-replay
- decision_input_ref: issue-cas-invocation-contradicts-existing-api
  disposition: resolved by specifying the existing two-argument compareAndPut(expectedRecord,
    nextRecord) invocation exactly; path is derived from the records and no third
    argument or new API is allowed.
  contract_refs:
  - contract-baseline-commit
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

## Goal

Change the executor authority from preselected directional actions to direction-free
authorized component/member obligations, while preserving Admission, strict priority,
lane isolation, effect commit safety, and commit-last checkpoint replay.

## Implementation sequence

### 1. Direction-free carrier and Admission

Change `sync-cycle-planning.ts`, `types.ts`, `plan-admission.ts`, and
`plan-admission-graph.ts` plus focused tests. Preserve the existing complete
identity/scope graph and effect envelope. Mint one stable cycle-local component ID, exact
stable direction-free member-obligation IDs, and a revocable in-memory authorization
epoch; do not persist them. Same-cycle authoritative expansion retains the component ID,
reissues the exact member set at the new epoch, and requires full-union ownership.

### 2. Endpoint observation and checkpoint replay owner

Generalize the existing detached priority capability for already-admitted normal
endpoints in `interface.ts`, `priority-observation.ts`, `caching/remote-fs.ts`, and all
three provider adapters. Return a request-local pair: admitted-identity observation plus
independent current path-occupant/authoritative-absence observation. Identity missing is
not path absence. In `googledrive/client.ts`, do not reuse
`findChildByName(pageSize=1)` as authority; paginate all same-parent/name candidates at
each root-relative step and classify 0/1/>1 as absence/current/conflicting. Dropbox and
OneDrive expose the same absence/current/conflicting/unverifiable partition through their
existing path-metadata seams. Replacement/structural/conflicting/unverifiable results emit
no I/O/no-action. Keep the pair delta/cache/checkpoint neutral.

Within existing `CachingRemoteFs` ownership, choose a private reversible mechanism so
that ordinary incomplete work with a usable committed cursor replays target plus sibling
from that checkpoint. Provider cursor rejection/expiry follows the existing typed COLD
policy; ordinary drift/failure alone does not. The mechanism and representation are
implementation discretion. Do not add a shared checkpoint/reload API, persisted state,
schema/migration, or recovery-only provider call; escalate to design if one is necessary.

### 3. Late-bound executor and isolation outcomes

Build current evidence only after full component ownership and call the existing decision
policy separately for every exact admitted member obligation. Complete every member as
`applied` or `no_action`, or leave the component failed/nonterminal with no successful
component receipt. For every effect×scheduler-state interleaving, prevent overlaps forbidden
by the existing transfer-before-conflict-before-structural barriers. Retain conflict
sibling isolation, remote/local structural and rename ordering, full path ownership, and
disjoint-path concurrency. The private scheduling/locking mechanism is implementation
discretion; a new shared guard/scheduler boundary requires design escalation.

Bound one scheduling quantum's provider calls/backoff. Budget exhaustion returns the same
nonterminal in-memory component and emits no receipt. Continuous churn is observable and
checkpoint-blocking; quiescent work completes. Do not add `current_state_churn`.

### 4. Effect-shape commit and receipts

Use existing two-argument whole-record `compareAndPut(expectedRecord, nextRecord)` only
for single-record content baseline replacement. The path is contained in those records;
do not add or pass a third path argument. Keep rename/delete/multi-record effects under current component ownership
and use the current ordered state writes; do not assume or add atomic transaction or
precommit validation. If a structural effect/write fails after an earlier write, issue no
successful receipt, withhold checkpoint commit, and let incremental replay converge from
current state. Create latest-epoch `applied` and freshness-bound `no_action` receipts only
after their respective success/revalidation boundaries. These are member completions;
emit one component receipt only after the latest epoch's exact admitted member-ID set is
fully terminal.

### 5. Priority and finalization

Keep `PriorityCoordinator` as the safe-point owner. Replace exact directional action-
object membership with exact component/member-obligation membership and latest-epoch
component receipt equality. If some members effect state before another fails, emit no
component receipt/checkpoint and converge through replay. Remove priority
version receipts, provider version ordering, `deferred_stale_plan`, and stale-driven
`recoverViaColdScan`. On every incomplete cycle, wait for provider operations to
quiesce and, while the committed cursor remains usable, establish target-plus-sibling
replay from that checkpoint; failure is typed and non-clean. Provider cursor rejection/
expiry follows the existing typed COLD branch and ordinary failure does not.

This replaces only ADR 0001 Decision 2's mandatory same-session
`recoverViaColdScan` after ordinary incomplete work. Preserve ADR 0001's atomic cache/
cursor commit-last rule, crash recovery, and COLD behavior for cursor rejection/expiry,
reset/disconnect, rescan, scope widening, and missing checkpoints.

### 6. Documentation and gate

Update `ARCHITECTURE.md`, `docs/sync-pipeline.md`, the governing ADR, and enforcement docs
only if a structural lint guard changes. Run focused tests and the full gate.

## Targets and seams

| Owner | Primary files | Required seam |
|---|---|---|
| Component Admission | `src/sync/plan-admission*.ts`, `sync-cycle-planning.ts`, `types.ts` | Direction-free complete component/member IDs + latest epoch. |
| Current observation/replay | `src/fs/interface.ts`, `priority-observation.ts`, `caching/remote-fs.ts`, provider adapters | Request-local identity+path-occupant pair; private usable-cursor replay. |
| Runtime decision/routing | `decision-engine.ts`, `plan-executor.ts`, mutation/priority coordinators | Per-member current evidence; forbidden-overlap outcomes; bounded yield. |
| Baseline/receipt | `state.ts`, `state-committer.ts`, `local-tracker.ts`, `execution-result.ts` | Single-record content CAS; component-owned ordered structural writes; freshness witnesses. |
| Finalization | `sync-cycle-finalization.ts`, `orchestrator.ts` | Exact latest-epoch component/member completion; replay readiness after quiescence. |

## Design closure

The architecture content is closed, while the governing ADR remains proposed for user
consultation. Implementation may choose private helper names, scheduling/locking, replay
procedure, and local representations only if every contract, observable, failure outcome,
and verification above is preserved. Any need for a shared API, persisted state, provider
recovery call, or different concurrency boundary escalates back to design.

Typed delegation is limited to two choices:

- `unit-late-bound-executor` may choose private scheduling/locking only in
  `plan-executor.ts`, `local-mutation-barrier.ts`, and `priority-coordinator.ts` within
  `component-dynamic-executor`. Escalate for any shared scheduler/lane/guard/result API,
  persisted state, provider call, or change to forbidden-overlap semantics, strict
  priority, phase/conflict/rename ordering, starvation, or disjoint-path concurrency.
- `unit-current-observation` may choose private reversible cache/cursor representation
  and replay procedure only in `caching/remote-fs.ts` within
  `component-current-observation`. Escalate for any shared filesystem/checkpoint/cache/
  cursor/orchestration API, persisted field/schema/migration, recovery-only provider call,
  or change to usable-cursor target-plus-sibling replay, cursor-expiry classification,
  no-list/no-COLD, quiescence ordering, or clean-finalization semantics.
