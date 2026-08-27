# File-open fast pass with detached observation and cooperative priority

## Decision

An opened file is synchronized through a priority lane that is ahead of every normal
action not yet admitted to execution. A normal action already admitted is indivisible
and may finish, but the batch executor then reaches a cooperative safe point, drains the
pending opened-file request, and only afterward admits another normal action. The
file-open handler awaits this result; it is not queued behind the remainder of an
in-flight batch.

The priority lane does not call the global incremental checkpoint and does not mutate the
shared metadata cache, live cursor, committed cursor, or Dropbox root anchor. It uses a
detached, identity-addressed provider observation whose path is authoritative only when
the complete ancestor chain from the expected identity to the configured root is proved
for that observation. Unproved ancestry, rename, move, delete, replacement, or root
ambiguity fails closed to the normal lifecycle.

The active normal batch keeps its existing global capture and commit-last lifecycle. A
batch action carries its expected `SyncRecord`, local generation/entity, and remote
identity/version. After a priority attempt, every not-yet-started action validates these
expectations and replans the affected path before mutation. A same-path action whose
remote version was already applied becomes `match`/no-op; a stale snapshot can never
overwrite the priority result. Priority ordering removes the long batch wait, and final
record/local/tracker revalidation under a path-local mutation lease closes the reviewed
wait/provider-I/O race. The lease is shared by every Air Sync local write and every
`LocalChangeTracker` generation transition and remains held through record CAS,
post-write tracker/content observation, and generation-specific acknowledgement. An
edit observed before mutation aborts the attempt; an edit observed during or after the
write is never acknowledged as the self-write and remains dirty for normal Admission.
This is Air Sync-internal ordering, not atomic exclusion of editor or other-plugin
adapter writes. A truly simultaneous external write after the mutation linearization
point has the same ordering limitation as existing normal sync and is not given a new,
stronger guarantee by this fast path.

This supersedes the earlier bounded global-batch handoff. File-open consumes no global
batch, so there is nothing to retain in a session accumulator. No COLD marker, fixed
10,000-entry/8-MiB threshold, reset-delta vocabulary, or dedicated
`APPLIED_UNBASELINED` recovery store/state machine is introduced.

## Requirements

<!-- anchor: fr-fast-pass-01 -->
### Priority completion

When an in-scope synced file is opened, local still matches its baseline, and detached
remote evidence proves a non-structural update, the priority attempt completes that file
before any normal action that had not started when the request was enqueued.

<!-- anchor: fr-fast-pass-02 -->
### Safe early rejection

No record, excluded path, missing filesystem/capability, or locally changed state returns
a typed no-op before provider I/O. Remote absence, directory, unchanged content metadata,
or structural/unverifiable evidence performs no priority write.

<!-- anchor: fr-fast-pass-03 -->
### Detached remote observation

File-open observation and bound read leave the global live/committed cursor, metadata
cache, checkpoint generation, and shared provider anchors byte-for-byte unchanged. The
next normal batch therefore receives the same provider delta it would have received if
the file had not been opened.

<!-- anchor: fr-fast-pass-04 -->
### Cooperative batch priority

The batch lifecycle lease stops admitting normal actions after a priority enqueue,
allows only already-admitted indivisible actions to finish, drains priority work at the
resulting quiescent safe point, and checks the same queue again before finalization.

<!-- anchor: fr-fast-pass-05 -->
### Local edit preservation

The priority attempt revalidates the expected record, local entity/content key, and local
tracker generation after waiting, then holds the path-local mutation barrier across the
last validation, `LocalFs.write`, record compare-and-put, post-write tracker/content
observation, and generation-specific acknowledgement. Every Air Sync local write and
tracker generation transition for that path uses the same barrier. An edit observed
before the mutation linearization point returns `local_changed` without writing. Any
edit evidence observed during or after the write is not acknowledged and remains dirty
for normal Admission. The contract closes the queue/provider-I/O wait race; it does not
claim atomic exclusion or stronger ordering for simultaneous external adapter writes.

<!-- anchor: fr-fast-pass-06 -->
### Structural fail-closed rule

The expected remote identity must still resolve through an authoritative ancestor chain
to exactly the opened vault-relative path. Ancestor rename/move, replacement at the old
spelling, missing identity, multiple/unknown parents, or an unstable Dropbox root proof
is handed to normal Admission without priority mutation.

