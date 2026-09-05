# ADR 0001 — The remote metadata cache is subordinate to commit-last state

**Status:** Accepted · 2026-06-07 · **Revised 2026-09-04** (the only durable authorities are the clean remote checkpoint and successful per-file `SyncRecord`; the live cache/cursor/scope is an attempt-bounded derived working view that must commit or abort; prior same-session recovery flags and state C are superseded)
**Context area:** sync pipeline / Google Drive backend
**Related:** [sync-pipeline.md → Crash recovery](../sync-pipeline.md), [google-drive-backend.md](../google-drive-backend.md)

**2026-09-05 scheduling clarification:** [Fact-first component Admission](adr-20260905-fact-first-component-admission.md)
supersedes the historical flat transfer/conflict/structural phases, pooled structural
deletes, and global one-action-per-path arguments below. Independent singleton
transfers/same-key matches settle before globally serial ordered components; each action
publishes before its successor, and priority work is drained/deferred across that interval.
This changes execution ordering, not A/B ownership or provider cache mutex/CAS mechanics.
Per-file publication compares exact captured source and destination records atomically;
parent relocation consumes existing successful child receipts without another owner.
No writer or orchestrator field is added. The state ownership AST inventory remains closed.
Ordinary and renamed conflicts now share resolver capture/preservation followed by
executor-owned original-path effects and exact terminal publication. Removal of the
legacy conflict executor removes `conflict.ts` from Store readers/imports only. No
correctness authority is added; input byte witnesses live in the current result and
are discarded with the attempt. Interrupted merges use current-fact re-observation,
not a compensating rollback or persisted recovery instruction.

## Context

Sync correctness has exactly **two authoritative durable states** (A and B). Each is
written **last** after the work it describes succeeds.

| | State | Where | Commit rule |
|---|---|---|---|
| **A** | Incremental-sync position (delta cursor `changesStartPageToken`) | the backend's IndexedDB store (`META_STORE`), **co-located with the file-map cache** | Advanced **only on a fully clean cycle** (`failed === 0`), committed in the **same transaction** as the cache. |
| **B** | Per-file sync state (`SyncRecord`) | sync state store | Written **per file, only after** that file's push/pull/delete succeeds (`plan-executor.ts`: IO → then `commitAction`). |

The remote filesystem may advance a live cache/cursor/scope while observing or executing
one attempt. That view is **derived, attempt-bounded state**, not a correctness authority:

- a wholly clean attempt publishes it with `commitCheckpoint()`;
- every incomplete returned attempt and every pre-closeout exception discards it with
  `abortWorkingView()`;
- abort changes no provider or durable store state, and the next ordinary access reloads
  A (or observes no checkpoint and uses COLD);
- the executor waits for all already-scheduled sibling effects to settle before an error
  reaches abort, so no late sibling can mutate an abandoned view.

Process restart and same-process retry therefore follow the same rule: rebuild from A and
B plus current local/remote facts. COLD, WARM, and HOT are ordinary acquisition strategies,
not recovery statuses. The orchestrator must not remember a prior error to select an action
or acquisition mode.

The Google Drive backend additionally keeps an **IndexedDB metadata cache** (the
`path↔id` map in `GoogleDriveMetadataCache`, persisted via `MetadataStore`). It is
**not authoritative**: it is a performance optimization that lets
`list`/`stat`/`read`/`getChangedPaths` avoid a network re-list, and it is fully
derivable: a `fullScan()` rebuilds it from Google Drive (the real authority).

We have repeatedly introduced bugs by **treating this optimization as if it were
authoritative state and over-engineering its persistence**:

- **Eager persist** (pre-`cc7d9b5`): the cache was written to IndexedDB the moment a
  delta applied, while the cursor commits last. A crash left the cache **ahead** of the
  cursor; the replay's `removed` handler early-returned on the now-absent path, so an
  un-pulled **remote deletion was lost forever**.
- **Swallowed persist failure** (found in review of `cc7d9b5`): `commitCheckpoint`
  caught and logged a failed flush but still cleared its buffer while the orchestrator
  advanced the cursor — leaving the cache **behind** the committed cursor, the same lost
  deletion by the opposite path.
