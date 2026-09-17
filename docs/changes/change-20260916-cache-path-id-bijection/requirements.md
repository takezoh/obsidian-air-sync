---
change: change-20260916-cache-path-id-bijection
role: requirements
functional_requirements:
- id: FR-ADDR-001
  statement: THE shared metadata cache SHALL decide which cache path an object receives,
    whenever that path is one the cache composed itself from a provider name and a
    parent chain, through a single arbitration owner; no other writer SHALL decide
    a contended derived address on its own authority.
  priority: must
- id: FR-ADDR-002
  statement: THE shared metadata cache SHALL, after every mutation on both the full-scan
    and the incremental-delta route, hold at most one stable backend id at each cache
    path and at most one cache path for each stable backend id, with no stable id
    left mapped to a path that no longer holds it.
  priority: must
- id: FR-ADDR-003
  statement: WHEN two or more distinct stable ids claim one derived cache path within
    one evidence unit, THE cache contents and the announced facts at the close of
    that unit SHALL be identical for every permutation of the unit's claims, including
    the permutations in which a claimant's children are applied before that claimant
    has lost and in which the losing claimant is applied first.
  priority: must
- id: FR-ADDR-004
  statement: AT the close of an evidence unit, no entry whose resolved parent chain
    passes through a displaced claimant SHALL be cached, listed, stat-able or announced
    under the winning claimant's path; such entries SHALL be reported as displaced
    alongside their claimant.
  priority: must
- id: FR-ADDR-005
  statement: WHEN any cache writer removes or withholds a live occupant, a live claimant,
    or any of their descendants because another stable id holds that cache path, THE
    cache SHALL name the contended path, the admitted id, the withheld id, every displaced
    descendant path and the reason in the value returned by the call that caused it,
    and SHALL emit one warn-level log for that contended address.
  priority: must
- id: FR-ADDR-006
  statement: 'A contention observed part-way through an evidence unit SHALL NOT be
    final: it SHALL be settled against the facts held at the close of the complete
    unit, so that a tombstone for the admitted id arriving later in the same unit
    readmits the withheld claimant; and nothing about that settlement SHALL survive
    the unit.'
  priority: must
- id: FR-ADDR-007
  statement: EVERY object that existed on the provider before a contention was observed
    SHALL still exist on the provider afterwards and SHALL be reachable in the vault
    once synced, unless the user deleted it; NO object SHALL be deleted, emptied,
    truncated or made permanently unreachable in order to free a cache address, on
    any route, including every failure path of the remediation.
  priority: must
- id: FR-ADDR-008
  statement: WHEN two claims that are both provider-resolved contend for one cache
    address, THE plugin SHALL rename on the provider the claimant that is not to keep
    that address, to the address produced by the existing conflict-suffix convention
    with a discriminator derived from that claimant's own stable id, as an action
    of the existing rename_remote kind authorized by Admission from current-cycle
    facts; WHERE a contending claim is not provider-resolved, NO rename SHALL be performed
    for it.
  priority: must
- id: FR-ADDR-009
  statement: 'WHEN a cycle observes a contention for which a remediation is owed,
    THAT cycle SHALL be checkpoint-blocked: the remote cursor SHALL NOT advance, the
    derived cache SHALL NOT be committed, and the working view SHALL be aborted, so
    the next cycle re-derives the same evidence unit from the last committed checkpoint.'
  priority: must
- id: FR-ADDR-010
  statement: THE remote delta SHALL NOT report as deleted any path whose absence is
    attributable to a displacement decided within the same evidence unit; a path whose
    object the provider really removed, and a path whose parent left the tracked root,
    SHALL continue to be reported as deleted.
  priority: must
- id: FR-ADDR-011
  statement: WHEN a sync cycle observes at least one contended cache address, THE
    plugin SHALL surface, as a non-error fact distinct from the error count, how many
    addresses were contended, through a surface visible to a user who has changed
    no settings; and the contended paths with both stable ids SHALL be recoverable
    from the log without reproducing the failure.
  priority: must
- id: FR-ADDR-012
  statement: A shared contract case SHALL pin "two distinct stable ids resolving to
    one cache path" at the public filesystem boundary for every registered caching
    family, in both provider orderings, asserting the survival of both objects rather
    than merely a stable winner; and the central required-contract matrix SHALL oblige
    each family to supply either a collision-producing harness script or a cited non-producibility.
  priority: must
- id: FR-ADDR-013
  statement: THE address arbitration SHALL NOT throw for a contended cache path, and
    every uncontested path SHALL continue to sync in the cycle that observes a contention,
    including the cycles in which the checkpoint is blocked.
  priority: must