A Dropbox root rename with the same stable root identity is not a vault-relative rename:
the stable identity is the existing `DropboxFs` instance's inherited
`CachingRemoteFs.rootFolderId` (`src/fs/caching/remote-fs.ts`), populated from
`settings.backendData.remoteVaultFolderId` typed as
`DropboxBackendData.remoteVaultFolderId` (`src/fs/dropbox/provider-base.ts`) by
`PkceAppFolderProvider.createFs` (`src/fs/pkce-app-folder-provider.ts`) when it constructs
`DropboxFs` (`src/fs/dropbox/index.ts`). The request-local point-read fetches current root
metadata with that instance value and strips its current path from the request-local
current file path, so the child relative path remains unchanged. It neither reads nor
writes the shared mutable cache root-path anchor and introduces no durable authority.
Missing/malformed root or file identity, root identity mismatch, an entry not under that
current root, or ambiguous/incomplete ancestry is structural/unverifiable.

<!-- anchor: fr-fast-pass-07 -->
### Following-batch correctness

Every not-yet-started normal action validates its expected record/local/remote stamp at
action admission. A mismatch replans that path from the frozen batch evidence and current
baseline/local state; it never executes the stale action. Unprovable reconciliation is
deferred and prevents a clean checkpoint commit.

If the frozen action carries V1 and the current successfully persisted priority record
carries V2 plus the active lease's application proof that V2 superseded that exact V1,
V1 is `superseded`/no-op and is never reclassified as `pull`. Provider-native ordering
may establish the same relation. Equality is `match`; any other incomparable ordering is
`deferred_stale_plan` and blocks clean checkpoint retirement.

<!-- anchor: fr-fast-pass-08 -->
### Typed failure handoff

Observation, authentication, throttling, bound-read, local-write, and baseline-save
failures are returned as typed outcomes. Pre-write failures do not masquerade as success;
observed-but-unapplied and applied-but-unbaselined outcomes request normal processing and
remain unresolved for an overlapping lease until a normal action reconciles them.

<!-- anchor: fr-fast-pass-09 -->
### Commit-last preservation

Priority work never commits a checkpoint. Only the existing normal finalizer may commit
the global cursor/cache, and it may do so only after all lease invalidations and normal
action dispositions are clean.

<!-- anchor: fr-fast-pass-10 -->
### Shared backend meaning

Google Drive, Dropbox, and OneDrive return the same detached observation partition and
honor the same no-global-mutation invariant. Provider-specific ancestry and version
tokens stay behind the shared capability.

Token semantics are fixed, not implementation discretion: Google Drive uses stable file
id plus numeric `version` (with md5/size as content evidence), Dropbox uses stable id plus
`rev`/content hash, and OneDrive uses stable id plus `cTag` (falling back to `eTag` only as
opaque equality evidence) and quickXor/size. Missing/malformed required fields are
`unverifiable` for that request. Dropbox/OneDrive unequal opaque tokens are unordered
unless the active lease has the exact priority-application relation. These semantics are
grounded in provider response fields and enforced for every backend by mandatory shared
fake/contract tests in the ordinary repository gate. Credential-gated live E2E is
optional, non-gating fidelity evidence; no release or runtime capability decision reads
an E2E receipt, and no permanent provider-fidelity state exists.

<!-- anchor: fr-fast-pass-11 -->
### Baseline-save convergence

If local write succeeds and `SyncRecord` compare-and-put fails, no tracker evidence is
acknowledged. After restart, the existing normal change detector may make one on-demand
remote byte read for a same-size, both-changed, checksum-incomparable file, hash both
local and remote bytes with SHA-256, and let the normal decision engine converge exact
equality as `match`. Read failure, unequal bytes, or ineligible shape stays on existing
conflict Admission. No marker or priority token is required.

<!-- anchor: nfr-fast-pass-01 -->
### Network scope

An ineligible open makes zero provider calls. An eligible open performs only targeted
identity/ancestor observation and, only for a proved changed file, a token-bound content
read; it never lists the vault or drains the global delta. No latency/page threshold is
invented.

<!-- anchor: nfr-fast-pass-02 -->
### No new durable authority