- **Bundled micro-optimizations** (a no-op `commitCheckpoint` early-return; a per-caller
  cache-clobber that stranded an `idToPath` entry) added branches and subtle reasoning
  to a correctness-critical path for negligible benefit.

## Decision

1. **The metadata cache is non-authoritative.** The only authoritative durable sync
   states are **A** (the clean-cycle cursor) and **B** (the per-file `SyncRecord`).
   Google Drive remains remote truth; never reason about sync correctness from the cache.

2. **Every checkpoint-capable attempt must close its live working view.** A clean attempt
   commits; every other returned outcome aborts; an exception aborts before classification
   or retry. Durable checkpoint queries describe the store, never the uncommitted live
   cursor. No prior-failure flag, recovery mode, pending ledger, or third runtime correctness
   owner may substitute for this lifecycle.

3. **The cache has exactly one invariant: it must be a complete derived projection
   co-committed with the cursor.** On a clean cycle `CachingRemoteFs` captures the final
   live cache under `cacheMutex`, and `MetadataStore.saveAll` atomically replaces every
   cache row and its metadata with the cursor. No touched-path set, pending-full-persist
   flag, or other mutation bookkeeping participates in correctness. A failed flush
   propagates and commits neither projection nor cursor.

4. **Prefer simple-and-correct over optimized-and-subtle.** The cache flush should do one
   obvious thing. Convergence — not lockstep machinery — is the safety net.

5. **Any future optimization to cache persistence MUST**
   - preserve invariant (3) — never let the cache outrun, or lag, the committed cursor;
   - **fail safe** — a persistence error propagates (the cursor does not advance), it is
     never swallowed into a "success";
   - ship with a **test that pins the safety property**, not just the happy path.

## Consequences

**Resolved — the cursor is co-located with the cache (single source of truth).** The
cursor lives in the backend's IndexedDB store (`META_STORE`), committed in the **same
transaction** as the complete file-map (`MetadataStore.saveAll`). There is
no second store and no write ordering, so the earlier "millisecond two-store window"
(cursor in `settings`, cache in IndexedDB) is **gone** — cache and cursor are atomically
in step, or both absent.

This **supersedes** the earlier decision to keep the cursor in `settings` for
"IndexedDB-loss resilience." That resilience was illusory: **losing the cursor converges
anyway.** An empty/cursor-less store ⇒ no checkpoint ⇒ a cold full list × `SyncRecord`
baseline join (with md5 comparison) that re-derives **every** change, including in-place
content edits. So co-locating removes the window at no real cost — the only consequence
of a rare IndexedDB loss is one extra cold reconcile, which the design already handles.
The earlier `ensureInitialized` "cursor present, cache empty" rebuild path is removed
(that state can no longer occur).

The 2026-09-04 repair invalidates both persisted views once: metadata cache v3→v4
drops the stale cursor/projection, and SyncState v7→v8 drops path identity that may have
been committed against that defective projection. Each database uses its ordinary
drop-and-recreate schema policy independently. This is not a cross-store transaction,
migration, recovery status, or third authority; the following no-checkpoint,
no-baseline cycle reconstructs both authorities from current local and remote facts.
In any later cycle, if Windows/Obsidian exposes two vault-index casing aliases, the raw
local adapter first resolves the one physical spelling. Observation records only the
exact/alias endpoints, stat-authoritative remote target absence, unique remote identity,
and direct-read content facts. Admission normalizes that component and alone authorizes
the remote rename when hash, size, scope, and identity proof are complete. The decision
does not depend on COLD/WARM/HOT acquisition, global record count, or prior failure.
This proof is cycle-local and adds no durable or in-memory state owner.

On a backend/folder switch or disconnect the store — cursor **and** cache together — is
cleared alongside `settings.backendData` and SecretStorage, so no stale checkpoint
lingers (`disconnect` clears it; an identity change drops it via the freshly-built FS's
`resetCheckpoint()`). The Rescan action likewise discards the checkpoint through the live
FS (`resetCheckpoint()`), not by editing settings.

