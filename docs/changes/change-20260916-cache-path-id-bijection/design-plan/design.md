# One owner for cache-path assignment, and an upstream repair (issue #90)

<!-- anchor: goal -->
## Goal

`AbstractMetadataCache` has no owner for the question *"which cache path does this provider
object get?"*. Three writers answer it independently, and when two distinct stable ids resolve to
one cache path the answer is `setFile`'s occupant branch (`metadata-cache.ts:110-116`):
`removeTree(path)` — no log line, no throw, no entry in any result object. The evicted object, and
everything beneath it if it was a folder, simply never syncs again.

This plan gives derived address assignment one owner, makes every displacement a returned fact,
**repairs the condition at its source by renaming one of the colliding objects on the provider**,
proves that nothing is lost on every path including the failure path, tells the user, and pins the
shape as a shared contract for every caching family.

**The framing that decides which repairs are admissible.**

1. **The destination is a real filesystem.** The vault cannot hold two files at one path; neither
   can Dropbox or OneDrive as sync targets. So *no design can place both objects at the contended
   address*. That is a property of the destination.
2. **The cache's path-keying is therefore not the defect.** `pathToFile` and
   `FILES_STORE(keyPath:"path")` correctly mirror a destination that is itself path-keyed. The
   id-keyed inversion is rejected on principle, not only on measured cost.
3. **The defect is that a source state the destination cannot represent is handled as a
   cache-internal overwrite.** It is a fact about the sync, and it must surface as one.
4. **Because the destination cannot represent it, the source must stop containing it.** The
   repository owner settled this during design: Air Sync renames one of the colliding objects on
   the provider, using the conflict-suffix convention the plugin already uses. The remote vault is
   Air Sync's working area. The one invariant is that **nothing is lost**.
5. **The collision sources are provider-specific without exception.** Duplicate names under one
   parent and `/` inside a name are Google Drive only; orphan collapse to the bare name is a
   shared-base fault in `resolveFilePathCached`; Dropbox's folder replacement is its own
   path-keyed policy and is *correct* for a namespace whose address is the provider key. A
   Drive-shaped rule in the backend-agnostic base is PR #83's closed shape and is not available.

## How reachable this actually is — a scoping finding

Neither the sealed recovery, nor either draft, nor the critique surfaced this, and it governs how
much machinery the remedy deserves.

**The built-in Google Drive connection runs on `drive.file`** (`googledrive/auth.ts:10`:
`const SCOPES = "https://www.googleapis.com/auth/drive.file"`), so it sees only objects Air Sync
itself created. `README.md:53` states the consequence to users in terms: *"The built-in Google
Drive connection can see only the files Air Sync itself uploaded. Files added to the cloud folder
any other way are invisible to Air Sync and never sync… It also includes files already in an
existing folder you pick."* Commit `5361c16` added that warning.

`listAllFiles` and `changes.list` return only what the token can see, so on the built-in backend a
duplicate created on the cloud side is **invisible** and no collision reaches the cache at all.

| mechanism | reachable on the built-in `drive.file` backend? |
|---|---|
| ① duplicate names under one parent | Only when **both** objects are Air Sync's own uploads. A copy made on drive.google.com is a new object the app did not create, and is invisible. Otherwise this needs custom OAuth with the full `drive` scope |
| ② `/` inside a provider name | Effectively no — Air Sync composes names from vault path segments, which cannot contain `/`. Needs full scope |
| ③ orphan collapse to the bare name | **Yes.** No duplicate is needed: one of our own uploads whose parent chain stops resolving is enough, and the fallback is a shared-base fault in `resolveFilePathCached` |
| ④ Dropbox folder replacement | Not Drive, and not a contention — see the Scope section |

**What this changes.** Mechanism ③ — the one every user can reach — is dissolved by the arbiter's
authority tier alone, at no provider cost, with no Drive-specific code, and with **no rename**
(the losing claimant is not in the synced folder, so there is nothing there to repair). Mechanisms
① and ② are largely a custom-OAuth-full-scope surface, and they are the only ones that reach the
remediation path. That is why this plan adds no machinery beyond what the no-loss invariant
requires: the AST ownership guard is cut, the `PathAuthority` enforcement mechanism is deferred,
`rewriteChildPaths` is left alone, Drive's `/`-in-name decline is withdrawn, the provider-liveness
probe both drafts lacked is **not needed at all** under this remedy, and Dropbox and OneDrive get
no production change.

**What it does not change.** It lowers the *frequency* of mechanism ①, not its severity: the
failure mode is a local file deleted while the object that should replace it never arrives.
Frequency governs how much structure is justified; severity governs whether a route may be left
open. The no-loss protections are kept at full strength.

This is also decision context for the repository owner — it may change how issue #90 is
prioritised against its siblings under #81.

<!-- anchor: approach -->
## Approach

**1. One owner for *derived* addresses.** A derived address is one the cache composes itself from
a provider name and a parent chain. A pure, stateless, backend-agnostic arbiter decides which
claimant holds a contended derived address, as a total function of the claim set: a
provider-resolved claim (`actual_resolved`) beats a cache-composed claim (`requested_echo`); among
equals, the lexicographically smallest stable id is admitted.

**2. Assignment is computed over the unit's whole claim set, not per arrival.** The full scan's
evidence unit is the whole enumeration; the delta route's is the whole drain. Order-independence
is stated over the *final contents of the unit*, not over the winner function — the winner
function is already symmetric and is not what fails. A claimant that loses takes its whole
resolved subtree with it, by parent-id ancestry, not by string prefix or by what happened to be
indexed at the moment of arbitration.

**3. Every displacement is a returned fact**, and a displaced path is excluded from `deleted` at
all three producers of that set. Nothing is persisted; nothing is read back by the cache.

**4. The contention is repaired upstream.** When two *provider-resolved* claims contend, Admission
authorizes a `rename_remote` of the object that should not keep the name, to
`insertConflictSuffix(path, "id-" + <its stable id>)` — the convention users already meet through
conflict resolution. Both objects then exist at distinct addresses and both sync.

**5. Nothing is committed while a claimant is withheld.** A cycle that observed a remediable
contention is checkpoint-blocked, so the working view aborts and the delta replays from the last
committed cursor. This is existing machinery (`sync-cycle-finalization.ts:47`, `:74`, `:81-84`),
and it is what makes the cross-drain tombstone failure structurally unreachable — with no
provider probe, no retained state and no new completion kind.

**6. The user is told** — a bounded warn naming the path and both ids, a non-error count in the
cycle summary, and a status-bar clause, because the log and the summary are both off by default.

<!-- anchor: scope -->
## Scope

**In scope.** `src/fs/caching/` (a new arbitration module, `metadata-cache.ts`, `id-delta.ts`,
`remote-fs.ts`), `src/fs/interface.ts`, a new Admission stage under `src/sync/`, the
`rename_remote` execution path, an identity-addressed rename capability on the Google Drive
filesystem, the signal hop through `src/sync/` and `src/main.ts`, and the shared contract under
`tests/fs/`.

**Explicitly out of scope, with reasons.**