No durable queue, handoff, recovery marker, checkpoint field, or settings migration is
added. The checkpoint and `SyncRecord` remain the durable authorities.

## Repository grounding and ownership

<!-- anchor: component-file-open-scheduler -->
### File-open scheduler

`src/sync/scheduler.ts` filters null events, forwards the normalized path, awaits the
typed result, and maps actionable failure kinds to existing notification/logging policy.
It does not read cached remote metadata or swallow a failed priority attempt as success.

<!-- anchor: component-priority-coordinator -->
### Priority coordinator

`src/sync/priority-coordinator.ts` owns the transient pending map, batch lease state,
normal-action admission count, safe-point election, and completion promises. The
orchestrator remains its sole lifecycle owner. Duplicate opens of the same normalized
path join one pending attempt; no arbitrary numeric capacity is added. It also exposes
active permits, distinct pending paths, coalesced waiter count, completed/cancelled
attempts, and oldest pending age through existing diagnostics so a continuous priority
stream is observable.

<!-- anchor: component-freshness-orchestrator -->
### Freshness orchestrator

`src/sync/orchestrator.ts` owns eligibility, priority attempt execution, typed handoff,
batch invalidation, and checkpoint release integration. It never obtains the old
whole-batch `syncMutex` merely to place file-open behind `runSync`.

<!-- anchor: component-detached-observer -->
### Detached remote observer

`src/fs/interface.ts`, `src/fs/priority-observation.ts`, and
`src/fs/caching/remote-fs.ts` define a targeted capability using the baseline remote
identity, an authoritative path proof, and an opaque comparable version token. The shared
base does not call `ensureInitialized`, `loadFromCache`, cache setters, cursor replay, or
checkpoint persistence on this path.

<!-- anchor: component-provider-observers -->
### Provider observation seams

The Google Drive, Dropbox, and OneDrive filesystem implementations prove ancestry and
perform token-bound reads with request-local state. Dropbox root metadata is resolved
by point-reading the existing `DropboxFs.rootFolderId` inherited from
`CachingRemoteFs.rootFolderId` in `src/fs/caching/remote-fs.ts`, which was populated from
the configured `DropboxBackendData.remoteVaultFolderId` in
`src/fs/dropbox/provider-base.ts` by `PkceAppFolderProvider.createFs`; it never calls
`cache.setRootPath`. Google
Drive/OneDrive walk parents to the configured root and reject ambiguous/incomplete
chains.

<!-- anchor: component-action-cas -->
### Action CAS and convergence

`src/sync/plan-executor.ts`, `src/sync/state.ts`, `src/sync/local-tracker.ts`, and
`src/sync/decision-engine.ts` own action stamps, admission-time replan, record
compare-and-put, generation-specific acknowledgement, and content-equal convergence.
`src/sync/local-mutation-barrier.ts`, `src/fs/local/index.ts`, and `src/main.ts` wire the
single path-local write boundary used by `LocalFs` and `LocalChangeTracker`, including
the post-write tracker/content observation before acknowledgement.
The existing finalizer remains the sole checkpoint authority.

## Implementation contracts

<!-- anchor: contract-detached-targeted-observation -->
### Contract 1 — detached targeted observation

**Owner and trace.** `component-detached-observer` owns the shared contract and
`component-provider-observers` produces provider evidence. It implements
FR-FAST-PASS-02/03/06/10 and NFR-FAST-PASS-01/02 in Units 1 and 2.

**Operational inputs.** `input-open-path` is the normalized vault-relative spelling from
the scheduler. `input-expected-remote-identity` comes from the last successful
`SyncRecord`, not the shared cache. `input-configured-root-identity` is the backend's
stable configured root id; `input-current-root-proof` and all ancestor/file metadata are
fetched request-locally. For Dropbox its producer is the already-configured
`settings.backendData.remoteVaultFolderId`
(`src/fs/dropbox/provider-base.ts::DropboxBackendData.remoteVaultFolderId`), passed by
`src/fs/pkce-app-folder-provider.ts::PkceAppFolderProvider.createFs` into the live
`src/fs/dropbox/index.ts::DropboxFs` instance's inherited
`src/fs/caching/remote-fs.ts::CachingRemoteFs.rootFolderId`; the point-read consumes that
instance property directly.
This is configuration continuity, not a new record, setting, receipt, cache anchor, or
durable authority. `input-provider-observation` is request-local provider metadata. A successful
file result contains entity metadata, stable identity, authoritative relative path,
ancestor/root proof, and opaque `observationToken`; a read result contains bytes and a
token proved equal to that observation. Shared cache generations and root anchors are
explicitly not inputs or outputs.