**Prohibited patterns** (each previously caused or risked a real bug):
- eager / mid-cycle cache persistence;
- swallowing a cache-persist failure and continuing to advance the cursor;
- treating the cache as authoritative for change detection or deletion;
- treating caller-requested spelling as provider topology. `requested_echo` may refresh
  metadata only at an identity's current resolved path; it must not re-key that identity
  or descendants. Only provider-resolved metadata or a successfully completed explicit
  rename endpoint may change the derived topology;
- persisting or retaining a prior failure, Admission disposition, quarantine, recovery mode,
  or pending-operation marker as input to a later decision;
- returning or retrying without first aborting an incomplete working view, or aborting while
  already-scheduled sibling effects can still mutate it;
- using `resetCheckpoint()` for ordinary attempt failure. Reset is the destructive Rescan /
  identity-change operation; attempt abort must preserve the committed checkpoint;
- **pooling `conflict` actions with transfer-phase writes.** Conflict resolution mints a
  **planner-invisible** `.conflict` sibling path (`conflict.ts` `generateConflictPath` →
  `duplicate`) via cross-filesystem existence probing and writes it to both sides. The
  one-action-per-path invariant does not cover that sibling, so co-pooling conflict with
  `push`/`pull` can clobber a concurrently-pushed same-named file and wakes the dormant
  `withCacheMutex` new-path guard. Conflict runs in its **own serial phase**
  (`plan-executor.ts`), after transfers and before structural ops;
- adding locks/lockstep for a **phantom** race. Note the boundary precisely, because
  `cacheMutex` is **not** phantom: `syncMutex` serializes whole *cycles*, not the actions
  *within* a cycle, and the transfer phase (push/pull) runs under `AsyncPool(5)` (structural deletes pool too) — so
  concurrent `ensureFolder`/cache mutations on the live `path↔id` map are real and
  `cacheMutex` is **required**. (The earlier claim here that "concurrent writers do not
  exist" was wrong.)

  The three-phase `withCacheMutex` **stale-guard** is **not** a phantom lock either, and
  is **retained** (T7 concluded — 2026-06-09). It is not a lock at all: it is the
  **compare-and-swap of an optimistic protocol**. The phase split releases `cacheMutex`
  during the phase-2 network call (so transfer-phase uploads run concurrently instead of
  serializing on the mutex for the duration of each upload); that release is what makes
  the phase-1 view of the cache potentially stale by phase 3. The guard is the *compare*
  — re-read `idAt(path)` under the mutex phase 3 already holds, write only if it still
  equals the phase-1 `expectedId`. It adds **zero** serialization beyond that phase-3
  acquisition and cannot deadlock, so it is categorically unlike the prohibited
  "lockstep machinery."

  T7's finding on **reachability**: under the current architecture the guard is
  **unreachable** — it never fires in production. The proof is a chain of invariants the
  *types do not enforce*: (1) `syncMutex` serializes cycles; (2) within a cycle, detect
  (`collectChanges` → `list`/`getChangedPaths`, the **only** delta re-key path) is fully
  awaited **before** execute (`executePlan`), so **no delta ever runs during a phase-2
  network call** — the scenario the old comments named ("a concurrent delta re-pointing
  the same path") *cannot occur*; (3) in execute the only parallel cache-*mutating writer*
  is `push`=`write` (the transfer phase; pooled deletes use the separate inline delete guard,
  see (4)); concurrent writes target **disjoint file paths**
  (one plan action per path), and a write's only cross-path cache mutation is
  `ensureFolder` on **ancestor folder paths**, which can never coincide with another
  write's *file* path (no path is both a file and a folder in one consistent vault
  state); (4) `rename_remote` runs **serially** in the structural phase's remote lane.

  **Revised 2026-06-15 (executor lane/tier rescheduling).** `delete_remote` is **no longer
  serial** — it now runs **pooled** in the structural phase's remote lane (after renames
  drain). This **splits the two guards**:
  - The `withCacheMutex` **write/rename** stale-guard stays **dormant**, by the same proof:
    the only parallel cache-*mutating* writer is still `push`=`write` (point 3), and
    `rename_remote` is still serial. `conflict` — which would add a second parallel writer —
    is kept in its **own serial phase** (it mints a planner-invisible `.conflict` sibling, see
    Prohibited patterns), so it never runs concurrently with a transfer-phase write.
  - The **inline delete CAS guard** (`remote-fs.ts`, `delete()` phase 3) is now **ACTIVE /
    reachable**, deliberately. Its live producer is the legitimate folder+descendant case: a
    `delete_remote(folder)` and `delete_remote(folder/child)` legitimately coexist in one plan
    (folder deletes are not coalesced), and pooled they overlap. The guard makes this safe —
    the folder delete's `removeTree` synchronously evicts the child's cache entry, so the child
    delete's phase-1 `idAt` returns undefined and **short-circuits with no remote call**
    (`if (!fileId) return`); the reverse interleaving is caught by the phase-3
    `idAt(path) === fileId` re-check (a stale `removeTree` is skipped). This matters because
    Google Drive's `deleteFile` **re-throws 404** (Dropbox/OneDrive swallow not_found/404), so
    a double remote-delete would otherwise surface a spurious failure; worst case it is caught
    per-action into `result.failed` and the next cycle plans nothing (the path is gone) —
    self-healing.

  So keep the write/rename guard as **defense-in-depth for invariants the type system can't
  express**: a future change parallelizing `rename_remote`, a concurrent remote-browse outside
  `syncMutex`, or a plan emitting two actions for one path degrades from **silent cache
  corruption** to a logged skip + next-cycle re-detect. Its dormancy still rests on **one plan
  action per path** + serial renames + conflict-not-pooled; the now-active delete guard's
  correctness rests on `removeTree`'s synchronous descendant eviction.

