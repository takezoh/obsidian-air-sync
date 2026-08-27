# Late-bound sync execution

## Decision and scope

<!-- anchor: adr-late-bound-component-execution -->
Air Sync schedules and admits cycle-local, evidence-connected work components whose
member obligations have IDs but no direction. Each authorized member chooses `push`,
`pull`, `match`, `conflict`, delete, or rename only after the component owns its
authorized path set and observes current Local, detached current Remote identity plus
independent current path occupant/absence, and current `SyncRecord`. File-open retains strict priority over every normal
component not started; already-started indivisible work may finish. Later normal work
does not compare provider versions with the fast pass: it observes current Local,
identity/path Remote evidence, and `SyncRecord`, then normally becomes no-action or
performs the current merge.

This supersedes frozen-action supersession, provider version ordering,
`deferred_stale_plan`, and drift-triggered COLD recovery. It does not add a durable queue,
receipt, epoch, token, checkpoint field, `SyncRecord` field, settings field, database
version, migration, provider-specific sync engine, or provider enumeration capability.
Existing explicit rescan, scope-widening, backend-reset, and cursor-expiry COLD policies
remain separate.

## User-facing and observable requirements

<!-- anchor: fr-late-01 -->
### FR-LATE-01 — no frozen directional effect

The system shall execute no directional filesystem effect solely because that direction
was selected before execution ownership. After ownership it shall decide each authorized
member obligation only from current Local, the paired detached Remote identity and path-
occupant observations, and current `SyncRecord`.

<!-- anchor: fr-late-02 -->
### FR-LATE-02 — strict file-open priority

When file-open priority is pending, the system shall start it before every normal
component not already started, allow already-started indivisible work to finish, and
coalesce duplicate opened paths.

<!-- anchor: fr-late-03 -->
### FR-LATE-03 — current-state convergence without stale recovery

When current evidence changes before I/O, the system shall discard that attempt and
re-observe the same component without `deferred_stale_plan`, provider version ordering,
a priority supersession receipt, or a stale-driven COLD cycle.

<!-- anchor: fr-late-04 -->
### FR-LATE-04 — effect×scheduler-state isolation

When execution-time direction differs from the component's provisional phase, the system
shall preserve every existing transfer/conflict/structural ordering guarantee and shall
prevent the forbidden overlaps specified below. It shall not assume that a later phase
is stricter or require one particular locking or scheduling mechanism.

<!-- anchor: fr-late-05 -->
### FR-LATE-05 — structural authority is bounded by frozen batch evidence

The system shall perform structural I/O only inside the complete endpoint/identity
component established by the cycle's frozen batch/delta evidence. Point observations
shall not be interpreted as proof of connected-component completeness.

<!-- anchor: fr-late-06 -->
### FR-LATE-06 — schema-neutral baseline protection

After a single-record content effect succeeds, the system shall replace its baseline only
with existing two-argument whole-record
`SyncStateStore.compareAndPut(expectedRecord, nextRecord)`. The path is carried by those
records and is not a separate argument. Rename, delete, and multi-record
effects shall remain under current component ownership and use the current ordered state
writes; no atomic transaction or precommit guarantee is assumed. A partial failure emits
no successful receipt and cannot commit the checkpoint, so incremental replay converges
from current state. No persisted coordination field or new state-store primitive is
allowed.

<!-- anchor: fr-late-07 -->
### FR-LATE-07 — bounded scheduling quantum

Each scheduling quantum shall bound provider calls and retry/backoff work. Budget
exhaustion shall yield the same nonterminal component in the same cycle, without a
receipt or a new terminal churn failure. Quiescing state shall converge; continuous
churn shall be rate-limited and observable and shall block checkpoint commit.

<!-- anchor: fr-late-08 -->
### FR-LATE-08 — freshness-bound no-action

A `no_action` receipt shall be accepted only when bound to the observed local tracker
generation, expected whole `SyncRecord`, admitted-identity result, independent current
path-occupant token or authoritative path-absence witness, frozen delta generation,
component/member obligation IDs, and latest in-memory authorization epoch. Identity
missing alone is not path absence. Local and `SyncRecord` shall be revalidated under
ownership immediately before acceptance.

<!-- anchor: fr-late-09 -->
### FR-LATE-09 — exact component finalization

