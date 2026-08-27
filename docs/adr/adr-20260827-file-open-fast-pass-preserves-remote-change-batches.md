---
id: adr-20260827-file-open-fast-pass-preserves-remote-change-batches
kind: adr
title: File-open fast pass preserves later remote batches
status: accepted
created: '2026-08-27'
decision_makers:
- user
consulted: []
informed: []
tags:
- sync
- file-open
- concurrency
owners: []
relations:
- {type: originatedFrom, target: change-20260827-fast-pass-remote-freshness}
source_paths:
- src/fs/interface.ts
- src/fs/caching/remote-fs.ts
- src/fs/dropbox/provider-base.ts
- src/fs/dropbox/index.ts
- src/fs/googledrive/index.ts
- src/fs/onedrive/index.ts
- src/sync/orchestrator.ts
- src/sync/scheduler.ts
- src/sync/decision-engine.ts
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md
consequences:
  positive:
  - Opened-file work precedes every unstarted normal action without consuming the
    global delta.
  - Later batch actions revalidate and cannot overwrite a newer priority result.
  negative:
  - The executor requires cooperative safe points, per-action stamps, and targeted
    provider ancestry checks.
  - Strict priority can delay normal actions while new opened-file requests continue
    arriving.
  neutral:
  - Checkpoint and SyncRecord remain the only durable authorities.
confirmation: Shared contracts verify detached observation, priority linearization,
  stale-action rejection, and typed failure handoff.
summary: Use detached provider observation, cooperative priority safe points, and
  action-time CAS so file-open runs first while the later global batch remains correct.
updated: '2026-08-27'
---

# ADR: File-open fast pass preserves remote change batches

Status: Accepted

Date: 2026-08-27

## Context

The file-open fast pass must make an eligible opened file current ahead of normal batch
ordering. The previous design acquired the global delta under the same whole-batch mutex,
published consumed siblings into a bounded session handoff, and let the later normal
cycle use that handoff. That design had two mismatches with the required outcome:

1. `pullSingle` still waited behind the entire in-flight `runSync`, so it was not priority
   work when the two overlapped.
2. File-open became another writer of shared metadata/cache/root state and consumer of
   the global cursor. Delayed targeted results could race newer delta metadata and the
   Dropbox root anchor, while capacity, reset, COLD, and partial-recovery policies were
   introduced only to repair the consumption.

The user authority is explicit: the single opened file completes first, and the following
batch remains correct. An already-started indivisible normal action may finish, but an
opened request must not be placed behind all remaining normal actions.

Accepted ADR 0001 keeps cache/cursor subordinate to clean normal commit. ADR 0002 requires
shared backend behavior. ADR 0006 and ADR 0008 require structural/identity evidence to
remain intact and fail closed rather than becoming path-only overwrites.

## Decision

Adopt three coupled contracts.

### 1. Detached targeted observation

File-open addresses the baseline remote identity directly and obtains request-local
current metadata, complete authoritative ancestry to the configured root, exact
vault-relative path, and an opaque version token. A changed file is read conditionally or
read then reobserved; the token must still match before local mutation.

This path never calls global delta replay and never changes live/committed cursor,
metadata cache, checkpoint generation, or shared root anchor. Dropbox fetches the current
root by the live `DropboxFs` instance's inherited `CachingRemoteFs.rootFolderId` and
strips its request-local current path from the file's current path. That existing instance
value is declared at `src/fs/caching/remote-fs.ts::CachingRemoteFs.rootFolderId` and is
populated from `src/fs/dropbox/provider-base.ts::DropboxBackendData.remoteVaultFolderId`
(the typed `settings.backendData.remoteVaultFolderId`) through
`src/fs/pkce-app-folder-provider.ts::PkceAppFolderProvider.createFs` into
`src/fs/dropbox/index.ts::DropboxFs`; the request-local path neither
reads nor writes the shared mutable cache root-path anchor and creates no durable
authority. Renaming that same root leaves the child vault-relative path unchanged.
Missing/malformed root identity, root-id mismatch, outside-root/ambiguous ancestry,
missing, moved, or replaced evidence is structural normal-handoff. Google Drive and
OneDrive prove ancestors from current provider metadata.