- id: NFR-ADDR-001
  statement: THIS change SHALL NOT persist a collision record, chosen-address table,
    disposition, failure reason, repair queue or recovery marker; SHALL NOT add a
    persistent store or a retained in-memory correctness owner; SHALL NOT add an instance
    field to AbstractMetadataCache; SHALL NOT bump METADATA_CACHE_VERSION or change
    the FileRecord shape; SHALL NOT add a SyncActionType, a DAG or a recovery queue;
    and SHALL leave sync-state-ownership-guard.test.mjs and sync-admission-authority-guard.test.mjs
    green with no fixture edits.
  priority: must
- id: NFR-ADDR-002
  statement: THE backend-agnostic base SHALL contain no provider-specific branch,
    predicate or capability hook, and AbstractMetadataCache SHALL issue no provider
    request and hold no client; the identity-addressed rename SHALL be an optional
    filesystem capability in the shape the codebase already uses for checkpoint, never
    a predicate on backend identity.
  priority: must
- id: NFR-ADDR-003
  statement: NO address the cache computed itself SHALL be stored as actual_resolved
    or reach exportRecords or the durable checkpoint as provider-resolved topology;
    in particular the disambiguated address SHALL NOT be written to the cache in advance
    of the rename, and becomes a cache address only when the provider reports the
    renamed object.
  priority: must
- id: NFR-ADDR-004
  statement: RESOLVING a contention SHALL cost zero additional provider read requests
    on either route; the only provider mutation introduced SHALL be one rename per
    contended address per cycle, issued from the execution phase as an admitted action
    and never from the cache or from a drain.
  priority: must
- id: NFR-ADDR-005
  statement: NO part of this change SHALL reference Logger.enabled or src/sync/sync-cycle-diagnostics.ts,
    neither of which is on main (commit 50c02c2 is not an ancestor of HEAD 60e85b0).
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

### The condition

Google Drive permits two distinct objects to share a name under one parent. The vault cannot hold
two files at one path, and neither can Dropbox or OneDrive as sync destinations. So a source state
exists that the destination cannot represent. Today `AbstractMetadataCache.setFile` resolves it as
a cache-internal overwrite — `removeTree(path)` at `metadata-cache.ts:110-116`, with no log line,
no throw and no entry in any result object — and the evicted object, with its whole subtree if it
was a folder, never syncs again.

Because the destination cannot represent the condition, the source must stop containing it. The
repository owner decided during design that Air Sync renames one of the colliding objects on the
provider, using the conflict-suffix convention the plugin already uses, and that the binding
invariant is that **nothing is lost**.

### Reachability, which bounds how much machinery this deserves

The built-in Google Drive connection runs on `drive.file` (`googledrive/auth.ts:10`), so it sees
only objects Air Sync itself created; `README.md:53` states the consequence to users. A duplicate
created on the cloud side is therefore invisible on the built-in backend and never reaches the
cache. Duplicate-name collisions need either custom OAuth with the full `drive` scope or both
objects being Air Sync's own uploads. Orphan collapse to a bare name needs no duplicate at all and
is reachable by every user, and it is resolved here with no rename and no provider cost. Severity
still governs the safety requirements: the failure mode is a local file deleted while the object
that should replace it never arrives.

### Functional requirements

**FR-ADDR-001 — one owner for derived address assignment.** The shared metadata cache shall decide
which cache path an object receives, whenever that path is one the cache composed itself from a
provider name and a parent chain, through a single arbitration owner; no other writer shall decide
a contended derived address on its own authority.

**FR-ADDR-002 — the bijection.** After every mutation on both the full-scan and the
incremental-delta route, the cache shall hold at most one stable backend id at each cache path and
at most one cache path for each stable backend id, with no stable id left mapped to a path that no
longer holds it.

**FR-ADDR-003 — order independence over the unit's final contents.** When two or more distinct
stable ids claim one derived cache path within one evidence unit, the cache contents and the
announced facts at the close of that unit shall be identical for every permutation of the unit's
claims, including the permutations in which a claimant's children are applied before that claimant
has lost and in which the losing claimant is applied first.

**FR-ADDR-004 — a loser's subtree is never bound under the winner.** At the close of an evidence
unit, no entry whose resolved parent chain passes through a displaced claimant shall be cached,
listed, stat-able or announced under the winning claimant's path; such entries shall be reported as
displaced alongside their claimant.

**FR-ADDR-005 — nothing leaves silently.** When any cache writer removes or withholds a live
occupant, a live claimant, or any of their descendants because another stable id holds that cache
path, the cache shall name the contended path, the admitted id, the withheld id, every displaced
descendant path and the reason in the value returned by the call that caused it, and shall emit one
warn-level log for that contended address.

