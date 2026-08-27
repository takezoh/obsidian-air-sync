---
change: change-20260827-fast-pass-remote-freshness
role: requirements
functional_requirements:
- id: FR-FAST-PASS-01
  statement: When an eligible synced file is opened, complete its proved non-structural
    remote update before every normal action not started when the request was enqueued.
  priority: must
- id: FR-FAST-PASS-02
  statement: Reject no-record, excluded, unavailable, or locally changed opens before
    provider I/O and return typed no-op outcomes for unchanged or unsafe remote states.
  priority: must
- id: FR-FAST-PASS-03
  statement: Targeted file-open observation and read must not mutate or consume global
    cache, cursor, checkpoint generation, or shared provider anchors.
  priority: must
- id: FR-FAST-PASS-04
  statement: After priority enqueue, admit no new normal action; let already-started
    indivisible actions finish, drain priority at quiescence, and check again before
    finalization.
  priority: must
- id: FR-FAST-PASS-05
  statement: Hold one path-local Air Sync mutation lease across final record/local/tracker
    revalidation, LocalFs.write, record CAS, post-write tracker/content observation,
    and generation-specific acknowledgement; abort edits observed before mutation
    and leave edits observed during or after dirty and unacknowledged, without claiming
    atomic exclusion of simultaneous external adapter writes.
  priority: must
- id: FR-FAST-PASS-06
  statement: Require request-local authoritative complete ancestry from expected remote
    identity to the current configured root identity at the opened relative path;
    Dropbox consumes src/fs/caching/remote-fs.ts::CachingRemoteFs.rootFolderId inherited
    by src/fs/dropbox/index.ts::DropboxFs, populated from src/fs/dropbox/provider-base.ts::DropboxBackendData.remoteVaultFolderId
    (typed settings.backendData.remoteVaultFolderId) through src/fs/pkce-app-folder-provider.ts::PkceAppFolderProvider.createFs,
    without reading/writing the shared root-path anchor or adding durable authority;
    same-id root rename preserves the relative path, while missing/malformed identity,
    mismatch, or ambiguity performs no priority write.
  priority: must
- id: FR-FAST-PASS-07
  statement: Validate every not-yet-started normal action; classify frozen V1 older
    than applied V2 as superseded/no-op, and defer incomparable ordering while blocking
    clean checkpoint.
  priority: must
- id: FR-FAST-PASS-08
  statement: Return exhaustive typed priority failures and hand authoritative unresolved
    work to the normal lifecycle without acknowledging it as success.
  priority: must
- id: FR-FAST-PASS-09
  statement: Keep checkpoint commit exclusive to clean normal finalization after priority
    invalidations and replanned normal dispositions are resolved.
  priority: must
- id: FR-FAST-PASS-10
  statement: Apply fixed provider-response token/ancestry semantics and one no-global-mutation
    partition to all providers through mandatory shared fake/contract tests; missing/malformed
    evidence fails closed per request, while optional credential-gated live E2E never
    controls release/runtime capability or creates provider state.
  priority: must
- id: FR-FAST-PASS-11
  statement: On local-write success and record-save failure, retain tracker evidence
    and let a later normal cycle, including restart, read/hash same-size incomparable
    local/remote bytes on demand to converge equality as match without a marker.
  priority: must
- id: NFR-FAST-PASS-01
  statement: Make zero provider calls for ineligible opens and only targeted identity/ancestor
    calls plus a changed-file bound read for eligible opens; never enumerate the vault
    or drain delta.
  priority: must
- id: NFR-FAST-PASS-02
  statement: Add no durable queue, handoff, recovery marker, checkpoint field, or
    settings migration.
  priority: must
---
# Requirements — file-open fast pass priority and batch correctness

## Intent

Opening a synchronized file must bring that one file current ahead of normal batch
ordering. If a normal sync overlaps, an already-started indivisible action may finish,
then the opened-file attempt completes before any further normal action. The following
normal batch must remain correct and must receive its global remote delta normally.

## Observable requirements

### R1 — eligible opened file completes first

Given an in-scope file with a `SyncRecord`, unchanged local content, and a current remote
non-structural update, when it is opened while no normal action is active, then the
awaited handler applies the update and baseline before it resolves.

Given the same file is opened while a normal batch has already admitted actions, when the
open request is enqueued, then no additional normal action starts; admitted actions may
finish, the opened file completes, and only then may another normal action start.

Counterexample: placing the request behind the whole `runSync` mutex is not compliant,
even if the file is eventually updated.

### R2 — global batch remains untouched

Given a global delta contains the opened file and sibling paths, when file-open performs
targeted observation, then live/committed cursor, metadata cache, checkpoint generation,
and shared root anchor are unchanged. When normal sync proceeds, it observes the same
delta, including siblings and structural evidence.

Counterexample: consuming the delta and retaining siblings in a session handoff is not
compliant; the priority path must not consume it.

### R3 — local changes win over waiting priority