**Decision rules.** `rule-observe-current-file` returns `current_file` only when one
identity and one complete authoritative chain reach the configured root at exactly the
requested vault-relative path. Dropbox derives that path by removing the current
request-local path of the same configured root identity; renaming that root alone leaves
the relative path unchanged. `rule-observe-structural` returns `structural` for
moved/renamed child ancestry, replaced, deleted, ambiguous-parent, root-identity mismatch,
outside-current-root, or unverifiable ancestry.
`rule-observe-unchanged` may return the same proved entity without downloading bytes.
`rule-bound-read` accepts a conditional read or read-plus-revalidation only when the
final token equals `observationToken`; supersession is inconclusive and performs no
write. Provider/auth/rate/network failures retain their typed classification.

**Fixed provider semantics and mandatory contracts.** Google Drive requests `id`, `parents`,
`name`, `mimeType`, `trashed`, `version`, `md5Checksum`, `size`, and `modifiedTime`; its
token order is numeric `version` for one id. Dropbox requests the configured root by id
and the file by baseline id; its file token is `rev` plus `content_hash`/size and supports
equality only. OneDrive requests the item/ancestor chain by id; its file token is `cTag`
plus quickXor/size, with `eTag` accepted only for equality when `cTag` is absent. Unequal
Dropbox/OneDrive tokens are incomparable unless Contract 3's exact application receipt
relates them. Missing, empty, non-numeric where numeric is required, or otherwise
malformed token, identity, parent, or ancestry fields return `unverifiable` for that
request and cannot authorize a read or write. Mandatory shared fake/contract tests fix
each response shape, token equality/order rule, ancestry proof, read/reobserve rule, and
failure partition and run in T0/T1 plus the ordinary repository gate. Credential-gated
`test:e2e:<provider>` may additionally demonstrate provider fidelity, but is optional,
non-gating evidence only: it creates no receipt lifecycle, runtime state, release gate,
or provider capability switch.

**No-mutation invariant.** Before/after witnesses snapshot live cursor, committed cursor,
cache generation/content, and root anchor. They must be identical even when a delayed
targeted result overlaps normal delta application. Dropbox uses a private root descriptor;
Google Drive/OneDrive cannot reconstruct a path from cached ancestors. This closes both
the cache/checkpoint generation race and Dropbox root-anchor race by removing their
shared writes, rather than adding a second writer CAS.

**Outcome partition.** Determinate `current_file`, `unchanged`, `missing`, `directory`,
and `structural`; inconclusive `superseded`, `unverifiable`, `auth`, `rate_limited`, and
`provider_failure`. Only a contract-valid `current_file` with a bound read can authorize
mutation. Tests:
`verify-detached-no-mutation`, `verify-authoritative-ancestry`,
`verify-provider-observation-parity`, and `verify-live-provider-fidelity`.

<!-- anchor: contract-cooperative-priority-safe-point -->
### Contract 2 — cooperative priority safe point

**Owner and trace.** `component-priority-coordinator` owns ordering; the orchestrator and
plan executor are consumers. It implements FR-FAST-PASS-01/04/07/09 in Units 3 and 4.

**Reference state machine.** One normal batch owns a `BatchLease` from global capture
through finalization. Normal action admission atomically changes
`activeNormalActions += 1` only when no priority request is pending. Priority enqueue
atomically sets `priorityPending` before returning its completion promise. Once set, no
new normal action is admitted. Already-admitted actions are indivisible and decrement the
counter on every success/failure exit. The transition
`BATCH_ACTIVE → PRIORITY_DRAIN` occurs when the counter reaches zero; one elected drainer
processes pending normalized paths and resolves each waiter, then returns to
`BATCH_ACTIVE`. Finalization uses the same safe point and atomically seals the lease only
when the queue and active count are empty. Enqueue after the seal belongs to the idle/next
lease and cannot race the committed batch.