Checkpoint commit shall require exact equality with every originally authorized stable
component ID and that component's exact admitted direction-free member-obligation ID set.
Every member shall be terminal `applied` or `no_action` at the component's latest in-memory
authorization epoch. Directional action-object identity is not used or persisted.

<!-- anchor: fr-late-10 -->
### FR-LATE-10 — incremental replay after incomplete cycles

If any component remains failed, blocked, churning, or receipt-incomplete and the last
committed cursor remains usable, the system shall leave that checkpoint unchanged and the
next incremental work shall replay target and sibling delta evidence without `list()` or
COLD. If the provider rejects or expires that committed cursor, the existing typed cursor-
expiry COLD policy takes precedence. Ordinary drift or failure is never itself a COLD
reason.

## Internal implementation contracts

<!-- anchor: component-work-admission -->
<!-- anchor: contract-component-authority -->
### 1. Direction-free Admission and authorization epoch

`sync-cycle-planning.ts` builds stable cycle-local components from the same frozen
observations, identity edges, namespace, scope, and endpoint graph currently consumed by
Admission. `plan-admission.ts` remains the only destructive authority and emits a closed
effect envelope, normalized complete path set, stable `componentId`, and in-memory
monotonic `authorizationEpoch`. It also preserves the exact admitted set of stable,
direction-free `memberObligationId`s derived from the component's existing members; it
does not emit a direction. Re-Admission atomically revokes the old epoch before issuing
the next epoch for the same ID and its complete member-obligation set. None is persisted.

The originally admitted component/member obligation membership never changes except that
authoritative same-cycle expansion reissues the complete set at the new epoch. A terminal
component receipt for an obsolete epoch, unknown/duplicate component or member ID, missing
member, or incomplete member set cannot finalize. This replaces exact directional action-
object membership without weakening logical-identity Admission.

<!-- anchor: component-current-observation -->
<!-- anchor: contract-current-observation -->
### 2. Detached current observation is endpoint-local evidence

The shared observation seam pairs two independent request-local observations: the
already-admitted identity and the current occupant (or authoritative absence) at its
authorized path. It may perform an opaque token-bound content read, but it does not
consume delta or mutate shared cache, cursor, root anchor, or checkpoint. Identity
`missing` proves only that identity is missing; it never proves the path is empty.
Provider tokens are equality witnesses, never ordering values.

Google Drive resolves each root-relative name/parent step using the existing Drive query
capability but does not use the single-result `findChildByName(pageSize=1)` shortcut as
absence authority. It paginates every candidate for the same parent/name: zero is
authoritative absence, one is the current occupant, and more than one is conflicting.
Dropbox and OneDrive expose the same `absence | current | conflicting | unverifiable`
partition through their existing provider path-metadata seams (not-found is absence, one
resolved occupant is current, ambiguous/conflicting metadata is conflicting, and an
indeterminate provider result is unverifiable). Each provider contract must prove this
identity+path pair, same-path replacement identity, complete Google Drive pagination, and
request-local no-global-mutation behavior. Replacement/structural, conflicting, or
unverifiable results permit neither I/O nor `no_action` completion.

The capability does not prove that no other connected endpoint exists. Structural
authority comes from the frozen batch/delta graph. If a point read reveals an identity or
path outside that component, or makes completeness unverifiable, the executor performs
no structural I/O, emits no successful receipt, leaves the checkpoint uncommitted, rolls
back live incremental state, and replays from the unchanged committed checkpoint.

Same-cycle structural re-Admission is allowed only if authoritative batch/delta evidence
already captured in this cycle supplies the complete expanded endpoint set. Admission
keeps the same stable ID, increments its in-memory epoch, acquires the full normalized
union before re-observing every endpoint, and permits I/O only if that final observation
remains within the authorized union. Another expansion revokes the epoch and repeats;
point reads never invent the union and no provider enumeration is added.

<!-- anchor: component-runtime-decision -->
<!-- anchor: contract-late-bound-decision -->
### 3. Decision and effect×scheduler-state isolation

`decision-engine.ts` remains the policy source. After component ownership, the executor
constructs current evidence and selects one effect inside the Admission envelope for each
authorized member obligation. Every member becomes terminal `applied` or `no_action`, or
the component remains failed/nonterminal. It revalidates current evidence under the
isolation required for each effect before I/O.