**FR-ADDR-006 — settled at the close of the evidence unit.** A contention observed part-way through
an evidence unit shall not be final: it shall be settled against the facts held at the close of the
complete unit, so a tombstone for the admitted id arriving later in the same unit readmits the
withheld claimant; and nothing about that settlement shall survive the unit.

**FR-ADDR-007 — nothing is lost.** Every object that existed on the provider before a contention was
observed shall still exist on the provider afterwards and shall be reachable in the vault once
synced, unless the user deleted it. No object shall be deleted, emptied, truncated or made
permanently unreachable in order to free a cache address, on any route, including every failure path
of the remediation. Where a claimant is not in the synced folder at all — the orphan-collapse case —
"not lost" means untouched on the provider.

**FR-ADDR-008 — the contention is repaired at the source.** When two claims that are both
provider-resolved contend for one cache address, the plugin shall rename on the provider the
claimant that is not to keep that address, to the address produced by `insertConflictSuffix`
(`conflict.ts:60-67`) with a discriminator derived from that claimant's own stable id, as an action
of the existing `rename_remote` kind authorized by Admission from current-cycle facts. Where a
contending claim is not provider-resolved, no rename shall be performed for it.

**FR-ADDR-009 — nothing is committed while a claimant is withheld.** When a cycle observes a
contention for which a remediation is owed, that cycle shall be checkpoint-blocked: the remote
cursor shall not advance, the derived cache shall not be committed, and the working view shall be
aborted, so the next cycle re-derives the same evidence unit from the last committed checkpoint.

**FR-ADDR-010 — displaced is not deleted; genuinely gone is still deleted.** The remote delta shall
not report as deleted any path whose absence is attributable to a displacement decided within the
same evidence unit. A path whose object the provider really removed, and a path whose parent left
the tracked root, shall continue to be reported as deleted.

**FR-ADDR-011 — the user is told, on default settings.** When a sync cycle observes at least one
contended cache address, the plugin shall surface, as a non-error fact distinct from the error
count, how many addresses were contended, through a surface visible to a user who has changed no
settings; and the contended paths with both stable ids shall be recoverable from the log without
reproducing the failure. `enableLogging` is `false` by default (`settings.ts:74`) and
`showSyncNotifications` is also `false` (`settings.ts:73`, `orchestrator.ts:230-233`), so the log
and the cycle summary each reach only users who opted in; the status bar (`main.ts:287-304`) is the
only unconditional per-cycle surface.

**FR-ADDR-012 — the shape is pinned for every caching family.** A shared contract case shall pin
"two distinct stable ids resolving to one cache path" at the public filesystem boundary for every
registered caching family, in both provider orderings, asserting the survival of both objects rather
than merely a stable winner; and the central required-contract matrix shall oblige each family to
supply either a collision-producing harness script or a cited non-producibility.

**FR-ADDR-013 — a contention never throws.** Address arbitration shall not throw for a contended
cache path, and every uncontested path shall continue to sync in the cycle that observes a
contention, including the cycles whose checkpoint is blocked. `bulkLoad`'s duplicate-stable-id throw
keeps exactly its current message and breadth and is not extended to duplicate paths: a
deterministic throw classifies as transient (`fs/errors.ts:104`) and burns `MAX_RETRIES` full
enumerations, which is issue #88 verbatim.

### Non-functional requirements

**NFR-ADDR-001 — closed authority set.** No collision record, chosen-address table, disposition,
failure reason, repair queue or recovery marker is persisted; no persistent store and no retained
in-memory correctness owner is added; `AbstractMetadataCache` gains no instance field;
`METADATA_CACHE_VERSION` is not bumped and the `FileRecord` shape is unchanged; no `SyncActionType`,
DAG or recovery queue is added; `sync-state-ownership-guard.test.mjs` and
`sync-admission-authority-guard.test.mjs` stay green with no fixture edits.

**NFR-ADDR-002 — boundary discipline.** The backend-agnostic base contains no provider-specific
branch, predicate or capability hook, and `AbstractMetadataCache` issues no provider request and
holds no client. The identity-addressed rename is an optional filesystem capability in the shape the
codebase already uses for `checkpoint`, never a predicate on backend identity.

**NFR-ADDR-003 — no cache-computed address recorded as provider topology.** No address the cache
computed itself is stored as `actual_resolved` or reaches `exportRecords` or the durable checkpoint
as provider-resolved topology. The disambiguated address is not written to the cache in advance of
the rename; it becomes a cache address only when the provider reports the renamed object. Writing
the invented address ahead of the provider is what made PR #83's two routes reverse each other.

**NFR-ADDR-004 — bounded provider cost.** Resolving a contention costs zero additional provider read
requests on either route. The only provider mutation introduced is one rename per contended address
per cycle, issued from the execution phase as an admitted action, never from the cache or a drain.