**Ordering observable.** For enqueue event E and normal action start S, if E linearizes
before S, the opened-file completion P linearizes before S. If S precedes E, that one
action may finish before P, but every later action waits. Acquisition/planning may finish
to reach the first safe point; the request never waits for the remaining action list.

**Batch correctness.** A priority result registers affected path/identity tokens on the
active lease. Before any affected normal action starts, Contract 3 validates/replans it.
The finalizer cannot seal while an observed-but-unresolved lease invalidation remains.
Priority failure is caught into a typed result, so the state machine cannot strand the
counter or queue. Target switch, disconnect, clear, and close cancel waiters with
`target_changed` before teardown; they never execute against the old backend.

**Resource and fairness.** The pending carrier is an ordered map with at most one node per
normalized path; duplicate events join the same promise. No global delta, entity set, or
payload bytes are retained. Priority is intentionally strict over unstarted normal
actions; no unapproved numeric burst/fairness threshold weakens that order. Once the
final enqueue has linearized, progress is bounded in work units by completion of the at
most pool-concurrency already-admitted actions, then one attempt for each distinct
pending path, then one seal/admission transition. Provider retry loops are bounded by
existing retry policy and every attempt must settle or cancel. Continuous arrivals may
therefore intentionally delay normal admission, but duplicate paths coalesce, diagnostics
publish active/pending/coalesced/completed/cancelled/oldest-age counters, and every permit,
queue node, waiter, and invalidation is retired exactly once in `finally`; arrival cannot
strand a counter.

**Adversarial witnesses.** Enqueue while several pool actions run, enqueue before the
first action, enqueue during planning, same-path priority, action throw, target switch,
enqueue/finalize boundary, final-enqueue quiescence, and continuous coalesced arrivals.
Tests: `verify-priority-linearization`, `verify-current-action-only`,
`verify-finalization-safe-point`, and `verify-coordinator-liveness`.

<!-- anchor: contract-path-mutation-cas -->
### Contract 3 — path mutation CAS and typed normal handoff

**Owner and trace.** `component-action-cas` owns stamps and atomic record replacement;
`component-freshness-orchestrator` owns priority outcomes and handoff. It implements
FR-FAST-PASS-05/07/08/09/11 in Units 3 and 4.

**Operational inputs.** `input-record-stamp` is a canonical fingerprint of the expected
record or expected absence. `input-local-stamp` contains path, entity/content key,
mtime/size, and tracker generation. `input-remote-stamp` contains stable identity,
authoritative path, provider version token, and content key. `input-batch-stamp` binds a
normal action to its frozen batch generation and remote evidence. Producers are
respectively `SyncStateStore`, `LocalFs`/`LocalChangeTracker`, detached/provider evidence,
and normal planning; the action executor owns only immutable copies.

`input-local-mutation-lease` is produced by the shared path-local barrier. It has one
linearization queue per normalized path and covers all Air Sync `LocalFs.write` calls,
including conflict and rename-copy writes, plus `LocalChangeTracker.mark*`, snapshot
acknowledgement, and priority self-write acknowledgement transitions. The same lease
spans final record/local/tracker revalidation, the bound write, record CAS, post-write
tracker/content observation, and exact acknowledgement. It serializes Air Sync mutation
participants; it neither requires nor claims a platform fence against editor or
other-plugin adapter writes.

**Priority algorithm.** Revalidate record/local/tracker after queue wait and before any
provider call. Observe and, if changed, perform a token-bound read. Acquire the path-local
mutation lease and, while holding it, revalidate record/local/tracker and the same remote
token. Any edit observed by this final revalidation aborts as `local_changed`. Within Air
Sync, mutation linearizes at the barrier-ordered transition from that successful
revalidation to the bound `LocalFs.write`; the lease then remains held across record
compare-and-put, post-write tracker/content observation, and acknowledgement. Acknowledge
only when that observation still identifies the exact successful self-write generation
and written content. Any different/later tracker generation or content observation from
an edit during or after the write is never acknowledged and remains dirty for normal
Admission. External editor/other-plugin adapter writes do not participate in this lease:
a truly simultaneous write after the linearization point has the same ordering limitation
as existing normal sync, and this contract makes no stronger atomic-exclusion claim.