Token semantics are fixed: Google Drive id plus numeric `version` (md5/size content
evidence), Dropbox id plus opaque `rev`/content hash, and OneDrive id plus `cTag` and
quickXor/size (`eTag` equality fallback only). Missing required fields are unverifiable.
Mandatory shared fake/contract tests ground these provider response fields, required
field validation, ancestry, token equality/order, read/reobserve behavior, and the
no-global-mutation partition in the ordinary repository gate. Missing, empty,
non-numeric where numeric is required, or otherwise malformed token/identity/ancestry
fails closed as `unverifiable` for that request. Credential-gated live E2E is optional,
non-gating fidelity evidence; it creates no receipt lifecycle, permanent backend state,
release gate, or runtime provider-capability switch.

### 2. Cooperative priority safe point

A normal run owns a batch lifecycle lease, not an exclusive file-open mutex for its full
duration. Each normal action obtains a permit immediately before start. Priority enqueue
stops new permits. Already-started indivisible actions finish; when the active count
reaches zero, one drainer completes pending priority work before permits resume.
Finalization uses the same safe point and seals only with no active action, pending
priority, or unresolved invalidation.

Therefore, if priority enqueue linearizes before a normal action start, priority
completion linearizes first. Existing action phases and pool concurrency remain between
safe points.

After the final enqueue, progress is bounded by settling the already-active permits, one
attempt for each distinct coalesced pending path, and one resume/seal transition.
Continuous arrivals intentionally retain strict priority; active/pending/coalesced/
completed/cancelled counts and oldest age are observable, and `finally` retires every
permit, waiter, node, and invalidation exactly once.

### 3. Path mutation CAS and normal replan

Priority revalidates expected `SyncRecord`, local entity/content, tracker generation, and
remote identity/version after waiting. It then holds one normalized path-local mutation
lease across the last validation, every Air Sync `LocalFs.write`, record compare-and-put,
post-write tracker/content observation, and exact self-write generation acknowledgement;
tracker mark/ack transitions use the same lease. An edit observed before the Air Sync
mutation linearization point aborts the priority write. Edit evidence observed during or
after the write is never acknowledged as the self-write and remains dirty for normal
Admission. Priority ordering plus the final lease-held revalidation closes the reviewed
queue/provider-I/O check-use race.

This lease orders Air Sync participants; it does not atomically exclude editor or
other-plugin adapter writes. A truly simultaneous external write after the mutation
linearization point retains the same ordering limitation as existing normal sync. The
fast path neither claims a stronger guarantee nor requires unavailable platform proof.

Normal planned actions carry the same expected stamps. At post-priority admission a
stale action replans its path from the frozen batch remote evidence plus current
record/local state. A frozen V1 proved older than persisted priority-applied V2 becomes
terminal `superseded`/no-op and never becomes pull. Incomparable ordering defers and
prevents clean checkpoint commit; stale mutation is forbidden.

Failures are typed. Authoritative observed work not applied enters the existing normal
lifecycle. If write succeeded but baseline save failed, tracker evidence remains and
the later normal detector, including after restart, may read same-size both-changed
checksum-incomparable local/remote bytes once and compare SHA-256. Equality produces
`match`; failure/divergence uses normal conflict Admission. No dedicated partial-baseline
state or marker is added.

## Consequences

### Positive

- The opened file is ahead of all unstarted normal actions, without waiting for the
  remainder of the batch.
- The following normal sync receives global delta and siblings naturally because
  file-open never consumes the cursor.
- A delayed targeted result cannot overwrite a newer metadata-cache generation or mutate
  Dropbox's root anchor.
- Ancestor rename/move and same-path replacement fail closed on all providers.
- Local edits during queue/network wait and stale normal plans are protected by the same
  expected-state discipline.