<!-- anchor: contract-route-isolation -->
| Scheduler state when the current effect is selected | Current effect | Observable forbidden overlap |
|---|---|---|
| transfer | transfer | No overlap on an owned path; existing disjoint-path transfer concurrency remains available. |
| transfer | conflict | No overlap with unfinished transfer work; conflict siblings remain isolated. |
| transfer or conflict | structural | No overlap with unfinished earlier-phase work; structural remote/local ordering, rename ordering, and full-component path ownership remain intact. |
| conflict | transfer | No overlap with active conflict or structural work, and no bypass of transfer-before-conflict-before-structural ordering. |
| structural | conflict | No overlap with active structural or transfer work; conflict siblings remain isolated. |
| structural | transfer | No overlap with active conflict or structural work, and no bypass of existing phase ordering. |
| any | no-action | No filesystem I/O; freshness validation and component ownership remain mandatory. |

Private scheduling or locking inside the existing executor/coordinator ownership is
implementation discretion. Every choice must preserve the forbidden-overlap table,
existing transfer/conflict/structural barriers, conflict sibling isolation, rename
ordering, and disjoint-path concurrency. Adding a shared guard API, changing a shared
scheduler boundary, or changing those observable concurrency outcomes requires design
escalation.

<!-- anchor: component-dynamic-executor -->
<!-- anchor: contract-churn-progress -->
### 4. Churn and yielding

Each component attempt has a fixed scheduling-quantum provider-call/backoff budget.
Exhaustion returns the still-authorized component to the executor's nonterminal in-memory
work set with the same stable ID and current epoch; it emits no terminal result and
cannot finalize. The coordinator yields to other runnable work and schedules a later
quantum with rate-limited diagnostics. There is no `current_state_churn` terminal result.

With no further external changes, epoch and route invalidations cease, lane acquisition
eventually stabilizes, and the component reaches I/O or no-action after finitely many
resumes. Continuous churn consumes bounded calls per quantum, remains observable, and
keeps checkpoint commit blocked rather than spinning or becoming success/failure.

<!-- anchor: component-baseline-commit -->
<!-- anchor: contract-baseline-commit -->
### 5. Effect-shape commit matrix

| Effect shape | Existing owner and operation | Mismatch/failure behavior |
|---|---|---|
| Single-record content baseline replacement | Existing `SyncStateStore.compareAndPut(expectedRecord, nextRecord)`; the path is inside the records, not a third argument | Preserve current record and tracker generation, emit no success, and re-observe or fail the component according to the existing typed commit failure. |
| Rename/delete/multi-record structural change | Current component ownership plus the existing ordered state writes | A write/effect failure emits no successful receipt and withholds checkpoint commit. Earlier writes may remain; next incremental replay joins them with current Local/Remote/SyncRecord state and converges. No atomic rollback or precommit validation is claimed. |

There is no expected-absence primitive, multi-path CAS API, new `SyncRecord` field,
receipt/token/epoch store, `DB_VERSION` change, or migration. External tracker events may
bump generations outside the Air Sync mutation lease; Air Sync validation, effect,
post-observation, and generation-specific acknowledgement remain under component
ownership so a later external event is not cleared.

<!-- anchor: component-cycle-finalization -->
<!-- anchor: contract-no-action-freshness -->
### 6. Fresh terminal receipts

Each member completion records its `memberObligationId` and terminal `applied` or
`no_action` result only after its success boundary. `applied` follows I/O, effect-shape
state handling, post-write observation, and exact tracker acknowledgement. `no_action`
also carries in-memory witnesses for local tracker generation, expected whole
`SyncRecord`, admitted-identity result, independent path-occupant token/authoritative path
absence, and frozen delta generation. Immediately before folding it, the executor
rechecks Local and `SyncRecord` under component ownership; a mismatch discards the member
completion and reroutes it.

Detached observation does not move the frozen global delta cut. A remote mutation after
that cut is therefore outside the checkpoint being committed and remains visible to the
provider's next incremental delta. Provider contracts must prove the target/sibling
case: accepting no-action for the frozen generation cannot consume or hide an after-cut
remote change.