**Normal action algorithm.** At admission after every safe point, compare the planned
record/local/remote stamps with current state. Exact match executes the action. A mismatch
re-runs the existing decision rule for that path using the frozen batch remote entity and
current record/local entity. For frozen V1 versus a current persisted V2, equality is
`match`; a provider-native `V1 < V2` relation or the active lease's exact successful
priority application receipt makes V1 `superseded`/no-op. That branch is terminal and
must never feed V1 back to the ordinary rule as `remote_changed`/`pull`. If identity or
version ordering is incomparable, return `deferred_stale_plan`; do not mutate and do not
permit a clean checkpoint. Structural actions validate both endpoints and
ancestor-affecting priority tokens.

**Typed failures and handoff.** Results are `applied`, `not_eligible`, `local_changed`,
`unchanged`, `structural`, `superseded`, `auth`, `rate_limited`, `provider_failure`,
`read_failure`, `write_failure`, `applied_unbaselined`, or `target_changed`. No pre-write
failure acknowledges local state. An authoritative changed/structural observation that
is not applied registers unresolved normal work with the active lease; without a lease it
requests the existing normal trigger. `applied_unbaselined` leaves tracker evidence and
record expectation unchanged. On any later normal cycle, including after restart,
`change-hash-enrichment.ts` selects only exact non-directory entries with a baseline,
both sides temporally changed, equal size, and no comparable content proof; it reads
local and remote bytes once, hashes both with SHA-256, and supplies equality to
`decision-engine.ts`. Equality emits `match`; read failure or inequality leaves existing
conflict Admission. Exact implementation/test scope is `src/sync/change-detector.ts`,
`src/sync/change-hash-enrichment.ts`, `src/sync/change-detector.test.ts`,
`src/sync/decision-engine.ts`, and `src/sync/decision-engine.test.ts`. There is no
dedicated recovery store, marker, priority token after restart, or baseline-only retry.

**Witnesses.** User edit during queue wait, edit during provider I/O, delayed old
observation against a newer delta/cache generation, priority and planned pull for the
same path, baseline save failure, incomparable checksums, rename of an ancestor, and
tracker event after self-write. An external write is an ordering-limitation witness: if
its tracker/content evidence is observed during or after the Air Sync mutation, it stays
dirty and is not acknowledged, while a truly simultaneous adapter write after the
linearization point is not claimed to be atomically excluded. Tests:
`verify-priority-cas`, `verify-normal-action-replan`, `verify-typed-handoff`, and
`verify-content-equal-convergence`.

## ADR projections

<!-- anchor: adr-0001-commit-last -->
### ADR 0001 — metadata cache is subordinate to commit-last

Accepted and unchanged. Detached observation never mutates checkpoint state. Normal
finalization remains the only cursor/cache commit and unresolved CAS results block it.

<!-- anchor: adr-0002-shared-backend-contracts -->
### ADR 0002 — shared backend behavior contracts

Accepted and unchanged. All providers implement one detached observation partition and
the same no-global-mutation tests; engine policy has no backend branch.

<!-- anchor: adr-0006-order-independent-rename -->
### ADR 0006 — remote rename detection is order-independent

Accepted and unchanged. Priority cannot consume or synthesize rename evidence; any
structural proof is deferred to the normal global delta and Admission.

<!-- anchor: adr-0008-logical-identity-admission -->
### ADR 0008 — logical-identity admission fails closed

Accepted and controlling. Priority uses the baseline identity and authoritative ancestry;
replacement and ancestor movement cannot become a path-only pull.

<!-- anchor: adr-20260827-file-open-fast-pass-preserves-remote-change-batches -->
### File-open fast pass preserves remote change batches

Accepted by consultation and reworked to the authorized meaning: detached targeted
observation plus cooperative priority safe points and action CAS. The earlier global
capture/session-handoff mechanism is rejected because it consumes the very batch that
the following normal sync must naturally receive.

## Decision dispositions

**Global delta capture + session handoff — rejected.** It advances live global state,
creates a second session lifecycle, and requires capacity/COLD behavior not needed when
file-open can observe by identity without consuming the cursor.

**Detached targeted observation — adopted.** It preserves later global batch/cursor work
by construction. The provider-specific cost is authoritative ancestry and token-bound
read proof; inability to prove either is a safe normal handoff.

**Whole-batch `syncMutex` ordering — rejected for file-open.** It makes the priority
request wait behind the complete in-flight batch. The batch lease and cooperative action
safe point retain existing phase/transfer concurrency while ordering priority ahead of
unstarted actions.