Given a priority request is queued or waiting on provider I/O, when the user edits the
local file before mutation, then record/local/tracker revalidation returns
`local_changed`, performs no overwrite, and does not acknowledge that edit. Final
validation, every Air Sync local write, record CAS, and tracker generation transition
share one path-local mutation lease, which remains held through post-write tracker/content
observation and generation-specific acknowledgement. An edit observed before the
mutation linearization point aborts the priority write. Edit evidence observed during or
after the write is never acknowledged as the self-write and remains dirty for normal
Admission. This closes the reviewed queue/provider-I/O wait race. It does not claim
atomic exclusion of a truly simultaneous editor/other-plugin adapter write after that
linearization point; such a write has the same ordering limitation as existing normal
sync.

### R4 — structural uncertainty fails closed

Given the expected remote identity is deleted, replaced, moved, renamed through an
ancestor, has ambiguous parents, or cannot be authoritatively traced to the configured
root at the opened path, when targeted observation completes, then priority performs no
read-to-write mutation and hands the case to normal Admission.

For Dropbox, request-local root resolution must not update the shared cache anchor. A
rename of the same stable root identity preserves the vault-relative child path derived
from current request-local root/file metadata. That identity is the existing `DropboxFs`
instance's inherited `CachingRemoteFs.rootFolderId`, populated from
`src/fs/dropbox/provider-base.ts::DropboxBackendData.remoteVaultFolderId` (the typed
`settings.backendData.remoteVaultFolderId`) through
`src/fs/pkce-app-folder-provider.ts::PkceAppFolderProvider.createFs`; the inherited
property is declared at `src/fs/caching/remote-fs.ts::CachingRemoteFs.rootFolderId`, and
the request-local point-read in `src/fs/dropbox/index.ts::DropboxFs` consumes it without reading
or writing the shared mutable root-path anchor and without adding durable authority.
Missing/malformed root identity, root-id mismatch, outside-root or ambiguous ancestry
fails closed. For Google Drive and OneDrive, cached ancestor paths are insufficient
authority.

### R5 — stale normal actions replan

Given a normal batch planned an action for the opened path before priority completes,
when that normal action reaches admission, then it compares expected `SyncRecord`, local,
and remote stamps with current values. If priority already applied the same version, it
becomes `match`/no-op. A frozen V1 proved older than the current persisted applied V2 is
terminal `superseded`/no-op and is never reclassified as `pull`. It never executes the
stale planned write.

If version ordering cannot be proved, the action is deferred and the checkpoint is not
cleanly committed.

### R6 — failures are observable and recoverable

Observation, authentication, throttling, provider, bound-read, local-write, record-save,
remote-superseded, and target-changed failures return distinct typed outcomes. They are
not converted to fulfilled success by logging.

An authoritative changed observation that was not applied is registered for normal
processing. If local write succeeds but record compare-and-put fails, tracker evidence is
retained. On a later normal cycle, including after restart, a same-size both-changed file
with incomparable checksums may read local and remote bytes once and compare SHA-256;
exact equality produces `match`, while read failure or divergence uses existing conflict
Admission. No recovery marker or priority token is required.

### R7 — provider parity and cost boundary

Google Drive, Dropbox, and OneDrive implement the same result partition and no-global-
mutation invariant. Ineligible opens make zero provider calls. Eligible opens use only
target identity/ancestor observation and, for a proved changed file, a token-bound read;
they never enumerate the vault or drain the global delta.

Google Drive uses id plus numeric `version`, Dropbox id plus `rev`/content hash, and
OneDrive id plus `cTag` (opaque `eTag` equality fallback) and quickXor/size. Required-field
absence, empty/non-numeric required tokens, and malformed identity/ancestry are
`unverifiable` for that request. Mandatory shared fake/contract tests establish each
provider response shape, point-read ancestry, token equality/order, read/reobserve, and
no-global-mutation behavior in the ordinary repository gate. Credential-gated live E2E
is optional, non-gating fidelity evidence; no E2E receipt controls release or runtime
capability and no permanent provider-fidelity backend state exists.

### R8 — strict priority has a quiescent progress bound

After the final priority enqueue, normal admission or finalization resumes after the
already-active permits settle, one attempt per distinct coalesced pending path settles,
and one coordinator transition completes. Continuous new opens intentionally retain
strict priority, but duplicate paths coalesce, queue age/count/completion/cancellation
counters are observable, and every permit/waiter/invalidation retires exactly once.

## Constraints

- No durable priority queue, global handoff, partial-recovery marker, checkpoint field,
  settings migration, or new COLD policy.
- Existing commit-last, logical-identity Admission, rename ordering, action phase safety,
  and provider-neutral engine policy remain controlling.
- No product latency, pagination, cancellation, or fairness threshold is inferred;
  R8 is a work-unit bound after quiescence, not a numeric time or burst threshold.

## Acceptance mapping

- R1: FR-FAST-PASS-01/04, AC-FAST-PASS-01.
- R2: FR-FAST-PASS-03/09/10, AC-FAST-PASS-02.
- R3: FR-FAST-PASS-02/05, AC-FAST-PASS-03.
- R4: FR-FAST-PASS-06/10, AC-FAST-PASS-04.
- R5: FR-FAST-PASS-07/09, AC-FAST-PASS-05.
- R6: FR-FAST-PASS-08/11, AC-FAST-PASS-06/07.
- R7: FR-FAST-PASS-10 and NFR-FAST-PASS-01/02, AC-FAST-PASS-08.
- R8: FR-FAST-PASS-04/09, AC-FAST-PASS-09.