**NFR-ADDR-005 — no dependence on unmerged code.** Nothing references `Logger.enabled` or
`src/sync/sync-cycle-diagnostics.ts`. Neither is on main: `50c02c2` (PR #94) is not an ancestor of
`60e85b0`, `src/logging/logger.ts` has no `enabled` member, and the module does not exist.

### Acceptance criteria

| id | criterion | requirements |
|---|---|---|
| AC-ADDR-001 | After every mutation on both routes one cache path maps to exactly one stable id, and `getPathById`, `idAt` and `exportRecords` agree in both directions with no stranded id | FR-ADDR-001, FR-ADDR-002 |
| AC-ADDR-002 | The same two Drive siblings loaded `(id1,id2)` and `(id2,id1)` leave identical cache contents and identical announced facts, on both routes | FR-ADDR-003 |
| AC-ADDR-003 | With a displaced folder, `list()` contains no path under the winner belonging to the loser's subtree and `stat()` returns null for any such path, in both permutations including the one where the loser's child precedes its parent's loss | FR-ADDR-004, FR-ADDR-003 |
| AC-ADDR-004 | No cache writer removes or withholds a live occupant, claimant or subtree without a returned fact naming path, admitted id, withheld id, descendants and reason, plus one warn line per contended address | FR-ADDR-005 |
| AC-ADDR-005 | A tombstone for the admitted id later in the same drain readmits the withheld claimant and withdraws the contention before publication; the drain result equals the reverse-page-order result | FR-ADDR-006, FR-ADDR-003 |
| AC-ADDR-006 | After the repair, both objects exist on the provider and both are reachable in the vault — the keeper at the plain address, the other at `insertConflictSuffix(path, "id-" + id)`; on the rename-failure, rename-impossible and orphan-collapse paths every object that existed before still exists | FR-ADDR-007 |
| AC-ADDR-007 | Two provider-resolved claims produce exactly one `rename_remote` naming the non-keeper's provider identity and the suffixed target; a contention involving a `requested_echo` claim produces no provider mutation at all | FR-ADDR-008 |
| AC-ADDR-008 | A cycle owing a remediation does not call `commitCheckpoint`, does call `abortWorkingView`, leaves the cursor at its previous value, and is followed by a cycle that re-observes the same evidence unit | FR-ADDR-009 |
| AC-ADDR-009 | For the measured snapshot fixture `RemoteDelta.deleted` contains none of `docs`, `docs/a.md`, `docs/b.md`; a folder moved outside the tracked root still names its paths in `deleted`; after a forced 410 with a bare-name-collapsed orphan in the checkpoint that orphan's old path is absent from `deleted` | FR-ADDR-010 |
| AC-ADDR-010 | A colliding cycle on `DEFAULT_SETTINGS` surfaces a non-error contended count in the status bar distinct from the error count, one warn line per contended address naming both ids, and no additional lines under a 500-descendant displaced folder | FR-ADDR-011 |
| AC-ADDR-011 | The shared two-ids-one-path and survival cases run for every registered family in both orderings or record a cited non-producibility, and the composition root still fails to compile on a missing cell | FR-ADDR-012 |
| AC-ADDR-012 | Arbitration never throws; in a checkpoint-blocked cycle every uncontested path still syncs; `bulkLoad`'s throw keeps its current message and breadth | FR-ADDR-013 |
| AC-ADDR-013 | `METADATA_CACHE_VERSION` is 4, `FILES_STORE` keeps `keyPath: "path"`, `exportRecords` keeps its row shape, no collision record / disposition / recovery marker / repair queue / persistent store / new cache field exists, no `SyncActionType` is added, both AST guards stay green with no fixture edits | NFR-ADDR-001 |
| AC-ADDR-014 | `AbstractMetadataCache` issues no provider request and carries no backend-specific branch; the identity rename is an optional capability implemented only by Google Drive; resolving a contention adds zero provider reads with at most one rename per contended address per cycle | NFR-ADDR-002, NFR-ADDR-004 |
| AC-ADDR-015 | No cache-computed address is stored as `actual_resolved` or exported as provider topology; the disambiguated address appears in the cache only after the provider reports it; no source file references `Logger.enabled` or `sync-cycle-diagnostics.ts` | NFR-ADDR-003, NFR-ADDR-005 |

### Non-goals

- Changing Dropbox or OneDrive production behaviour.
- Any `IndexedDB` schema change, `METADATA_CACHE_VERSION` bump or migration code.
- A `PathAuthority` branded type, schema or AST enforcement mechanism.
- An AST ownership guard for cache address assignment.
- A consent prompt, setting or opt-out for the provider rename.
- A provider-liveness probe, a retained withheld claimant, or any other cross-cycle carrier.
- Adding a `SyncActionType`, a DAG, or a recovery queue.