**Concurrent uncoordinated targeted write — rejected.** A detached network read alone
does not protect local edits or stale planned actions. Record/local/remote stamps and
action-admission replan are required.

**Reset content-reporting extension — removed.** Detached observation does not consume a
reset/global scan, so no file-open correctness failure requires new reset delta vocabulary.
Existing reset/COLD behavior and shared contracts remain unchanged.

**Dedicated partial-baseline recovery — removed.** Typed `applied_unbaselined`, retained
tracker evidence, commit-last, and an on-demand normal local/remote byte equality proof
close the correctness failure across restart without a session guard, retry-only policy,
or durable marker.

**Provider token choice as implementation discretion — rejected.** The provider response
fields, ordering/equality semantics, missing/malformed-field outcome, and request-local
ancestry proof are part of Contract 1 and mandatory shared fake/contract tests. Optional
credential-gated E2E supplies additional fidelity evidence only; it does not enable or
disable release/runtime capability and has no receipt or persistent backend-state
lifecycle.

## Critique and review issue dispositions

```yaml
resolved_issues:
  - issue_ref: issue-cursor-reset-drops-content-sibling
    disposition: removed
    resolution: File-open no longer consumes global/reset replay; the following normal batch naturally observes reset state, so no reset reporting extension is required.
  - issue_ref: issue-rename-replacement-can-priority-overwrite
    disposition: adopted
    resolution: Contract 1 requires baseline identity plus authoritative full ancestry and fails replacement or movement closed.
  - issue_ref: issue-normal-retry-can-drop-newer-batch
    disposition: superseded
    resolution: No priority global capture exists; normal retry owns its unchanged global lifecycle and Contract 3 invalidates stale planned actions.
  - issue_ref: issue-partial-pull-failure-collapsed
    disposition: adopted-minimally
    resolution: Contract 3 returns applied_unbaselined and converges through normal match without a dedicated recovery contract.
  - issue_ref: issue-rename-chain-outcome-unclosed
    disposition: superseded
    resolution: Priority never merges rename edges; normal Admission retains the accepted global rename semantics.
  - issue_ref: issue-cold-recovery-alternative-unexamined
    disposition: removed
    resolution: Detached observation consumes no global cursor, so file-open adds no COLD debt in the normal or fallback path.
  - issue_ref: issue-handoff-growth-unbounded
    disposition: removed
    resolution: The global handoff is deleted; the priority queue stores at most one control node per normalized opened path and no remote payload batch.
  - issue_ref: issue-network-bound-contradicts-reset-fallback
    disposition: removed
    resolution: Priority never invokes reset or full enumeration; only targeted provider observation and conditional content read remain.
  - issue_ref: issue-fast-pass-latency-unbounded
    disposition: rejected
    resolution: Authority fixes ordering, not a latency/page threshold; operation scope is bounded to targeted calls without inventing cancellation policy.
  - issue_ref: review-checkpoint-cache-generation-race
    disposition: adopted
    resolution: Contract 1 makes targeted observation read-only with respect to cache and cursor, so a delayed result cannot overwrite a newer generation.
  - issue_ref: review-local-edit-wait-race
    disposition: adopted
    resolution: Contract 3 revalidates local/record/tracker before observation and write and acknowledges only the exact successful self-write generation.
  - issue_ref: review-dropbox-root-anchor-race
    disposition: adopted
    resolution: Dropbox targeted observation uses a request-local root descriptor and never writes the shared cache root anchor.
  - issue_ref: review-ancestor-path-authority
    disposition: adopted
    resolution: Contract 1 requires authoritative complete ancestry and fails closed on cached, ambiguous, or incomplete chains.
  - issue_ref: review-typed-priority-failure
    disposition: adopted
    resolution: Contract 3 returns an exhaustive typed result and binds unresolved changed observations to normal lifecycle/checkpoint disposition.
  - issue_ref: review-priority-blocked-by-full-batch
    disposition: adopted
    resolution: Contract 2 pauses new action admissions after enqueue and drains priority after only already-started indivisible actions.
  - issue_ref: review-scope-paths-not-machine-readable
    disposition: adopted
    resolution: Every unit in spine.yaml and implementation.md lists exact repository-relative files; no prose-only scope declaration remains in this plan.
  - issue_ref: issue-local-write-check-use-race
    disposition: adopted-scoped
    resolution: Contract 3 closes the reviewed queue/provider-I/O wait race with priority ordering and one path-local Air Sync mutation lease spanning final record/local/tracker revalidation, LocalFs.write, record CAS, post-write tracker/content observation, and exact acknowledgement. Edits observed before mutation abort; edits observed during or after are not acknowledged and remain dirty. Truly simultaneous external adapter writes after the linearization point retain the same ordering limitation as normal sync; no impossible atomic exclusion is claimed.
  - issue_ref: issue-frozen-batch-replan-can-downgrade
    disposition: adopted
    resolution: Contract 3 makes frozen V1 versus persisted applied V2 with exact supersession proof a terminal superseded/no-op branch; incomparable versions defer and block checkpoint rather than re-entering pull classification.
  - issue_ref: issue-dropbox-root-change-unobservable
    disposition: resolved
    resolution: Contract 1 names the existing producer exactly; settings.backendData.remoteVaultFolderId is passed through DropboxBackendData and PkceAppFolderProvider.createFs into the live DropboxFs instance's inherited CachingRemoteFs.rootFolderId. The request-local point-read consumes that value, never the shared root-path anchor, and adds no durable authority; same-id root rename is safe while missing/malformed identity, mismatch, outside-root, or ambiguous ancestry fails closed.
  - issue_ref: issue-applied-unbaselined-restart-proof-gap
    disposition: adopted
    resolution: Contract 3 adds exact normal-engine source/test scope for a same-size both-changed checksum-incomparable candidate to read both byte streams once, SHA-256 them, and converge equality after restart without a marker.
  - issue_ref: issue-priority-stream-starves-normal-batch
    disposition: adopted-with-explicit-priority
    resolution: Contract 2 gives a quiescent work-unit bound after the final enqueue, exact once-settlement/counter retirement, duplicate coalescing, and queue diagnostics; continuous arrivals intentionally retain authorized strict priority and are observable rather than falsely promised fairness.
  - issue_ref: issue-live-provider-token-evidence-overreach
    disposition: resolved
    resolution: Contract 1 fixes provider-response token/order and ancestry semantics with mandatory shared fake/contract tests; missing or malformed request evidence fails closed. Credential-gated live E2E is optional non-gating fidelity evidence and has no receipt, release/runtime enablement wire, or permanent provider-fidelity state.
```