**Pinned by tests** (keep these green; extend them, do not weaken them):
- `orchestrator.test.ts` → *"does not advance the committed cursor when the checkpoint
  flush (cache persist) fails"* (the flush throws ⇒ the post-checkpoint persist step is
  skipped), *"aborts an observation attempt before classifying its error"*, and
  *"replays from the committed cursor after aborting a failed working view"*. Together
  these pin commit-or-abort ordering and same-process replay without a recovery flag.
- `sync-cycle-finalization.test.ts` pins exhaustive returned-outcome closeout: Admission
  rejection, failed/blocked execution, missing terminal proof, and `checkpointBlocked`
  abort; only a wholly clean result commits.
- `plan-executor.test.ts` pins settle-before-throw for fatal parallel work.
- `remote-backend-contracts.test.ts` runs the shared live-view abort/reload contract for
  Google Drive, Dropbox, and OneDrive.
- `index.test.ts` → *"GoogleDriveFs.commitCheckpoint persistence-failure safety"*,
  *"re-reports an un-pulled remote DELETION after a crash…"*, *"treats an empty store as
  no checkpoint: full-scans fresh and warrants no replay"*, and the rest of the
  *"cursor consolidation (crash safety)"* suite.
- `metadata-store.test.ts` → *"saveAll atomically replaces the complete file map and
  metadata"* (the atomic complete-cache+cursor co-commit).
- **T7 stale-guard disposition.** The guard *mechanism* is pinned by
  `googledrive/index.test.ts` / `dropbox/index.test.ts` → the *"stale-cache guard(s)"*
  suites (a cache re-key injected mid-phase-2 ⇒ the phase-3 write is skipped with a
  warning). Its *dormancy* rests on **one plan action per path**, pinned by
  `decision-engine.test.ts` → *"emits exactly one action per path across every action
  type"* and `plan-admission.test.ts` → *"shapes disconnected local and remote renames
  without disturbing ordinary order"*. Breaking that invariant (a plan emitting two
  Group-A actions for one path) is
  what would wake the write/rename guard — these tests fail the day it does.
- **Lane/tier rescheduling (2026-06-15).** The now-**active** delete CAS guard's
  overlapping-delete behavior is pinned by `googledrive/index.test.ts` → *"delete()
  short-circuits (no client.deleteFile) when the cache already lost the path"*. That
  `conflict` stays out of the transfer pool (keeping the write/rename guard dormant) is
  pinned by `plan-executor.test.ts` → *"a pushed `.conflict` sidecar is not clobbered by a
  same-cycle conflict's duplicate"*, with the phase-barrier / lane-concurrency tests in the
  same file pinning the schedule. Cross-ref [ADR 0006](0006-remote-rename-detection-is-order-independent.md):
  rename *detection* is order-independent; rename *execution* stays serial — orthogonal.