<!-- anchor: contract-component-finalization -->
Only after every admitted member obligation is terminal does the executor emit one
component receipt containing the stable component ID, latest Admission epoch, exact
admitted member-ID set, and one `applied` or `no_action` completion per member. Finalization
requires exact equality for every admitted component and every member. Missing, failed,
blocked, churning, duplicate, unknown, stale-epoch, member-incomplete, or freshness-invalid
evidence withholds the component success receipt and checkpoint commit. If some members
already effected state before another fails, no component success receipt is emitted;
current-state incremental replay converges those effects. Failure is never logged as
fulfilled success.

<!-- anchor: contract-checkpoint-replay -->
### 7. Incremental replay after incomplete cycles

Current `CachingRemoteFs.getChangedPaths()` may advance live in-memory incremental state
before `commitCheckpoint()` persists a clean checkpoint. Therefore withholding commit
alone is not sufficient evidence that a later call will replay from the committed cut.

While the last committed cursor remains usable, `CachingRemoteFs` owns a private,
reversible way to make the next incremental work start from that checkpoint and re-emit
both the target and its sibling without `list()`, COLD, or an extra provider call solely
for recovery. Successful filesystem effects and `SyncRecord`s are not rolled back; replay
joins them with current Local/Remote state and converges to no-action or the current
merge. A failure to establish that replay state is typed and cannot be treated as clean.
If the provider rejects or expires the committed cursor, the existing typed cursor-expiry
COLD branch takes precedence. Incomplete work or ordinary state drift alone never enters
that branch.

The implementation may choose its private cache/cursor representation and restoration
procedure within `CachingRemoteFs`. It must not add an `IncrementalCheckpoint` operation
or other shared API, persisted coordination state, schema/migration, or provider recovery
call. If one of those boundaries becomes necessary, implementation must escalate back
to design rather than silently expanding scope.

## Dependency-ordered task-grade units

### Unit 1 — Direction-free carrier and Admission

- Objective: replace action authority with stable component/epoch authority while retaining the complete evidence graph.
- Files: `src/sync/types.ts`, `src/sync/sync-cycle-planning.ts`, `src/sync/plan-admission.ts`, `src/sync/plan-admission-graph.ts` and their tests.
- Acceptance: carrier has no direction; every component preserves exact stable member-obligation IDs; effect envelope and complete path set fail closed; same-cycle authoritative expansion retains component ID and increments epoch.
- Depends on: none.
- Boundary: no provider, executor, or persisted schema changes.

### Unit 2 — Shared endpoint observation and private replay owner

- Objective: generalize detached endpoint observation into admitted-identity plus independent current path-occupant evidence and preserve committed-checkpoint replay within existing `CachingRemoteFs` ownership.
- Files: `src/fs/interface.ts`, `src/fs/priority-observation.ts`, `src/fs/caching/remote-fs.ts`, `src/fs/googledrive/client.ts`, `src/fs/googledrive/client.test.ts`, three provider adapters, and shared/provider targeted-observation contract tests.
- Acceptance: Google Drive paginates all same-parent/name candidates and classifies 0/1/>1 as absence/current/conflicting; Dropbox/OneDrive satisfy the same output partition; every provider pair is request-local, identity missing alone is not absence, and replacement/structural/conflicting/unverifiable results emit no I/O/success; usable-cursor incomplete work replays target+sibling without list/COLD or a recovery-only provider call.
- Depends on: Unit 1.
- Boundary: no provider enumeration, persisted checkpoint field, migration, or backend-specific engine path.

### Unit 3 — Late-bound decision, structural authority, and isolation outcomes

- Objective: decide current effects under full ownership and enforce observable effect×scheduler-state isolation with bounded nonterminal yielding.
- Files: `src/sync/decision-engine.ts`, a private execution-decision module if needed, `src/sync/plan-executor.ts`, `src/sync/local-mutation-barrier.ts`, `src/sync/priority-coordinator.ts` and tests.
- Acceptance: no frozen direction reaches I/O; every authorized member obligation is late-decided and completed or leaves the component failed/nonterminal; structural expansion uses only complete frozen evidence; every forbidden overlap is absent while required disjoint-path concurrency remains; quiescence converges and continuous churn is bounded/nonterminal.
- Depends on: Units 1 and 2.
- Boundary: no durable queue/retry state and no terminal churn error.

### Unit 4 — Effect-shape commit and freshness-bound receipts