## Implementation order

Unit 1 defines the detached capability and shared no-mutation contract. Unit 2 implements
authoritative provider observations. Unit 3 adds the priority coordinator and restructures
executor admission around safe points. Unit 4 integrates action stamps, record/tracker
CAS, typed outcomes, scheduler behavior, finalizer guard, docs, and the complete gate.

## Verification strategy

T0 covers provider-independent observation typing, coordinator linearization/state
transitions, path-local write-barrier/record/tracker CAS and post-write observation,
normal action supersession and
incomparable-order replan, restart byte-equality convergence, and result mapping. T1 runs
shared Google Drive/Dropbox/OneDrive overlap contracts, including delayed targeted calls
against global delta/cache/root updates, same-path batch replan, failures, restart, and
commit-last. T2 is credential-gated, optional, and outside the ordinary CI/repository
gate; it records supplemental live fidelity observations but never enables or disables a
provider at release or runtime. Per-request missing/malformed token or ancestry evidence
still fails closed under the mandatory Contract 1 implementation and T0/T1 tests.
The mandatory repository gate is
`npm run lint`, `npm run lint:bot-repro`, `npm run build`, and `npm test`.

## Implementation discretion

Only the private waiter representation is delegated. It must preserve the specified
enqueue/action linearization, one-node-per-path coalescing, quiescent progress bound,
diagnostic counters, exhaustive typed outcomes, authoritative ancestry, and fixed
provider equality/ordering semantics.
Escalate if implementation would consume a global delta, write shared cache/root state,
add durable schema, relax priority ahead of an unstarted action, permit path-only
identity, execute a stale normal action without replan, claim atomic exclusion of
external adapter writes, weaken the mandatory provider token/ancestry contract, or make
release/runtime capability depend on an optional live-E2E receipt.

No open product decision remains.
