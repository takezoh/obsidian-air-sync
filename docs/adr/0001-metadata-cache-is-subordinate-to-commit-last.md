# ADR 0001 — The remote metadata cache is subordinate to commit-last state

**Status:** Accepted · 2026-06-07 · **Revised 2026-06-07** (cursor single-holding: co-located with the cache; supersedes the earlier "keep the cursor in settings" tradeoff)
**Context area:** sync pipeline / Google Drive backend
**Related:** [sync-pipeline.md → Crash recovery](../sync-pipeline.md), [google-drive-backend.md](../google-drive-backend.md)

## Context

Sync correctness rests on **two, and only two, authoritative states**, both committed
**last** (after the work they describe has succeeded):

| | State | Where | Commit rule |
|---|---|---|---|
| **A** | Incremental-sync position (delta cursor `changesStartPageToken`) | the backend's IndexedDB store (`META_STORE`), **co-located with the file-map cache** | Advanced **only on a fully clean cycle** (`failed === 0`), committed in the **same transaction** as the cache. |
| **B** | Per-file sync state (`SyncRecord`) | sync state store | Written **per file, only after** that file's push/pull/delete succeeds (`plan-executor.ts`: IO → then `commitAction`). |

From these the engine derives its safety property: **a half-finished or crashed cycle
converges by re-running.** One failed action ⇒ the cursor does not advance ⇒ the next
run re-detects the gap. An already-synced file is skipped; an incompletely-synced one is
re-pushed/-pulled/-deleted ⇒ committed ⇒ converged.

The Google Drive backend additionally keeps an **IndexedDB metadata cache** (the
`path↔id` map in `DriveMetadataCache`, persisted via `MetadataStore`). **This is a third
thing, and it is _not_ authoritative.** It is a performance optimization that lets
`list`/`stat`/`read`/`getChangedPaths` avoid a network re-list, and it is fully
derivable: a `fullScan()` rebuilds it from Drive (the real authority).

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

1. **The metadata cache is non-authoritative.** Authority = Drive (remote truth) + **A**
   (cursor) + **B** (`SyncRecord`). Never reason about correctness from the cache; reason
   from A + B + "re-run converges."

2. **The cache has exactly one invariant: it must never be committed _ahead of_ (nor
   _behind_) the committed cursor.** This is now **structural**: the cache and the cursor
   live in the **same IndexedDB store** and commit in **one transaction**
   (`commitDriveCache` → `MetadataStore.saveAll` / `commitIncremental`), so they cannot
   diverge — a failed flush lands neither. A failed flush still **propagates** (the cycle
   surfaces an error and the next run re-detects the un-flushed work), but there is no
   longer a two-store ordering to get wrong, nor a buffer-clear that could outrun a
   failed persist.

3. **Prefer simple-and-correct over optimized-and-subtle.** The cache flush should do one
   obvious thing. Convergence — not lockstep machinery — is the safety net.

4. **Any future optimization to cache persistence MUST**
   - preserve invariant (2) — never let the cache outrun, or lag, the committed cursor;
   - **fail safe** — a persistence error propagates (the cursor does not advance), it is
     never swallowed into a "success";
   - ship with a **test that pins the safety property**, not just the happy path.

## Consequences

**Resolved — the cursor is co-located with the cache (single source of truth).** The
cursor lives in the backend's IndexedDB store (`META_STORE`), committed in the **same
transaction** as the file-map (`MetadataStore.saveAll` / `commitIncremental`). There is
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

On a backend/folder switch or disconnect the store — cursor **and** cache together — is
cleared alongside `settings.backendData` and SecretStorage, so no stale checkpoint
lingers (`disconnect` clears it; an identity change drops it via the freshly-built FS's
`resetCheckpoint()`). The Rescan action likewise discards the checkpoint through the live
FS (`resetCheckpoint()`), not by editing settings.

**Prohibited patterns** (each previously caused or risked a real bug):
- eager / mid-cycle cache persistence;
- swallowing a cache-persist failure and continuing to advance the cursor;
- treating the cache as authoritative for change detection or deletion;
- **terminal-failure "quarantine" that advances the cursor despite a failed action** —
  this violates rule A (one failure ⇒ cursor holds). Keeping genuinely un-syncable inputs
  *out of the pipeline* (e.g. `isSystemJunkFile` for OS-generated files some backends
  reject) is the sanctioned escape valve; silently skipping a real failure is not;
- adding locks/lockstep for concurrent writers that do not exist (the whole cycle is
  serialized by `syncMutex`; document the invariant instead of guarding a phantom race).

**Pinned by tests** (keep these green; extend them, do not weaken them):
- `orchestrator.test.ts` → *"does not advance the committed cursor when the checkpoint
  flush (cache persist) fails"* (the flush throws ⇒ the post-checkpoint persist step is
  skipped) and *"…when a cycle has failures"* (a failed cycle never calls
  `commitCheckpoint`, so the cursor it would advance stays put).
- `index.test.ts` → *"GoogleDriveFs.commitCheckpoint persistence-failure safety"*,
  *"re-reports an un-pulled remote DELETION after a crash…"*, *"treats an empty store as
  no checkpoint: full-scans fresh and warrants no replay"*, and the rest of the
  *"cursor consolidation (crash safety)"* suite.
- `metadata-store.test.ts` → *"commitIncremental upserts, deletes, and writes meta in one
  transaction"* (the atomic cache+cursor co-commit).