- The global handoff accumulator, 10,000-entry/8-MiB thresholds, file-open COLD policy,
  reset content-reporting extension, and dedicated partial-baseline recovery contract are
  removed.

### Costs

- Provider implementations must perform authoritative targeted ancestry checks and
  version-bound reads. More than one targeted request may be required.
- The action executor gains a centralized permit/safe-point hook and per-action replan,
  which is more involved than a whole-run mutex.
- Strict priority can delay admission of normal actions while opened-file requests remain
  pending. Duplicate normalized paths are coalesced, progress is bounded after the final
  enqueue, and continuous arrival is observable, but no unapproved burst threshold is
  introduced.
- The Air Sync path lease cannot order a truly simultaneous external adapter write after
  its mutation linearization point; this is the same limitation as existing normal sync,
  not a new atomic-exclusion guarantee. Provider token and ancestry correctness is a
  mandatory shared-contract obligation, not a live-E2E enablement state.

### Failure behavior

- Unverifiable path/root/version evidence performs no priority write.
- An edit observed before mutation performs no priority write; edit evidence observed
  during or after the write is not acknowledged and remains dirty for normal Admission.
- Missing/malformed provider token, identity, or ancestry performs no priority write for
  that request.
- Provider/auth/rate/read/write/save failures are observable typed results, never
  logger-only success.
- An unresolved authoritative observation blocks clean retirement only when the active
  lease cannot prove normal reconciliation; otherwise the unconsumed global delta remains
  the later authority.
- Target switch/clear/close cancels waiters before old-target execution.

## Rejected alternatives

### Global delta capture plus bounded session handoff

Rejected. It consumes global state on the priority path, creates a second lifecycle and
capacity policy, and still needs complex recovery to preserve siblings. Detached
observation preserves them by construction.

### Whole-batch mutex

Rejected for file-open ordering. It is safe but violates the requirement that the opened
file run ahead of remaining normal batch actions.

### Uncoordinated concurrent targeted pull

Rejected. A read-only targeted API alone cannot protect local edits, same-path planned
actions, or checkpoint finalization.

### Reset-reporting and dedicated applied-unbaselined contracts

Rejected as unnecessary additions. File-open no longer consumes reset/global replay, and
typed normal handoff plus existing commit-last/content-equality convergence closes the
post-write save failure without separate session state.

## Verification

The decision is accepted only with:

- a linearization test proving priority completion before every action whose start is
  later than enqueue;
- same-path action replan/no-op and local-edit adversarial tests;
- delayed targeted observation versus newer delta/cache generation tests;
- request-local Dropbox root and authoritative Google Drive/OneDrive ancestor tests;
- path-local Air Sync write/tracker linearization through post-write observation and exact
  acknowledgement, plus tests that preserve later/different edit evidence without
  claiming external atomic exclusion;
- frozen V1/applied V2 supersession and incomparable-order checkpoint-blocking tests;
- quiescent progress-bound, continuous-arrival diagnostics, and exact counter retirement tests;
- exhaustive typed failure and applied-unbaselined convergence tests;
- unchanged three-backend crash-safety/change-detection contracts; and
- the full repository lint, bot-repro, build, and test gate.

Credential-gated live provider E2E is optional and outside the ordinary repository gate.
It records supplemental point-read/ancestry/token/read-reobserve fidelity evidence, but
does not enable or disable release/runtime capability and has no receipt or persistent
provider-state lifecycle. Missing credentials cannot weaken the mandatory shared
contracts or their per-request fail-closed behavior.

## Consultation provenance

Accepted through `consultation-fast-pass-parallel-batch-handoff`, based on the explicit
instruction that the opened file complete ahead of overlapping normal batch work while
the following batch remains correct.


{% transition from="proposed" to="accepted" date="2026-08-27" %}
User required opened-file priority with a correct following batch; independent plan attack findings were resolved.
{% /transition %}