- Objective: apply the grounded CAS/structural matrix and issue only latest-epoch fresh receipts.
- Files: `src/sync/state.ts`, `src/sync/state-committer.ts`, `src/sync/local-tracker.ts`, `src/sync/execution-result.ts`, `src/sync/plan-executor.ts` and tests.
- Acceptance: only single-record content replacement uses existing two-argument `compareAndPut(expectedRecord, nextRecord)` with path carried in the records; structural effects use current component-owned ordered writes, and a partial failure emits no success/checkpoint commit and converges by replay; no-action invalidates on Local/record change and is bound to remote/delta witnesses.
- Depends on: Unit 3.
- Boundary: no expected-absence/multi-path CAS, schema, DB version, or migration.

### Unit 5 — Priority integration and clean finalization

- Objective: fold one latest-epoch component receipt only after exact completion of all admitted member obligations and preserve last-committed incremental replay for ordinary incomplete cycles.
- Files: `src/sync/sync-cycle-finalization.ts`, `src/sync/orchestrator.ts`, `src/sync/priority-coordinator.ts`, `src/fs/caching/remote-fs.ts` and tests.
- Acceptance: strict priority remains; exact component/member equality gates success; partial member success followed by failure emits no component receipt/checkpoint; ordinary incomplete work replays target+sibling while usable-cursor expiry retains the existing typed COLD branch.
- Depends on: Units 2 and 4.
- Boundary: existing unrelated COLD policies remain.

### Unit 6 — Persistent documentation and repository gate

- Objective: update architecture/pipeline/enforcement references and prove the complete repository gate.
- Files: `ARCHITECTURE.md`, `docs/sync-pipeline.md`, governing ADR, change package, and `docs/code-enforcement.md` only if an enforcement rule changes.
- Acceptance: docs describe late-bound execution and replay accurately; focused tests and full gate are green.
- Depends on: Unit 5.
- Boundary: do not rewrite closed predecessor history except to mark supersession by reference.

## Verification

- **AC-LATE-01 (T1):** fast pass completes before all unstarted normal components; later same-path normal observes admitted identity plus independent current path occupant/absence and becomes no-action/current merge without stale disposition; same-path replacement and identity-missing/path-occupied cases fail closed.
- **AC-LATE-02 (T0/T1):** transfer→conflict, conflict→transfer, structural→conflict, and structural→transfer interleavings exhibit no forbidden overlap or duplicate receipt, preserve conflict/rename ordering, and retain disjoint-path concurrency.
- **AC-LATE-03 (T1):** point evidence outside the frozen component causes no structural I/O/success receipt and incremental replay; complete same-cycle delta expansion re-admits the same ID at a new epoch and locks the full union.
- **AC-LATE-04 (T0/T1):** content CAS mismatch preserves the record/tracker; a structural ordered-write failure emits no success or checkpoint commit and incremental replay converges despite any earlier write remaining; schema and `DB_VERSION` are unchanged.
- **AC-LATE-05 (T0/T1):** quantum exhaustion yields nonterminal work, quiescing churn completes, and continuous churn bounds calls, emits diagnostics, and blocks checkpoint.
- **AC-LATE-06 (T1):** local/record changes or unverifiable identity/path pairs invalidate no-action; a remote-after-cut change plus sibling remains in the next delta after a clean no-action checkpoint.
- **AC-LATE-07 (T1):** with a usable cursor, after one component commits and another remains incomplete, next incremental work starts from the last committed checkpoint and replays target+sibling without `list()`/COLD or a recovery-only provider call; provider rejection/expiry takes the existing typed COLD branch, while ordinary failure never does.
- **AC-LATE-08 (T0/T1):** finalization rejects component/member missing, duplicate, unknown, failed, obsolete-epoch, and freshness-invalid evidence; a multi-member partial success followed by failure emits no component receipt/checkpoint, while exact all-member terminal equality accepts one latest-epoch component success.

Focused commands:

```bash
npm test -- src/sync/plan-admission.test.ts src/sync/plan-executor.test.ts src/sync/priority-coordinator.test.ts src/sync/sync-cycle-finalization.test.ts
npm test -- src/sync/orchestrator.test.ts src/sync/state.test.ts src/sync/local-tracker.test.ts
npm test -- src/fs/caching/remote-fs.contract.test.ts src/fs/googledrive/targeted-observation.test.ts src/fs/dropbox/targeted-observation.test.ts src/fs/onedrive/targeted-observation.test.ts
```