- **Dropbox production code.** Dropbox cannot produce the condition: `extractId` is
  `entry.id ?? entry.path_lower` (`dropbox/metadata-cache.ts:51`), so the address *is* the provider
  key, and `setEntry`'s path-keyed last-write-wins eviction is the correct reading of a provider
  that told you the object at that address changed identity. Folding it into a shared arbiter
  applies a remedy for a condition it cannot have, and reverses what
  `dropbox/metadata-cache.test.ts:92-98` and `:100-116` pin. See
  [adr-derived-vs-provider-keyed-address-domain](#adr-derived-vs-provider-keyed-address-domain).
- **OneDrive production code.** OneDrive is path-unique in practice and
  `unknown-onedrive-duplicate-names` is unsettled. Its matrix cell is a cited non-producibility.
  If that unknown settles positive, OneDrive gains the same capability and inherits the same
  contracts unchanged — nothing here is Drive-shaped except the capability's implementation.
- **`rewriteChildPaths`' missing occupant check.** All five callers compensate today, and it
  *propagates* an address already decided rather than assigning one. Building on it would be
  structure without a witness. Any new caller inherits the obligation the existing five discharge.
- **A `METADATA_CACHE_VERSION` bump or any IndexedDB schema change.** One object holds each path
  under this remedy too, so the `FileRecord` shape is untouched and the no-migration rule never
  fires. Independently re-derived; not re-litigated.
- **A provider-liveness probe on the delta route.** Both drafts lacked a carrier for the
  cross-drain tombstone case, and the two admissible carriers were a provider re-observation or a
  byId-primary cache. The upstream remedy retires the question — see
  [contract-no-loss-remediation](#contract-no-loss-remediation) — so neither is built.
- **An AST ownership guard for cache address assignment.** Cut; see
  [contract-enumeration-uniqueness-conformance](#contract-enumeration-uniqueness-conformance) for
  what covers the same defect and what cutting costs.
- **A `PathAuthority` branded type / schema / AST enforcement mechanism.** Deferred; the
  obligation stays as [NFR-ADDR-003](#nfr-addr-003). No main-today violation is constructible.
- **A consent prompt, setting or opt-out for the rename.** The owner withdrew the authorization
  objection: the remote vault is Air Sync's working area.
- **Anything from PR #94.** `Logger.enabled` and `src/sync/sync-cycle-diagnostics.ts` are not on
  main (`50c02c2` is not an ancestor of HEAD `60e85b0`).

---

# Requirements

<!-- anchor: fr-addr-001 -->
### FR-ADDR-001 — one owner for derived address assignment

THE shared metadata cache SHALL decide which cache path an object receives, whenever that path is
one the cache composed itself from a provider name and a parent chain, through a single
arbitration owner; no other writer SHALL decide a contended derived address on its own authority.

*Why "derived".* Address assignment is deciding a path from provider facts. Dropbox's `path_lower`
is not derived — it is the provider's own address, and a second id arriving at it is provider
topology, not a contention. Scoping the owner by *address provenance* rather than by backend is
what keeps a per-backend predicate out of the backend-agnostic base.

*The writer inventory, as it is on HEAD.* `setFile`'s occupant branch (`:110-116`) is the
destructive response and the single index-mutation seam every route reaches. `bulkLoad`
(`:155-173`) has **no** address rule of its own: it validates stable-id uniqueness, throws on a
duplicate id, and calls `setFile` in a loop, inheriting whatever `setFile` decides.
`rewriteChildPaths` (`:340`) propagates a decided rename. `DropboxMetadataCache.setEntry`
(`:112-119`) is the provider-keyed replacement policy, and `DropboxMetadataCache.buildFromFiles`
(`:147-154`) overrides the base and reaches `setEntry` → `setFile` directly, so **Dropbox's full
scan never passes `bulkLoad`** — which is why the owner cannot live there.

<!-- anchor: fr-addr-002 -->
### FR-ADDR-002 — the bijection

THE shared metadata cache SHALL, after every mutation on both the full-scan and the
incremental-delta route, hold at most one stable backend id at each cache path and at most one
cache path for each stable backend id, with no stable id left mapped to a path that no longer
holds it.

<!-- anchor: fr-addr-003 -->
### FR-ADDR-003 — order independence, stated over the unit's final contents

WHEN two or more distinct stable ids claim one derived cache path within one evidence unit, THE
cache contents and the announced facts at the close of that unit SHALL be identical for every
permutation of the unit's claims — including the permutations in which a claimant's children are
applied before that claimant has lost, and in which the losing claimant is applied first.

*Why this wording.* A symmetric winner function does not make the cascade symmetric.
`resolveFilePathCached` (`:292-337`) resolves every entry's path from `byId` independently of the
cache, and `buildFromFiles` then applies the results in listing order, so *whether the loser's
children were already indexed under the contended path* is itself order-dependent. Loading
`docs=d1{a.md,b.md}` and `docs=d2{x.md}` as `(d1,c1,c2,d2,c3)` leaves `docs/x.md=c3` cached under
the winner; loading `(d2,c3,d1,c1,c2)` `removeTree`s it. `RB-CHK-003` ("Provider event order MUST
NOT alter the result") fails in the first order. Binding the claim to the unit's final contents is
what makes the obligation falsifiable at the public boundary.

<!-- anchor: fr-addr-004 -->
### FR-ADDR-004 — a loser's subtree is never bound under the winner

AT the close of an evidence unit, no entry whose resolved parent chain passes through a displaced
claimant SHALL be cached, listed, stat-able or announced under the winning claimant's path; such
entries SHALL be reported as displaced alongside their claimant.

*Trace.* Issue #90 acceptance clause: *"does not bind a child under a different folder than its
own parent."*

<!-- anchor: fr-addr-005 -->
### FR-ADDR-005 — nothing leaves silently

WHEN any cache writer removes or withholds a live occupant, a live claimant, or any of their
descendants because another stable id holds that cache path, THE cache SHALL name the contended
path, the admitted id, the withheld id, every displaced descendant path and the reason in the
value returned by the call that caused it, and SHALL emit one warn-level log for that contended
address.

The fact is a **return value**. A retained field the cache reads back would be the second
in-memory correctness owner `AGENTS.md` bars.

<!-- anchor: fr-addr-006 -->
### FR-ADDR-006 — a contention is settled at the close of its evidence unit

A contention observed part-way through an evidence unit SHALL NOT be final: it SHALL be settled
against the facts held at the close of the complete unit — the whole enumeration for
`buildFromFiles`, the whole drain for `applyIncrementalChanges` — so that a tombstone for the
admitted id arriving later in the same unit readmits the withheld claimant; and nothing about that
settlement SHALL survive the unit.

This is also the answer to `unknown-single-upsert-distinguishability`: a single upsert need not
distinguish a genuine second object from a re-key, because the unit's close does.

<!-- anchor: fr-addr-007 -->
### FR-ADDR-007 — nothing is lost

EVERY object that existed on the provider before a contention was observed SHALL still exist on
the provider afterwards, and SHALL be reachable in the vault once synced, unless the user deleted
it. NO object SHALL be deleted, emptied, truncated or made permanently unreachable in order to
free a cache address, on any route, including every failure path of the remediation.

This is the load-bearing requirement of this plan. It is stronger and more checkable than "the
bijection holds": the bijection is satisfied by destroying one object, and that is exactly the
defect. Where a claimant is not in the synced folder at all — the orphan-collapse case, where the
cache guessed a bare name for an object whose parent chain never reaches the sync root — "not
lost" means *untouched on the provider*: it is not renamed, not removed, and it was never destined
for the vault.

<!-- anchor: fr-addr-008 -->
### FR-ADDR-008 — the contention is repaired at the source

WHEN two claims that are both provider-resolved contend for one cache address, THE plugin SHALL
rename, on the provider, the claimant that is not to keep that address, to the address produced by
the existing conflict-suffix convention with a discriminator derived from that claimant's own
stable id — as an action of the existing `rename_remote` kind, authorized by Admission from
current-cycle facts.

WHERE a contending claim is not provider-resolved, NO rename SHALL be performed for it: it is an
address the cache guessed for an object outside the bound sync root, and Air Sync's working area
does not extend to it.

*Naming.* `insertConflictSuffix` (`conflict.ts:60-67`) already accepts a string discriminator, so
`Test.md` becomes `Test.conflict-id-<stableId>.md`. The convention is established, users already
meet it through conflict resolution, and it is human-reversible. It is not parseable as a
conflict *preservation* address — `directConflictCandidateHint` (`:72-84`) matches only
`[0-9a-f]{64}`, and the `id-` prefix contains a non-hex character, so a disambiguation address can
never be mistaken for a preserved-version address. That separation is deliberate.

<!-- anchor: fr-addr-009 -->
### FR-ADDR-009 — nothing is committed while a claimant is withheld

WHEN a cycle observes a contention for which a remediation is owed, THAT cycle SHALL be
checkpoint-blocked: the remote cursor SHALL NOT advance, the derived cache SHALL NOT be committed,
and the working view SHALL be aborted, so the next cycle re-derives the same evidence unit from
the last committed checkpoint.

*What this closes, and why no probe is needed.* Both drafts withheld the losing claimant and
discarded it at the close of the drain. One drain later, the admitted object's tombstone arrives
alone, `removeTree` runs while fetching changes, the `hasFile` split at `remote-fs.ts:376-387`
finds the path absent and pushes it to `deleted`, which becomes `checkpoint_deleted` and satisfies
the `delete_local` gate at `identity-component-decision.ts:568-569` — while the withheld object is
live on the provider. The cursor advances normally, so nothing forces a full scan and nothing
self-heals.

That chain requires a **committed cursor advance past a withheld claimant**. This requirement
makes that state unreachable: the withheld claimant either stops existing (the rename succeeded,
so the next cycle sees two distinct addresses) or the cycle does not commit and the same evidence
unit is replayed. No provider re-observation and no retained claimant is needed, which is why
neither carrier from the pass-2 analysis is built.

*Mechanism.* `sync-cycle-finalization.ts:47` already takes `checkpointBlocked` as an input to
cleanliness; `:74` commits only when clean and `:81-84` abort otherwise. No new completion kind
and no new lifecycle is introduced. An orphan-collapse contention owes no remediation
(FR-ADDR-008) and therefore does **not** block the checkpoint.

<!-- anchor: fr-addr-010 -->
### FR-ADDR-010 — displaced is not deleted; genuinely gone is still deleted

THE remote delta SHALL NOT report as deleted any path whose absence is attributable to a
displacement decided within the same evidence unit. A path whose object the provider really
removed, and a path whose parent left the tracked root, SHALL continue to be reported as deleted.

*Both halves are load-bearing.* `id-delta.ts`'s `oldPath && !newPath` branch has two causes. Its
comment is explicit — *"Moved outside the tracked root (parent no longer resolves) → surface as
deleted"* — and that is correct: the object really has left the sync scope, and suppressing it
strands a local orphan with a live `SyncRecord`. The other cause is a displaced parent's
later-arriving child, which must not become a deletion. The discriminator is membership in *this
unit's* displacement set: a current fact of the cycle, never a stored marker.

<!-- anchor: fr-addr-011 -->
### FR-ADDR-011 — the user is told, on default settings

WHEN a sync cycle observes at least one contended cache address, THE plugin SHALL surface, as a
non-error fact distinct from the error count, how many addresses were contended, through a surface
visible to a user who has changed no settings; and the contended paths with both stable ids SHALL
be recoverable from the log without reproducing the failure.

**The signal is stated by every cycle that observes a contention and by no other cycle.** Under
FR-ADDR-009 a remediable contention is re-observed every cycle until it is repaired, so the
recurrence question that both drafts left open answers itself for the case that matters. An
orphan-collapse contention, which owes no remediation and does not block the checkpoint, is stated
once by the cycle that observes it and again by every cycle that re-enumerates; the standing
condition is otherwise visible as the object's continued absence from the vault. Persisting the
fact is barred and a per-cycle re-derivation would require an enumeration, so those are the only
two honest options and this picks the first.

*What was verified about the surfaces, because it changes the answer.* `Logger.log` returns early
when `enableLogging` is false (`logging/logger.ts:73-76`) and `DEFAULT_SETTINGS.enableLogging` is
`false` (`settings.ts:74`), so a log-only design tells the default user nothing. **And the cycle
summary is gated the same way**: `orchestrator.ts:230-233` calls `notify` only when
`showSyncNotifications` is true, and that defaults to `false` (`settings.ts:73`). A count in
`buildNotificationMessage` alone therefore does not close this requirement either — a point the
critique's graft assumed. The one surface this plugin updates on every cycle with no setting is
the status bar (`main.ts:287-304`, driven by `onStatusChange`).

<!-- anchor: fr-addr-012 -->
### FR-ADDR-012 — the shape is pinned for every caching family

A shared contract case SHALL pin "two distinct stable ids resolving to one cache path" at the
public filesystem boundary for every registered caching family, in both provider orderings,
asserting **the survival of both objects** rather than merely a stable winner; and the central
required-contract matrix SHALL oblige each family to supply either a collision-producing harness
script or a cited non-producibility naming the reason or the unsettled unknown.

*Trace.* `docs/issue/issue-20260916-no-shared-contract-pins-enumeration.md` records that none of
the four shared contracts checks enumeration uniqueness today, that
`tests/fs/remote-backend-contracts.test.ts:16-48` makes only a *missing registration* a compile
error, and that `id-delta.ts` and `metadata-cache.ts` have no unit tests at all. Neither AST guard
references `metadata-cache.ts`.

<!-- anchor: fr-addr-013 -->
### FR-ADDR-013 — a contention never throws, and the rest of the vault keeps syncing

THE address arbitration SHALL NOT throw for a contended cache path, and every uncontested path
SHALL continue to sync in the cycle that observes a contention, including the cycles in which the
checkpoint is blocked by FR-ADDR-009.

*Why throwing is not available.* `bulkLoad`'s existing duplicate-stable-id throw is what made
issue #88's full scan fail three times before giving up: a deterministic throw classifies as
transient (`fs/errors.ts:104`) and burns `MAX_RETRIES` full enumerations. That throw keeps exactly
its current message and breadth and is **not** extended to duplicate paths.

<!-- anchor: nfr-addr-001 -->
### NFR-ADDR-001 — closed authority set

THIS change SHALL NOT persist a collision record, a chosen-address table, a disposition, a failure
reason, a repair queue or a recovery marker; SHALL NOT add a persistent store or a retained
in-memory correctness owner; SHALL NOT add an instance field to `AbstractMetadataCache`; SHALL NOT
bump `METADATA_CACHE_VERSION` or change the `FileRecord` shape; SHALL NOT add a `SyncActionType`,
a DAG or a recovery queue; and SHALL leave `sync-state-ownership-guard.test.mjs` and
`sync-admission-authority-guard.test.mjs` green with no fixture edits.

<!-- anchor: nfr-addr-002 -->
### NFR-ADDR-002 — boundary discipline

THE backend-agnostic base SHALL contain no provider-specific branch, predicate or capability hook,
and `AbstractMetadataCache` SHALL issue no provider request and hold no client. The
identity-addressed rename SHALL be an optional filesystem capability in the shape the codebase
already uses for `checkpoint`, absent on backends that do not implement it, never a predicate on
backend identity.

<!-- anchor: nfr-addr-003 -->
### NFR-ADDR-003 — no cache-computed address recorded as provider topology

NO address the cache computed itself SHALL be stored as `actual_resolved` or reach `exportRecords`
/ the durable checkpoint as provider-resolved topology. In particular the disambiguated address is
never written to the cache in advance of the rename: it becomes a cache address only when the
provider reports the renamed object, with the provider's own authority.

The obligation stands; the enforcement *mechanism* is deferred. On main today the recorded labels
are measurably not wrong — `path-authority.ts:26,30` returns `requested_echo` for an unresolvable
parent and `actual_resolved` only for a chain reaching the root, and
`googledrive/metadata-cache.test.ts:410-421` pins it — so a branded type, a schema and an AST guard
would enforce a label that is not currently forgeable. This is the exact mistake PR #83 made, and
writing the invented address ahead of the provider is what made its two routes reverse each other.

<!-- anchor: nfr-addr-004 -->
### NFR-ADDR-004 — bounded provider cost

RESOLVING a contention SHALL cost zero additional provider *read* requests on either route. The
only provider mutation this change introduces is one rename per contended address per cycle,
issued from the execution phase as an admitted action, never from the cache or from a drain.

<!-- anchor: nfr-addr-005 -->
### NFR-ADDR-005 — no dependence on unmerged code

NO part of this change SHALL reference `Logger.enabled` or `src/sync/sync-cycle-diagnostics.ts`.
Neither is on main: `50c02c2` (PR #94) is not an ancestor of HEAD `60e85b0`,
`src/logging/logger.ts` has no `enabled` member, and the diagnostics module does not exist — and it
would live under `src/sync/`, which `src/fs/**` does not import.

---

# Components

<!-- anchor: component-address-arbiter -->
## component-address-arbiter

`src/fs/caching/address-arbitration.ts` (+ `address-arbitration.test.ts`) — new.

One exported pure function over `(contended path, incumbent claim, arriving claim)` where a claim
is `(stable id, PathAuthority)`. No state, no client, no logger, no `TFile` type parameter, no
import of `AbstractMetadataCache`. Its responsibility states in one sentence: *decide which of two
claims holds a contended derived address.* That is why it is a module rather than a private
method — "the owner is a pure function of the claim set" is checkable from its imports, and
permutation invariance is testable without constructing a cache.

<!-- anchor: component-metadata-cache -->
## component-metadata-cache

`src/fs/caching/metadata-cache.ts` — existing. No new instance field, no change to the five index
maps' shapes or to `exportRecords`' row shape.

- `setFile` returns the displacement when its occupant branch (`:110-116`) evicts a different id,
  instead of returning `void` and destroying silently. Its behaviour is otherwise unchanged, so the
  `requested_echo` re-key guard at `:104-109` and the Dropbox path are untouched.
- `buildFromFiles` (`:246-272`) gains a grouping pass between resolution and `bulkLoad`: it groups
  the resolved claims by path, arbitrates every path with more than one claimant, propagates the
  loss down the resolved parent-id ancestry, and bulk-loads only the survivors. It returns the
  accumulated facts. `bulkLoad` returns the facts `setFile` produced; its duplicate-stable-id throw
  keeps exactly its current message and breadth.
- `applyFileChange` (`:390-416`) arbitrates before `setFile` when the resolved path is held by a
  different live id, and returns enough for its caller to record a withheld claimant.

`resolveFilePathCached`'s bare-name fallback (`:310-328`) is **kept**, not made to decline: a
declined entry has no cache entry but is still in the pre-scan snapshot, so `diffById`'s sweep at
`:429-431` would convert it into `checkpoint_deleted` and `delete_local` — a new instance of
exactly the harm this plan removes. The guess already carries `requested_echo`, so the arbiter's
authority tier demotes it in every listing order without either resolver changing, and
`googledrive/metadata-cache.test.ts:410-421` stays green.

<!-- anchor: component-delta-apply -->
## component-delta-apply

`src/fs/caching/id-delta.ts` — existing.

`IdDeltaResult` gains two per-call collections alongside `changedPaths`, `renamedPaths`, `count`
and `enteredFolderIds`: displacements, and withheld claimants held for the unit. Both are
bookkeeping in exactly the sense `enteredFolderIds` already documents — discarded with the call,
never persisted, never read by the cache. `applyEntry` accumulates displacements and separates the
two causes of `applyFileChange` returning null. A drain-end settlement step readmits withheld
claimants whose contended address is vacant by the close of the drain.

<!-- anchor: component-caching-remote-fs -->
## component-caching-remote-fs

`src/fs/caching/remote-fs.ts`, `src/fs/interface.ts` — existing.

`RemoteDelta` (`:17-21`) gains a contended collection; `IncrementalChangesResult` (`:24-26`)
carries it from the backend; `IncrementalCheckpoint.getChangedPaths` (`interface.ts:127-137`)
widens its return type. `_applyIncrementalChanges`' `hasFile` split (`:374-387`) and `diffById`'s
vanished-id sweep (`:429-431`) both exclude displaced ids. `fullScan` (`:186-202`) hands
`buildFromFiles`' returned facts to `fullScanWithDelta`/`diffById`, so the exclusion has a declared
producer on the full-scan route. Everything stays inside `cacheMutex.run`; `abortWorkingView`
(`:317-325`) and `commitCheckpoint` (`:266-273`) are unchanged.

<!-- anchor: component-contention-admission -->
## component-contention-admission

`src/sync/plan-admission-address-contention.ts` (+ its test) — new.

A sibling of `plan-admission-case-alias.ts`, which is the existing precedent for Admission
originating a `rename_remote` from complete current-cycle facts rather than from a local rename
(`plan-admission-case-alias.ts:105`, `:157`). This stage turns each standing contention into at
most one rename action, decides which claimant keeps the plain address, and reports whether a
remediation is owed so the cycle can be checkpoint-blocked.

<!-- anchor: component-provider-rename -->
## component-provider-rename

`src/sync/types.ts`, `src/sync/plan-executor.ts`, `src/fs/interface.ts`,
`src/fs/googledrive/index.ts` — existing.

`RenameAction` gains an optional provider-identity input, used when the object to rename has no
resolvable cache path. `IFileSystem.rename` is path-addressed (`interface.ts:94`) and cannot name
an object the cache is deliberately not holding, so the rename is issued through an **optional
capability** in the shape `checkpoint` already uses: present on Google Drive, absent elsewhere,
never selected by a backend predicate. `plan-executor.ts:383-384` currently throws for a
`rename_remote` that omits its admitted execution inputs; it gains the branch for a remote-only
namespace repair, which has no local counterpart and no baseline — consistent with `types.ts:222-224`,
where `RecordPublication` already excludes `rename_remote` from record publication.

<!-- anchor: component-contention-signal -->
## component-contention-signal

`src/sync/remote-change-source.ts`, `src/sync/change-detector.ts`, `src/sync/orchestrator.ts`,
`src/sync/sync-notification.ts`, `src/main.ts` — existing.

The contention facts travel by the pattern this codebase already uses for exactly this shape:
`getRemoteChanges` (`remote-change-source.ts:24-42`) already takes an `onIdentityEvidence` callback
and calls it. A sibling optional callback carries the contentions to the orchestrator without
adding a field to `RemoteChanges`, `ChangeSet` or `sync-cycle-planning.ts` — which does not carry
arbitrary extras through today. The orchestrator hands them to Admission, puts the count on
`SyncCycleOutcome` for `buildNotificationMessage`, and passes it to `onStatusChange` for the
status bar.

<!-- anchor: component-shared-contract-conformance -->
## component-shared-contract-conformance

`tests/fs/contracts/caching-remote-fs.contract.ts`, `tests/fs/remote-backend-contracts.test.ts`,
and the three `caching-remote-fs.contract-harness.ts` files — existing.

The cases go in the shared contract body; the per-family collision seam goes on
`CachingRemoteFsHarness` (`caching-remote-fs.contract.ts:10-44`) alongside the existing
`seedFolderWithChild`, `stageRemoteDelete`, `failNextDeltaAfterFirstPage` and `stageMoveIntoRoot`
seams. This is test infrastructure under `tests/fs/`, which `AGENTS.md` already sanctions for
backend-specific construction data — not a production capability hook, which is PR #83's closed
shape.

---

# Contracts

<!-- anchor: contract-derived-address-arbitration -->
## contract-derived-address-arbitration

**Subject.** Which claim holds a contended derived cache address.
**Owner.** [component-address-arbiter](#component-address-arbiter).
**Requirements.** FR-ADDR-001, FR-ADDR-003, FR-ADDR-013, NFR-ADDR-002.

**Decision rules.**
- `rule-same-id` — evidence: the two stable ids. Equal ids yield `no_contest`; the arriving claim
  is an ordinary update. Observable: `observable-arbitration-outcome`.
- `rule-authority-tier` — evidence: each claim's `PathAuthority`. `actual_resolved` is admitted
  over `requested_echo`. This tier is what dissolves the orphan-collapse source without touching
  either resolver: the bare-name guess already carries `requested_echo` (`path-authority.ts:26,30`)
  and a genuine root-level child carries `actual_resolved`, so the guess loses in *every* listing
  order. It also decides, by the same fact, that the guessed claimant is outside the working area
  and owes no rename.
- `rule-lowest-id` — evidence: the two stable ids as strings. When the authority tier ties, the
  lexicographically smallest id is admitted.
- `rule-totality` — never throws for any input, including empty-string ids and identical
  authorities, and never leaves the address unoccupied.

**Why the tie-break's arbitrariness is acceptable.** Under this remedy both objects survive and
both sync; the arbiter decides only *which address each one ends up at*, and the one that moves
gets a recognizable, reversible name. A better-motivated fact — oldest creation timestamp — would
need a new per-backend seam that does not exist uniformly, which is variability bought for no
observable gain.

**Rejected inputs, each with the reason it is unavailable.** Arrival order (`RB-CHK-003`).
Checkpoint incumbency, database version, global record count, prior errors (`AGENTS.md`'s
COLD/WARM/HOT sameness rule). `mtime` (sentinel 0 on folders). Local sync state — the cache has
none and must not acquire any; the *Admission* layer may use the committed `SyncRecord`, and does,
which is where that input legitimately belongs. A provider probe inside the base (`RB-INV-001`).
Throwing on path duplication (issue #88's classification).

**Outcome partition.** `determinate` (one claim admitted, the other withheld), `conflicting` (two
distinct claims at one address — always resolved to a determinate admission plus a withholding),
`inconclusive` unreachable because both claims are in hand at the decision point. Coverage: the
comparison is over exactly two claims and the tiers are total and ordered. Exclusivity:
`no_contest` requires id equality, which the other tiers exclude. Default policy: the address is
always occupied by exactly one claim and the other is always named.

**Invariants.** Pure, total, stateless. `arbitrate(a,b)` and `arbitrate(b,a)` name the same
admitted id.

**Typed failure semantics.** None: the function has no failure outcome.

**Verification.** T0 permutation invariance over claim sets of size 2 and 3, driven exhaustively
rather than sampled; T0 tier 1 beats tier 2; T1 purity and totality including degenerate inputs;
T1 `npm run lint` for the absence of backend imports.

**Witnesses.**
- *Normal (risk: correctness)* — two Drive siblings `Test.md` with ids `f1`, `f2`, both
  `actual_resolved`: the same id is admitted in both argument orders and the other is named.
- *Adversarial (risk: order dependence)* — the orphan-collapse pair: a bare-name-collapsed orphan
  (`requested_echo`) and a genuine root-level child (`actual_resolved`) at `orphan.md`. Tier 1
  admits the root-level child in both orders, and marks the guess as owing no remediation.
  Forbidden: an outcome that depends on which argument is the incumbent.

<!-- anchor: contract-claim-set-assignment -->
## contract-claim-set-assignment

**Subject.** How a whole enumeration's claims become cache contents, and what a displacement is.
**Owner.** [component-metadata-cache](#component-metadata-cache).
**Requirements.** FR-ADDR-001, FR-ADDR-002, FR-ADDR-003, FR-ADDR-004, FR-ADDR-005, FR-ADDR-013,
NFR-ADDR-001, NFR-ADDR-003.

**Operational inputs.**
- `input-resolved-claims` — the `(path, file, PathAuthority)` triples `buildFromFiles` already
  computes at `:255-265`. Owner: `AbstractMetadataCache`. Producer: internal — the existing
  `resolveFilePathCached` + `resolvePathAuthority` pass. Acquired at the start of the enumeration
  unit; required until that unit's `bulkLoad` completes; not preserved; immutable within the unit.
  Stability basis: derived from one `fullList()` result. If unavailable, the scan has already
  failed upstream.
- `input-parent-ancestry` — the `byId` map built at `:247-250`, used to propagate a loss down the
  parent-id chain rather than by string prefix. Same lifetime and owner.

**Decision rules.**
- `rule-group-then-arbitrate` — group the resolved claims by path; a path with one claimant is
  written as today; a path with more than one is arbitrated by
  [contract-derived-address-arbitration](#contract-derived-address-arbitration). Observable:
  `observable-cache-contents`.
- `rule-cascade-by-ancestry` — an entry whose resolved parent chain passes through a withheld
  claimant is itself displaced, transitively, computed over the unit's complete claim set so that
  it does not depend on what had been indexed when arbitration ran. Observable:
  `observable-cache-contents`, `observable-displacement-set`.
- `rule-setfile-never-silent` — `setFile`'s occupant branch keeps its behaviour and returns the
  displacement it caused, naming the path, both ids and the removed descendant paths
  (`collectDescendants` before `removeTree`, the pattern `id-delta.ts` already uses). Observable:
  `observable-displacement-set`.
- `rule-throw-breadth-unchanged` — `bulkLoad`'s duplicate-stable-id throw keeps its current message
  and breadth; no path-duplication throw is added.

**Observable effects.**
- `observable-cache-contents` — scope: the whole cache after the unit. Inputs:
  `input-resolved-claims`, `input-parent-ancestry`.
- `observable-displacement-set` — scope: the value returned by
  `buildFromFiles`/`bulkLoad`/`setFile`. Inputs: `input-resolved-claims`.
- `observable-bijection` — scope: agreement among `exportRecords`, `getPathById`, `idAt` and
  `snapshotPathsById`. No further input: it is a property of the index maps after the unit.

**Semantic profiles triggered.** Outcome partition; scope consistency (the cascade is a global
property of the unit computed from claims that arrive piecewise); contract evolution.

**Outcome partition.** `determinate` — every claim is placed or withheld, and the withholding is
named. `conflicting` — two or more claims at one path, resolved by the arbiter. `unknown` — a
claim whose path cannot be resolved at all; unreachable in `buildFromFiles` because the bare-name
fallback gives every entry some path, and belonging to
[contract-drain-settlement](#contract-drain-settlement) on the delta route. Coverage basis: the
claim set is partitioned by resolved path and each group has exactly one admitted claim.
Exclusivity: a claim is placed or withheld, never both. Precedence: cascade displacement overrides
a claim that would otherwise have been placed, because its parent has no address. Default policy:
a claim that is not placed is named; it is never dropped.

**Contract evolution profile.** Changed surface: `setFile` (`void` → displacement or null),
`bulkLoad` and `buildFromFiles` (`void` → displacement facts). Typed consumers:
`DropboxMetadataCache.buildFromFiles` (`dropbox/metadata-cache.ts:147-154`) overrides the base and
is a second implementer; `CachingRemoteFs.fullScan` (`:198`) and `loadFromCache` (`:235-236`) are
the two production callers of `bulkLoad`; `applyFileChange` (`:414`) is the internal caller of
`setFile`. Compatibility: widening a `void` return is source-compatible, so a caller that ignores
the value still compiles — which is what Dropbox does deliberately. Migration/rollout/rollback:
none; no durable shape changes. Baseline verification: `dropbox/metadata-cache.test.ts:92-98` and
`:100-116` stay green unmodified. Target verification: the new base unit tests.

**Invariants.** After any sequence of `setFile`/`bulkLoad`/`buildFromFiles` calls, every
`(path,id)` in `exportRecords` satisfies `getPathById(id) === path` and `idAt(path) === id`, and
`snapshotPathsById().size === size`. `AbstractMetadataCache` gains no instance field. No
displacement survives the call that produced it. No disambiguated address is written here.

**Typed failure semantics.** `failure-unresolvable-claim` — a claim the resolver cannot place.
Not introduced by this change; the bare-name fallback is retained precisely so this does not
become a new class. No failure here degrades a mandatory outcome, so no approval reference is
required.

**Verification.** T0 both permutations of the nested-collision fixture yield equal `list()`,
`stat()` and displacement sets; T0 the flat pair in both orders; T0 bijection after every mutation;
T1 `bulkLoad` throw breadth unchanged; T1 Dropbox's pinned tests unmodified and green.

**Witnesses.**
- *Normal (risk: silent destruction)* — `buildFromFiles([f1@Test.md, f2@Test.md])` returns one
  displacement naming the path, the admitted id and the withheld id. Forbidden: a `void` return
  with one id gone.
- *Adversarial (risk: order-dependent cascade)* — `docs=d1{a.md,b.md}` vs `docs=d2{x.md}` applied
  as `(d1,c1,c2,d2,c3)` and as `(d2,c3,d1,c1,c2)`. Both permutations must leave `docs/x.md`
  unreachable and the displacement sets equal. Forbidden: `docs/x.md` resolving to `c3` under the
  winning folder in either order. This is the permutation both drafts' mechanisms fail.
- *Adversarial (risk: legacy multi-parent)* — a legacy Drive entry with two in-scope parents
  (`googledrive/list-all.ts:43-49`). `findRelevantParentId` prefers `rootFolderId` and otherwise
  takes any known parent, so its resolved path depends on which parent is in `byId`; the claim-set
  pass must produce the same contents for both orders of `parents[]`.

**Implementation discretion.** `discretion-displacement-accumulator-threading` — see the spine.

<!-- anchor: contract-drain-settlement -->
## contract-drain-settlement

**Subject.** How a drain accumulates, settles and announces contentions.
**Owner.** [component-delta-apply](#component-delta-apply).
**Requirements.** FR-ADDR-003, FR-ADDR-005, FR-ADDR-006, FR-ADDR-010, NFR-ADDR-001.

**Operational inputs.**
- `input-delta-entries` — the normalized `IdDeltaEntry` array per page. Owner: `applyIdDeltaPage`.
  Producer: **external** — the provider's change feed, mapped by the backend's `toEntries`. Source:
  `changes.list` / `/delta`. Acquired per page; required until the drain ends; not preserved;
  mutable between drains and stable within a page. If a page is unavailable the drain throws, the
  cursor is not advanced and the attempt aborts.
- `input-current-cache` — the live working view. Owner: `CachingRemoteFs`. Producer: internal.
  Source: the committed checkpoint plus this drain's own mutations. Required until commit;
  preserved only by `commitCheckpoint` after a wholly clean cycle.

**Decision rules.**
- `rule-withhold-loser` — an upsert whose resolved path is held by a different live id is
  arbitrated; a claimant that is not admitted is not written, its stale entry at its previous path
  is removed (the provider says it is no longer there), and it is recorded as withheld with its
  metadata. Observable: `observable-drain-result`.
- `rule-two-causes-of-null` — when `applyFileChange` returns null, the entry's old path is reported
  as **deleted** unless the entry's resolved parent id is in this unit's displacement set, in which
  case it is reported as **displaced**. Evidence: this drain's displacement set — a current fact,
  never a stored marker. Observable: `observable-drain-result`.
- `rule-settle-at-unit-end` — after the last page, every withheld claimant whose contended address
  is vacant is admitted through the same `applyIdDeltaPage` path, so a folder admitted at
  settlement enters `enteredFolderIds` and is re-listed by the existing `relistTargets` walk.
  Settlement therefore runs before that walk. Observable: `observable-drain-result`.

**Observable effects.** `observable-drain-result` — scope: the published `IdDeltaResult` /
`IncrementalChangesResult` for one drain. Inputs: `input-delta-entries`, `input-current-cache`.

**Outcome partition.** `determinate` — every entry is applied, withheld-then-settled, displaced or
tombstoned, and the result names which. `conflicting` — an address claimed by two live ids inside
the unit. `inconclusive` — an entry whose parent does not resolve and whose parent is *not* in the
displacement set: the out-of-root move, which stays a deletion. Coverage basis: `applyEntry`'s
branches are exhaustive over `(file present?, oldPath?, newPath?)`, and the null case is
partitioned by displacement-set membership. Exclusivity: the displacement set is a set of ids
decided in this unit. Precedence: a later tombstone for an admitted id within the unit withdraws
the contention before publication. Default policy: an entry whose disposition cannot be attributed
to a displacement is classified exactly as today.

**Invariants.** Nothing accumulated survives the drain. `AbstractMetadataCache` gains no field.
The published result for a multiset of entries is independent of how they were split into pages.

**Typed failure semantics.**
- `failure-page-fetch` — external; propagates, the cursor is not advanced, the attempt aborts.
  Unchanged from today.
- `failure-settlement-write` — internal contract violation (a withheld claimant whose address is
  vacant but cannot be placed); fail fast, since it would mean the arbiter is not total.

**Verification.** T0 the folder fixture names the withheld id and both child paths instead of
leaving `changedPaths=["docs"]` alone; T0 a later tombstone in the same drain withdraws the
contention and readmits the claimant; T0 the drain result is equal across page permutations of the
same entry multiset; T0 the out-of-root move still produces a deletion while the later-page
displaced child does not; T1 nothing is retained past the unit.

**Witnesses.**
- *Normal (risk: unreported loss)* — cached `docs=d1` with `docs/a.md`, `docs/b.md`; a delta folder
  `d2` named `docs` arrives. The result names `d1` and both child paths, rather than
  `changedPaths=["docs"]` with two files silently gone.
- *Adversarial (risk: suppressing a correct deletion)* — a folder is moved outside the tracked root
  on Drive. Its children's paths must still appear in `RemoteDelta.deleted`. Forbidden: the whole
  `oldPath && !newPath` branch reclassified as displacement, which strands a local orphan with a
  live `SyncRecord`.
- *Adversarial (risk: late child of a displaced parent)* — the losing folder's child upsert arrives
  on a later page, with the child cached from a previous cycle at its old path. That old path must
  be absent from `deleted`.

**Implementation discretion.** `discretion-withheld-carrier-shape` — see the spine.

<!-- anchor: contract-absence-authority -->
## contract-absence-authority

**Subject.** Which paths the remote delta is allowed to call deleted.
**Owner.** [component-caching-remote-fs](#component-caching-remote-fs).
**Requirements.** FR-ADDR-002, FR-ADDR-005, FR-ADDR-010, FR-ADDR-013, NFR-ADDR-001.

**The producers of `deleted`, enumerated completely.** Draft-1 named two and draft-2 named the
third; the safety clause depends on all three.

1. `remote-fs.ts:374-387` — `_applyIncrementalChanges`' `hasFile` split over `changedPaths`.
2. `remote-fs.ts:429-431` — `diffById`'s vanished-id sweep, the route reached on cursor expiry,
   and the one measured to reach `delete_local`.
3. `id-delta.ts`'s `oldPath && !newPath` branch, which feeds `changedPaths` and therefore
   producer 1.

**Decision rules.**
- `rule-exclude-displaced` — a path whose absence is attributable to a displacement decided in this
  unit is excluded at all three producers. For producer 1 the attribution is the unit's
  displaced-path set; for producer 2 it is the ids `buildFromFiles` reported during the scan that
  `fullScan` hands to `diffById`; for producer 3 it is displacement-set membership of the entry's
  resolved parent id.
- `rule-carrier-is-a-return-value` — the full-scan attribution has a declared producer:
  `buildFromFiles` and `bulkLoad` return the facts and `fullScan` passes them on. Specifying the
  consumer without the producer would leave the safety clause with no carrier on that route.
- `rule-genuine-absence-untouched` — a path whose absence is not attributable to a displacement is
  classified exactly as today.

**Observable effects.** `observable-remote-delta` — scope: one cycle's `RemoteDelta`. Inputs: the
unit's displacement facts and `observable-drain-result`.

**Scope consistency.** The exclusion is a global property of the cycle's delta computed from facts
that arrive per page and per scan; it is applied once, at publication, from the unit's settled
displacement set — never incrementally from a partial view.

**Outcome partition.** `determinate` — every changed path is modified, deleted, renamed or
displaced. `unknown` — an absence whose cause cannot be attributed; classified as today, which is
a deletion. This is deliberate in both directions: attribution failure must never *upgrade* an
absence, and must never suppress one. `inconclusive` — none. Coverage: every path in `changedPaths`
reaches exactly one branch. Precedence: displacement attribution beats the `hasFile` split.
Default policy: unattributed absence behaves exactly as main does today.

**Contract evolution profile.** Changed surface: `RemoteDelta` (`remote-fs.ts:17-21`),
`IncrementalChangesResult` (`:24-26`), `IncrementalCheckpoint.getChangedPaths`
(`interface.ts:127-137`). Typed consumers: `getRemoteChanges` (`remote-change-source.ts:29`) and
every backend's `fetchChanges`. Compatibility: the new member is additive. Rollout: single change,
no flag. Rollback: removing the member restores today's behaviour. Baseline verification:
`remote-fs.contract.test.ts` (313 lines) stays green. Target verification: the new cases.

**Invariants.** No file under `src/sync/` decides an absence. The cursor still advances only on a
wholly clean cycle. `abortWorkingView` and `commitCheckpoint` are unchanged.

**Typed failure semantics.** `failure-unattributed-absence` — treated as today's deletion. It is a
degradation route for FR-ADDR-010 in principle, bounded by the fact that the only known
unattributed route is the cross-drain case, which
[contract-no-loss-remediation](#contract-no-loss-remediation) removes by preventing a commit while
a claimant is withheld.

**Verification.** T0 the measured snapshot fixture yields an empty `deleted` for `docs`,
`docs/a.md`, `docs/b.md`; T0 a genuine remote deletion still reaches `deleted`; T0 after a forced
410 with a bare-name-collapsed orphan in the checkpoint, `RemoteDelta.deleted` does not contain
that orphan's old path; T1 no file under `src/sync/` decides absence.

**Witnesses.**
- *Normal (risk: silent loss)* — the folder-collision snapshot fixture: none of the three paths
  reported deleted, all three reported displaced.
- *Adversarial (risk: cursor-expiry route)* — seed a checkpoint containing a bare-name-collapsed
  orphan, force a 410, and assert `RemoteDelta.deleted` excludes its old path. This is the route
  the issue document's own five-step chain misses and the one measured to reach `delete_local`.

<!-- anchor: contract-no-loss-remediation -->
## contract-no-loss-remediation

**Subject.** Repairing the contention at the source, and proving nothing is lost on every path.
**Owner.** [component-contention-admission](#component-contention-admission).
**Requirements.** FR-ADDR-007, FR-ADDR-008, FR-ADDR-009, FR-ADDR-011, FR-ADDR-013, NFR-ADDR-001,
NFR-ADDR-003, NFR-ADDR-004.

**Operational inputs.**
- `input-standing-contentions` — this cycle's contended addresses with the admitted id, the
  withheld id and each claim's authority. Owner: `SyncOrchestrator`. Producer: internal —
  `observable-remote-delta`. Source: the change-collection callback. Acquired once per cycle;
  required until the plan is admitted; not preserved. If unavailable the cycle simply has no
  contention.
- `input-committed-record` — the committed `SyncRecord` at the contended path. Owner:
  `SyncStateStore`. Producer: internal. Source: `stateStore.getMany`. Acquired at planning;
  required until admission; preserved by the store's own rules. `AGENTS.md` explicitly permits a
  decision to depend on a component's current endpoints and its committed `SyncRecord`, which is
  why this input is legitimate *here* and is refused inside the cache.
- `input-rename-capability` — whether the remote filesystem offers an identity-addressed rename.
  Owner: the filesystem. Producer: internal, an optional capability. Acquired at planning; not
  preserved. If absent, no remediation is owed and no rename is planned.

**Decision rules.**
- `rule-remediable` — a contention is remediable only when **both** claims are provider-resolved
  and `input-rename-capability` is present. A contention involving a `requested_echo` claim is
  *not* remediable: the guessed claimant is outside the bound sync root, Air Sync's working area
  does not reach it, and nothing there is at risk. Observable: `observable-remediation-plan`.
- `rule-keeper` — the claimant that keeps the plain address is the one holding a committed
  `SyncRecord` at that path; if neither holds one, it is the claimant the arbiter admitted. At most
  one claimant can hold that record, because records are path-keyed, so the choice is a function of
  the unordered claim set plus committed state and is identical under COLD, WARM and HOT.
  Observable: `observable-remediation-plan`.
- `rule-target-address` — the other claimant is renamed to
  `insertConflictSuffix(contendedPath, "id-" + <that claimant's stable id>)`. The discriminator is
  the object's own identity, so the target is a function of the unordered claim set, is stable
  across retries (making the rename idempotent), needs no content fetch, and is meaningful for a
  folder. Observable: `observable-remediation-plan`.
- `rule-block-until-repaired` — when a remediation is owed, the cycle is checkpoint-blocked, so the
  cursor does not advance, the cache is not committed, and the working view aborts
  (`sync-cycle-finalization.ts:47`, `:74`, `:81-84`). Observable: `observable-cycle-commit`.
- `rule-existing-vocabulary` — the remediation is one `rename_remote` action per contended address.
  No `SyncActionType` is added, no DAG, no recovery queue, and a failed action blocks its suffix
  exactly as today.

**Observable effects.**
- `observable-remediation-plan` — scope: the actions admitted for one cycle. Inputs:
  `input-standing-contentions`, `input-committed-record`, `input-rename-capability`.
- `observable-cycle-commit` — scope: whether the checkpoint committed. Inputs:
  `input-standing-contentions`.
- `observable-both-objects-present` — scope: the vault and the provider after the repair has
  landed. Inputs: `input-standing-contentions`.

**The no-loss argument, path by path.** This is the proof FR-ADDR-007 asks for.

1. *Repair succeeds.* Both objects exist on the provider at distinct addresses; the cycle is
   checkpoint-blocked anyway, so the working view aborts and the next cycle re-derives from the
   last committed checkpoint. The replayed evidence unit contains the withheld claimant's original
   upsert **and** the rename we performed, so it lands at the disambiguated address and the keeper
   keeps the plain one. Both sync. Nothing is lost.
2. *Repair fails* (permission, provider error, the target address itself occupied). The action
   fails, the cycle is not clean for that reason too, the working view aborts, and the next cycle
   replays the same unit and retries. Because the target address is derived from the claimant's own
   id, the retry is idempotent. Nothing is committed while a claimant is withheld, so no absence is
   ever announced for it. Nothing is lost; the repair is delayed.
3. *Repair is never possible* (the capability is absent, or the provider permanently refuses). The
   cursor stalls at the last committed value and the same unit replays each cycle. The rest of the
   vault continues to sync, because the delta is still applied to the working view and every
   uncontested action still executes (FR-ADDR-013). The user is told each cycle (FR-ADDR-011). The
   escape is the user's: rename or remove one object on the provider, or fix permissions. This is
   the same shape as main's current behaviour for this condition, with the difference that it is
   now named rather than being an unexplained `Sync: 1 error`.
4. *Contention is not remediable* (orphan collapse). No rename is performed, no checkpoint block is
   applied, and the guessed claimant is untouched on the provider. It was never destined for the
   vault — its parent chain does not reach the sync root — so "not lost" means exactly that it is
   left alone. The user is told.
5. *The admitted object is deleted before the repair lands.* The tombstone arrives in the same
   replayed evidence unit as the withheld claimant's upsert, so
   [contract-drain-settlement](#contract-drain-settlement)'s unit-end settlement readmits the
   claimant at the plain address and the contention is withdrawn before publication. No rename is
   needed and nothing is lost.

**Why `issue-cross-drain-tombstone-deletes-local` is retired.** That failure requires a committed
cursor advance past a withheld claimant: the winner's lone tombstone in a later drain, with no
memory of the loser. `rule-block-until-repaired` makes that state unreachable — a withheld claimant
either stops being withheld (the rename landed) or the cycle does not commit. Path 5 above covers
the intra-unit case and path 2 the failure case. Neither pass-2 carrier — a provider re-observation
in the announcing drain, or a byId-primary cache keeping the loser addressable — is built, because
neither is needed once the source condition is repaired and the commit is gated. Both are recorded
as considered in [adr-upstream-rename-remedy](#adr-upstream-rename-remedy).

**Outcome partition.** `determinate` — the contention is remediable and a rename is planned, or it
is not remediable and none is. `conflicting` — two provider-resolved claims, the condition itself.
`unknown` — the capability is absent, so remediability cannot be established; treated as not
remediable, announced, and not checkpoint-blocking (there is nothing the cycle could do
differently). `inconclusive` — none. Coverage basis: a contention has exactly two claims, each
either provider-resolved or not, and the capability is present or not. Exclusivity: a contention
plans at most one rename. Precedence: unit-end settlement withdraws a contention before any
remediation is planned. Default policy: when remediability cannot be established, do nothing to
the provider and say so.

**Invariants.** No `SyncActionType` is added. The disambiguated address is never written to the
cache before the provider reports it. Nothing about a contention, a disposition or a failure reason
is persisted; every cycle re-derives from current facts. A non-remediable contention never blocks
the checkpoint.

**Typed failure semantics.**
- `failure-rename-refused` — external (permission, provider error). The action fails; the cycle is
  not clean; the working view aborts; the next cycle retries idempotently. No Requirement is
  degraded: FR-ADDR-007 holds on this path by construction.
- `failure-target-occupied` — external and effectively unreachable, since the target embeds a
  unique provider id. Treated as `failure-rename-refused`.
- `failure-capability-absent` — internal configuration fact, not an error. No rename, no block, and
  the contention is announced. This *does* leave FR-ADDR-008's repair undelivered for such a
  backend; it is bounded by the fact that only Google Drive can produce the condition, and it is
  recorded against `unknown-onedrive-duplicate-names`.

**Verification.** T0 the keeper choice is identical for both orders of the claim pair and for both
COLD and HOT temperatures; T0 the target address is a function of the claimant's id alone and is
stable across two planning runs; T0 a remediable contention produces exactly one `rename_remote`
action and sets the checkpoint block; T0 an orphan-collapse contention produces no action and no
block; T0 a failed rename leaves the checkpoint uncommitted and the working view aborted; T1 the
two-cycle fixture ends with both objects present at distinct paths; T2 `npm run test:e2e:google`.

**Witnesses.**
- *Normal (risk: data loss)* — two Drive siblings named `Test.md`. After two cycles the vault holds
  `Test.md` and `Test.conflict-id-<id>.md`, and Drive holds both objects. Forbidden: either object
  absent from either side, or `Test.md` in `RemoteDelta.deleted` while both are live.
- *Adversarial (risk: an established file being renamed)* — one claimant has a committed
  `SyncRecord` at the contended path and the arbiter admitted the *other*. `rule-keeper` must
  choose the recorded one, so the user's established file keeps its name and the newcomer moves.
  Forbidden: the recorded claimant being the one renamed.
- *Adversarial (risk: order dependence in the repair)* — the same pair presented in both provider
  orderings must produce the same keeper, the same target address and the same admitted action.
- *Adversarial (risk: repairing outside the working area)* — an orphan-collapse contention must
  produce **no** provider mutation at all. Forbidden: any rename issued for a `requested_echo`
  claimant.
- *Adversarial (risk: committing past a withheld claimant)* — a remediable contention whose rename
  fails must leave `commitCheckpoint` uncalled and `abortWorkingView` called. Forbidden: a
  committed cursor while a claimant is withheld.

<!-- anchor: contract-identity-addressed-rename -->
## contract-identity-addressed-rename

**Subject.** Renaming a provider object the cache is deliberately not holding.
**Owner.** [component-provider-rename](#component-provider-rename).
**Requirements.** FR-ADDR-008, FR-ADDR-007, NFR-ADDR-002, NFR-ADDR-004.

**Why a new addressing input is unavoidable.** `IFileSystem.rename(oldPath, newPath)`
(`interface.ts:94`) is path-addressed, and the object to rename is precisely the one with no cache
path — that is what being withheld means. Renaming the *addressable* claimant instead would leave
the withheld one with nothing to re-announce it, reopening the failure this plan closes. So the
action must carry the provider identity, and the filesystem must accept it. `AGENTS.md` sanctions
this addressing explicitly — *"Exact source/destination CAS is storage mechanism, not identity
policy"*, and *"Only provider-resolved metadata, or the successful endpoint of an explicit provider
rename, may change cached topology."*

**Decision rules.**
- `rule-optional-capability` — the identity-addressed rename is an optional capability on the
  filesystem, in the shape `checkpoint` already uses (`remoteFs.checkpoint` is consulted for
  presence at `remote-change-source.ts:28`). It is not a predicate on backend identity and it adds
  no branch to the backend-agnostic base.
- `rule-endpoint-is-the-authority` — the cache is updated only from the rename's successful
  endpoint, with provider authority; nothing is written in advance.
- `rule-remote-only-inputs` — a namespace-repair `rename_remote` has no local counterpart and no
  baseline. `plan-executor.ts:383-384` currently throws for a rename that omits its admitted
  execution inputs; it gains the branch for this shape. `RecordPublication` already excludes
  `rename_remote` (`types.ts:222-224`), so no record publication is owed. Descendants of a renamed
  folder are not remapped locally, because none of them are synced; they arrive through the next
  cycle's `relistTargets` walk.

**Observable effects.** `observable-provider-rename` — scope: the provider object and the action's
result. Inputs: the action's provider identity and target address.

**Outcome partition.** `determinate` — the rename succeeded or failed. `unknown` — the capability
is absent, so no action is produced and the executor never sees one. `inconclusive` — none.
Coverage: the capability is present or not; the request succeeds or throws. Default policy: absent
capability means no action, never a silent path-addressed fallback that would rename the wrong
object.

**Contract evolution profile.** Changed surface: `RenameAction` (an optional provider-identity
input), `IFileSystem` (one optional capability), `plan-executor`'s `rename_remote` branch. Typed
consumers: the three backends implement `IFileSystem`; only Google Drive implements the capability.
Compatibility: optional on both sides, so no existing backend or action changes. Migration: none.
Rollback: removing the capability makes every contention non-remediable, which degrades to
announce-and-stall, not to loss. Baseline verification: every existing `rename_remote` test stays
green. Target verification: the new executor branch tests.

**Invariants.** The executor never renames by path when a provider identity is supplied, and never
renames by identity when the action carries a resolvable local/remote/baseline triple. No new
`SyncActionType`.

**Typed failure semantics.** `failure-rename-request` — external; propagates as an action failure,
which blocks that action's suffix and makes the cycle non-clean, exactly as any other failed
action.

**Verification.** T0 the executor branch renames by provider identity and returns no record
publication; T0 an action with a provider identity and no local/remote/baseline no longer throws at
`plan-executor.ts:383-384`; T1 a backend without the capability never receives such an action;
T2 `npm run test:e2e:google`.

**Witnesses.**
- *Normal* — a Drive object that has no cache path is renamed by id and the provider reports the
  new name in the next drain.
- *Adversarial (risk: renaming the wrong object)* — the contended path resolves, in the cache, to
  the *keeper*. Renaming by path would move the keeper. The executor must use the provider identity
  and leave the keeper untouched. Forbidden: any path-addressed fallback for this action shape.

<!-- anchor: contract-contention-user-signal -->
## contract-contention-user-signal

**Subject.** What the user is told when two objects contend for one address.
**Owner.** [component-contention-signal](#component-contention-signal).
**Requirements.** FR-ADDR-011, NFR-ADDR-005.

**Operational inputs.** `input-contended-addresses` — the cycle's contended addresses with both
ids. Owner: `SyncOrchestrator`. Producer: internal — `observable-remote-delta`, carried by an
optional callback on `getRemoteChanges`, the same shape as the existing `onIdentityEvidence`.
Acquired once per cycle at change collection; required until the status bar and the summary are
written; not preserved. If unavailable (no checkpoint capability, null delta) the count is zero and
nothing is said.

**Decision rules.**
- `rule-bounded-warn` — each distinct contended address emits at most one `logger.warn` per cycle
  naming the path, both stable ids and the disposition. Emission count is a function of contended
  addresses, never of descendant count. With `logger` undefined the cache behaves identically.
- `rule-non-error-count` — the cycle summary gains a contended clause built by the same counts-only
  idiom as `buildNotificationMessage`'s existing parts (`sync-notification.ts:34-45`), placed so it
  does not read as an error and does not inflate the error count.
- `rule-default-visible-surface` — the status bar, which `main.ts:287-304` updates on every
  `onStatusChange` with no setting gating it, states the count. When a contention is standing and
  there are no errors, its clause takes precedence over the generic partial-cycle text, because the
  cycle is incomplete *for a named reason that is being repaired*.
- `rule-emit-once` — stated by every cycle that observes a contention and by no other. A remediable
  contention is re-observed every cycle until repaired (FR-ADDR-009), so it recurs for as long as
  it matters.

**Observable effects.**
- `observable-warn-line` — scope: one cycle's log. Inputs: `input-contended-addresses`.
- `observable-cycle-count` — scope: one cycle's summary and status bar. Inputs:
  `input-contended-addresses`.

**Outcome partition.** `determinate` — a cycle observes *n* contended addresses and states *n*.
`unknown` — the cycle produced no delta at all (initial sync, no checkpoint); nothing is stated.
Coverage: *n* ≥ 0 and the zero case emits nothing. Default policy: silence only when the cycle
observed nothing.

**Invariants.** The count is a non-error fact: it does not add to the error count, does not set an
error status, and does not stop uncontested paths from syncing.

**Typed failure semantics.** None introduced; a logging failure is already swallowed by `Logger`.

**Verification.** T0 one contended address yields exactly one warn line naming both ids; T0 500
displaced descendants and three repeated identical cycles yield no additional lines; T0 the summary
clause is distinct from the error clause; T0 with default settings the status bar text states the
count; T1 no reference to `Logger.enabled` or `sync-cycle-diagnostics.ts`.

**Witnesses.**
- *Normal (risk: invisible defect)* — a colliding cycle on default settings: the status bar states
  the count. Forbidden: a user on default settings observing nothing at all, which is verbatim the
  defect this requirement exists to remove.
- *Adversarial (risk: unbounded emission)* — a displaced folder with 500 descendants emits one warn
  line, not 501.
- *Adversarial (risk: an error-shaped message for a non-error)* — the contended clause must not
  appear in the error count and must not read as a failure; the cycle that repairs the condition is
  incomplete, not errored.

**Implementation discretion.** `discretion-contended-summary-wording` — see the spine.

<!-- anchor: contract-enumeration-uniqueness-conformance -->
## contract-enumeration-uniqueness-conformance

**Subject.** Where the regression is stopped, for every caching family at once.
**Owner.** [component-shared-contract-conformance](#component-shared-contract-conformance).
**Requirements.** FR-ADDR-012, FR-ADDR-002, FR-ADDR-003, FR-ADDR-004, FR-ADDR-007.

**Cases**, asserted only through `list`/`stat`/`listDir` and the delta result, with no cache
reference and no private-state inspection:

1. Two distinct stable ids at one cache path: one addressable id, the other named in the delta
   result, and `deleted` empty for that path.
2. The same two in the reverse provider ordering: identical observables.
3. A nested collision (`docs=d1{a.md,b.md}` vs `docs=d2{x.md}`) in both permutations, asserting
   that no loser descendant is reachable under the winner and that the displacement sets are equal.
4. Cold-versus-delta parity: the same provider state reached by a full scan and by a delta produces
   the same *collision outcome* — the same addressable id and the same announced facts. It does
   **not** assert identical cached entry sets, because the two routes legitimately hold different
   entries (`resolveFilePathCached` places bare-name orphans that `resolvePathFromCache` declines).
5. No contested path reported deleted, and no `delete_local`, after a cursor expiry.
6. **Survival**: after the repair has landed, both objects are present — the keeper at the plain
   address and the other at `insertConflictSuffix(path, "id-" + id)` — on the provider and in the
   vault. This is the case that pins FR-ADDR-007 rather than merely a stable winner.
7. **No commit while withheld**: a cycle whose remediation fails leaves the cursor at its previous
   value, and the next cycle re-observes the same contention.
8. Drive-specific shapes: `/`-in-name, orphan collapse (asserting **no** provider mutation), and a
   legacy multi-parent entry whose `parents[]` order is varied
   (`googledrive/list-all.ts:43-49`).

**Per-family obligation.** `CachingRemoteFsHarness` (`caching-remote-fs.contract.ts:10-44`) gains
one seam for staging the collision. Google Drive supplies it. **Dropbox records a cited
non-producibility**: its namespace is path-keyed (`extractId` is `entry.id ?? entry.path_lower`,
`dropbox/metadata-cache.ts:51`), so two ids cannot resolve to one address through its own
enumeration; `unknown-dropbox-folder-replacement-contract` is cited alongside because the
repository's own documents leave its folder-replacement contract unresolved in both directions.
**OneDrive records a cited non-producibility** naming `unknown-onedrive-duplicate-names`; a
fabricated fixture would assert a shape the provider may not have. Cases 1-3 and 6-8 run for Drive;
cases 4-5 run for every family that supplies the seam. A missing cell stays a compile error via the
existing `satisfies` at `remote-backend-contracts.test.ts:23-42`.

**Why no AST ownership guard.** A root-level `cache-address-ownership-guard.test.mjs` registered
into `lint:bot-repro`, plus the `docs/code-enforcement.md` and `AGENTS.md` edits the repository
requires in the same change, is a permanent gate on every future commit. The failure it is
justified by — the defect PR #83 shipped, the measured delta-route data loss — is already turned red
by case 2, case 5 and the new `src/fs/caching` unit tests, and the guard would not catch a
semantically wrong winner. **Cost of cutting, stated plainly:** a fourth structural address writer
added outside the owner goes unflagged until a behavioural test catches it.

**Outcome partition.** `determinate` — each family either runs the case or declares a cited gap.
`unknown` — a family whose behaviour under the shape is genuinely unmeasured; it carries the
unsettled unknown's id rather than silence. `inconclusive` — none. Default policy: a missing cell
is a compile error; a declared gap carries a citation.

**Invariants.** No production capability hook is added to the backend-agnostic base by these tests.
No harness holds a cache reference. No existing shared case is weakened. Each new assertion is
load-bearing by a RED-first or mutation witness.

**Verification.** T0 both orderings equal for every family that runs the case; T0 the survival case;
T1 the composition root still fails to compile on a missing cell; T1 `npm run test:coverage`;
T2 `npm run test:e2e:google` and `npm run test:e2e:onedrive`.

**Witnesses.**
- *Normal* — case 1 runs green on this design and red on PR #83's branch.
- *Adversarial (risk: a silently-opted-out family)* — deleting a family's cell must fail
  compilation; replacing it with an empty function must fail review because the field requires
  either a script or a citation.

---

# ADRs

<!-- anchor: adr-cache-address-assignment-owner -->
## adr-cache-address-assignment-owner

**Status: proposed.**

**Decision.** Derived cache-path assignment gets one pure, stateless, backend-agnostic owner. The
admitted claimant is a total function of the claim set: `actual_resolved` over `requested_echo`,
then lexicographically lowest stable id. Assignment is computed over the whole evidence unit's
claim set; a loss cascades down resolved parent-id ancestry; every loss is a returned fact and
never retained state; a withheld claimant never becomes an absence.

**Why not `bulkLoad`.** `DropboxMetadataCache.buildFromFiles` overrides the base and reaches
`setEntry` → `setFile` directly, so Dropbox's full scan never passes `bulkLoad`. And `bulkLoad` has
no address rule of its own to replace. This is an independent reason PR #83's placement could not
have worked, on top of the route asymmetry it was closed for.

**Why not invert the cache key.** Measured across roughly 100 path-addressed production call sites,
three backends, a path-keyed `children` index, and a durable schema change forcing a full
re-enumeration; the cost side was independently re-verified. But the deciding reason is not cost:
the destination is a real filesystem that cannot hold two objects at one address, so path-keying
mirrors the destination correctly and the inversion would make the cache model something the
destination cannot represent.

**Why `rewriteChildPaths` is not folded in.** It propagates an address already decided rather than
assigning one, and every one of its five callers compensates for its missing occupant check today.
Including it would be structure without a witness. Any new caller inherits that obligation.

**Rejected inputs.** Arrival order, checkpoint incumbency, `mtime`, local sync state inside the
cache, a provider probe inside the base, and throwing on path duplication — each refused in
[contract-derived-address-arbitration](#contract-derived-address-arbitration) with its reason.

**Consequences.** `setFile`, `bulkLoad` and `buildFromFiles` widen their return types; Dropbox's
override is a second implementer and deliberately ignores the value; ADR 0001 needs no amendment
because the cache stays a derived projection committed last and the displacement is a return value
inside one evidence unit.

<!-- anchor: adr-derived-vs-provider-keyed-address-domain -->
## adr-derived-vs-provider-keyed-address-domain

**Status: proposed.**

**Decision.** The arbiter's domain is **derived** addresses — those the cache composes from a
provider name and a parent chain. A **provider-keyed** address, where the provider's own address
*is* the stable id, is outside it: `DropboxMetadataCache.setEntry` keeps its path-keyed
last-write-wins replacement unchanged, and Dropbox receives no production change.

**The decision both drafts avoided.** Draft-1's FR-2 routed "every index write" through one
decision while its FR-10 exempted Dropbox — two implementers reading it would diverge. Draft-2
folded `setEntry` into the arbiter and claimed preservation, which the source falsifies: `extractId`
is `entry.id ?? entry.path_lower` (`dropbox/metadata-cache.ts:51`), so a lexicographic tie-break
compares path strings and pins the incumbent, reversing both `dropbox/metadata-cache.test.ts:92-98`
and `:100-116`. Worse than a red test: for a namespace whose address is the provider key, pinning
the incumbent leaves the cache permanently stale after a genuine delete-then-recreate, and Dropbox
never runs `applyIdDeltaPage`, so it has no drain-end settlement to recover from it.

**Why this is not a per-backend predicate.** The domain is a property of the *address*, not of the
backend, and it is enforced by *placement*: arbitration is invoked where derived addresses are
composed — the base's `buildFromFiles` claim-set pass and `applyFileChange` — both of which Dropbox
overrides or never reaches. No predicate, capability hook or backend branch enters
`AbstractMetadataCache`. The alternative shape, parameterising the comparator by address provenance
at runtime, was considered and rejected: it puts provenance-dependent policy inside the shared
comparator, which is a decision the base should not be making per call, and it would leave
Dropbox's behaviour dependent on a tier ordering rather than on its own adapter.

**What the base does when a Dropbox-originated collision reaches `setFile` anyway** — the question
the addendum insists a design must answer. `setFile`'s occupant branch replaces and **returns the
displacement fact**; it no longer destroys silently. Dropbox discards that value, because for a
provider-keyed address the replacement is the provider's own topology rather than a contention, and
it is not counted toward the user-facing contended count and owes no remediation. The observable
outcome Dropbox's tests pin is unchanged.

**Consequences.** FR-ADDR-001 is scoped to derived addresses in its own text rather than being
universal-with-an-exemption. `unknown-dropbox-folder-replacement-contract` stays unsettled and no
position is taken on whether Dropbox's eviction is correct.

<!-- anchor: adr-upstream-rename-remedy -->
## adr-upstream-rename-remedy

**Status: accepted.** Decided by the repository owner during design, ahead of the `consult` step,
and recorded in `owner-decision.md`. It is not a planner inference.

**Decision.** When the provider's namespace contains a state the destination cannot represent —
two provider-resolved objects at one address — **Air Sync repairs the source**: it renames one of
them on the provider, using the conflict-suffix convention the plugin already uses. The remote
vault is Air Sync's working area, and renaming within it for operational reasons is permitted. The
binding invariant is that **nothing is lost**: every object that existed before still exists and is
still reachable afterwards.

Owner's words: 「リネーム方法は duplicate と同じでいいだろう。リモート Vault なので、都合により
リネームしてよい。ロストしないようにするだけ。」

**Considered and rejected — not live alternatives.**

- *A deterministic tie-break with an announcement, and no repair.* One object keeps the address and
  the other is announced and never syncs until the user acts. Rejected as the primary path: it
  leaves a real object permanently unsynced, it leaves a withheld claimant across cycles (which is
  precisely what makes the cross-drain `delete_local` route reachable), and it puts the work on the
  user. Its machinery is **not** eliminated — arbitration still decides who keeps the plain address,
  and the announce-and-stall behaviour is the fallback of
  [contract-no-loss-remediation](#contract-no-loss-remediation) path 3 when the repair cannot be
  performed.
- *A vault-local rewritten address.* The loser is materialised at an invented path inside the
  user's vault (PR #83's `stem (last8ofid).ext`). Rejected: it makes the destination represent
  something it structurally cannot by inventing a name that exists nowhere upstream; the invented
  address is not re-derivable from a delta page's own facts, because the delta resolves the entry
  to its real name, so the guarantee narrows to full-scan-only — which is PR #83's measured
  reversal; and the invented address must be `requested_echo`, so `setFile`'s re-key guard
  (`:104-109`) snaps any later mutation back to the stored path. The upstream rename differs on
  every one of these points: the new name exists on the provider, is reported by the delta with
  provider authority, and is therefore re-derivable on both routes.
- *A provider-liveness re-observation in the drain that announces an absence*, and *a byId-primary
  cache that keeps the withheld claimant addressable*. These were the two admissible carriers for
  the cross-drain failure under a no-repair remedy. Both are retired: with the repair, and with the
  checkpoint gated by FR-ADDR-009, no withheld claimant survives a committed cursor advance, so
  there is nothing to carry. The re-observation would have cost a provider request per vacated
  address on every deletion; the byId-primary cache would have cost a `METADATA_CACHE_VERSION`
  bump, a cold start, a new persistent-store owner and the guard, ADR and enforcement-document
  updates `AGENTS.md` requires with it.

**Costs this carries, stated rather than argued away.**

- **It writes to the user's remote data to repair our own representational limit.** Even for our
  own uploads, the name the user sees in Drive becomes one we chose. The owner has accepted this;
  the plan does not add a consent prompt, a setting or an opt-out.
- **The new name is still chosen by us.** It is mitigated, not eliminated: the form is the
  established `.conflict` convention users already meet through conflict resolution
  (`conflict.ts:60-67`), it is visible *upstream* in Drive's own UI where the user can change it
  rather than being a fabricated entry inside the vault, and it is human-reversible to the base
  name.
- **The repair costs a cycle.** A cycle that owes a repair is checkpoint-blocked, so the condition
  takes two cycles to clear. Contentions are rare (see the reachability finding) and uncontested
  paths keep syncing throughout.
- **It is Drive-only by construction**, because only Drive can produce the condition. No Dropbox or
  OneDrive behaviour is introduced. If `unknown-onedrive-duplicate-names` settles positive,
  OneDrive implements the same optional capability and inherits every contract here unchanged.

<!-- anchor: adr-rename-target-and-discriminator -->
## adr-rename-target-and-discriminator

**Status: proposed.** The owner left these to the integrator, with the constraint that the choice
be a function of the unordered set of claimants.

**Which object is renamed.** The claimant that does **not** hold a committed `SyncRecord` at the
contended path; if neither holds one, the claimant the arbiter did not admit. At most one claimant
can hold that record because records are path-keyed, so the choice is a function of the unordered
claim set plus committed state, and is identical under COLD, WARM and HOT.

*Why the committed `SyncRecord` is a legitimate input here and not inside the cache.* `AGENTS.md`
permits a decision to depend on a component's current endpoints and its committed `SyncRecord`, and
forbids only prior errors, Admission failures, database version, record count and recovery markers.
The cache holds no sync state and must not acquire any, so its arbiter cannot use it; Admission
already reads it for every action it authorizes. Keeping the two decisions separate is what lets
the cache stay a pure projection while the user's established file still keeps its name.

*Rejected: renaming whichever claimant the cache withheld.* Simpler, but it can rename a file the
user has been syncing for months to make room for a newly appeared duplicate, because the arbiter
may not use incumbency as an input. The observable cost of the rejected option is a user's
established `Test.md` becoming `Test.conflict-id-X.md` while a stranger takes the name.

**Which discriminator.** `"id-" + <the renamed claimant's stable id>`, passed to the existing
`insertConflictSuffix(path, seq: number | string)` (`conflict.ts:60-67`).

- It is the object's own identity, so it is a function of the unordered claim set — `RB-CHK-003`
  holds.
- It is stable across retries, so a re-attempted rename targets the same address and is idempotent.
- It needs no content fetch, and it is meaningful for a **folder**, which is one of the collision
  shapes.
- It is unique by the provider's own guarantee, so the chosen address cannot collide with another
  address we are choosing in the same cycle.
- It cannot be mistaken for a conflict *preservation* address: `directConflictCandidateHint`
  (`:72-84`) matches only `[0-9a-f]{64}`, and the `id-` prefix contains a non-hex character, so the
  regex can never match. That separation is deliberate — a disambiguated object is not a preserved
  version and must not be acquired as one.

*Rejected: a sequence number* (`.conflict`, `.conflict-2`). Assignment among several losers depends
on iteration order, which `RB-CHK-003` forbids, and it requires probing the destination namespace.

*Rejected: the content SHA-256*, the form `directConflictCandidateHint` parses. It is
order-independent and reversible, but it requires downloading remote content the cycle has not
fetched, and **a folder has no content**, so it cannot cover one of the two collision shapes.

**Consequences.** The object that moves is the one with no vault history, in the common case. The
renamed object keeps its disambiguated name afterwards even if the other is later deleted: renaming
it back would be a second unrequested rename, and the user may by then rely on the name.

---

# Residual unknowns

- **`unknown-admission-outcome-on-main`** — main's end-to-end Admission outcome for these shapes is
  **unmeasured**. The `conflicting_identity` stall reported in issue #90 was measured on a
  PR-83-rebased worktree and is not main's behaviour. Nothing here depends on Admission failing
  closed as its damage bound. Settled by driving the production admission entry over a two-sibling
  delta on main.
- **`unknown-relist-collision-interaction`** — `relistTargets` feeds a whole re-listed subtree
  through `applyIdDeltaPage` (`83fd2aa`), and moving a folder in on drive.google.com is one of the
  likeliest ways a user creates a collision. That subtree enters the same arbitration and the same
  unit-end settlement, but the interaction is unmeasured. Settled by a fixture that moves a folder
  containing a name collision into the synced root mid-drain.
- **`unknown-onedrive-duplicate-names`** — decides whether OneDrive must implement the rename
  capability. Settled by attempting to create two same-named children under one OneDrive folder
  through the Graph API, in the opt-in e2e.
- **`unknown-dropbox-folder-replacement-contract`** — unresolved in both directions in the
  repository's own documents. This plan takes no position: Dropbox is untouched and the shared
  matrix cites the unknown. Settled by the provider's documented contract or an observed e2e.
- **`unknown-collision-stall-escape`** — narrowed, not closed. The stall is now self-clearing on a
  successful repair; a permanently refused rename stalls the remote cursor while the rest of the
  vault keeps syncing and the user is told each cycle. No recovery machinery is built for it, and
  `AGENTS.md` forbids persisting the failure. Settled by observing a permission-refused rename
  against a real Drive account.
- **`unknown-checkpoint-restore-collision`** — narrowed but not measured. Settled by restoring a
  checkpoint whose rows were written during a contended cycle and asserting the bijection.