Required full gate:

```bash
npm run lint
npm run lint:bot-repro
npm run build
npm test
```

Optional credentialed provider E2E is supplemental fidelity evidence and not a gate.

## Resolved critique issues

1. `issue-phase-order-is-not-isolation-order`: resolved by observable effect×scheduler-state forbidden overlaps while leaving the private mechanism open; no later-phase strictness claim remains.
2. `issue-structural-topology-authority-gap`: resolved by stable ID + revocable in-memory epoch + full-union acquisition before re-observation.
3. `issue-current-observation-does-not-prove-component-completeness`: resolved by limiting authority to frozen authoritative batch/delta evidence and replaying when point evidence escapes it; no provider enumeration is invented.
4. `issue-checkpoint-replay-closure-missing`: resolved for a usable committed cursor by requiring next incremental work to replay target+sibling, with private reversible realization owned by `CachingRemoteFs`.
5. `issue-cas-coverage-diverges-by-effect-shape`: resolved by the existing-operation effect-shape matrix; the multi-path CAS proposal is rejected.
6. `issue-bounded-churn-changes-mandatory-outcome`: resolved by bounded nonterminal scheduling quanta, not a terminal churn failure.
7. `issue-finalization-identity-after-readmission`: resolved by stable component/member-obligation membership plus latest in-memory epoch validation.
8. `issue-no-action-receipt-can-mask-uncommitted-observation`: resolved by identity+path-occupant freshness witnesses, Local/record revalidation, and remote-after-cut delta preservation.
9. `issue-private-discretion-is-not-typed`: resolved by typed route-isolation and checkpoint-replay discretion entries with private file/component scope and explicit escalation triggers.
10. `issue-structural-precommit-authority-is-ungrounded`: resolved by limiting structural state behavior to current component-owned ordered writes plus no-success/commit-last/replay convergence, without claiming atomic transaction or precommit authority.
11. `issue-current-absence-authority-unproved`: resolved by pairing admitted-identity observation with independent provider-grounded current path-occupant/absence observation; identity missing alone is never absence.
12. `issue-component-receipt-does-not-prove-all-effects`: resolved by exact direction-free member-obligation IDs, all-member terminal completion evidence, and component/member equality at finalization.
13. `issue-replay-cold-scope-conflict`: resolved by limiting no-COLD replay to a usable committed cursor and retaining the existing typed cursor-expiry/rejection COLD branch only for that provider outcome.
14. `issue-google-path-occupant-is-not-authoritative`: resolved by complete same-parent/name pagination with the 0/1/>1 absence/current/conflicting partition and provider parity tests.
15. `issue-accepted-adr0001-recovery-conflict`: resolved by explicitly superseding only ADR 0001 Decision 2's same-session mandatory `recoverViaColdScan` rule, preserving all other commit-last and COLD policies, and declaring reject-time rework impacts.
16. `issue-cas-invocation-contradicts-existing-api`: resolved by using the existing two-argument `compareAndPut(expectedRecord, nextRecord)` signature everywhere and stating that path is carried by the records, never a third argument.

## Alternatives and closed decisions

<!-- anchor: adr-0001-metadata-cache-is-subordinate-to-commit-last -->
<!-- anchor: adr-20260825-issue43-destructive-authorization -->
<!-- anchor: adr-20260827-file-open-fast-pass-preserves-remote-change-batches -->
- Rejected: execute frozen actions, compare provider version order, persist priority receipts, defer stale plans, or trigger COLD for ordinary drift.
- Rejected: infer complete rename/alias topology from point reads or add provider enumeration.
- Rejected: expected-absence or multi-path CAS, a new structural transaction/precommit API, persisted component epochs/receipts, or schema migration.
- Rejected: terminal `current_state_churn`; it changes a mandatory current-state outcome.
- Adopted: while the committed cursor is usable, a schema-neutral, provider-call-free replay outcome owned privately by `CachingRemoteFs`; provider cursor rejection/expiry retains its existing typed COLD policy, and no shared reload API or exact source procedure is mandated.
- Status: Accepted — `adr-late-bound-component-execution` was accepted through `consultation-late-bound-sync-execution-20260828`.
- No open design questions remain. Private scheduling, locking, and replay mechanisms may vary only within the contracts and escalation boundaries above.
