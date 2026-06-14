# ADR 0001 — The remote metadata cache is subordinate to commit-last state

**Status:** Accepted · 2026-06-07 · **Revised 2026-06-07** (cursor single-holding: co-located with the cache; supersedes the earlier "keep the cursor in settings" tradeoff) · **Revised 2026-06-08** (convergence theory: documents state **C** and the third, runtime convergence mechanism `recoverViaColdScan` for same-session failures; corrects the concurrency claim — `cacheMutex` guards a real Group-A race; stale-guard reachability pending T7) · **Revised 2026-06-09** (T7 concluded: the `withCacheMutex` stale-guard is **retained** — it is the compare-and-swap of the mutex-released-during-I/O protocol, not a phantom lock; currently unreachable, kept as defense-in-depth; the phantom "concurrent delta" justification is corrected to the real invariant — one plan action per path) · **Revised 2026-06-14** (clarifies state **C**: the in-memory cursor is the **deferred-commit working state** — held in memory and committed last for crash-safety, *not* a performance optimization — so its overtaking on failure is a byproduct/liability reconciled by `recoverViaColdScan`, not a benefit; corrects the cache-vs-C contrast accordingly)
**Context area:** sync pipeline / Google Drive backend
**Related:** [sync-pipeline.md → Crash recovery](../sync-pipeline.md), [google-drive-backend.md](../google-drive-backend.md)

## Context

Sync correctness rests on **two authoritative, commit-last states** (A and B) — **plus** a
third, **non-authoritative runtime state** (C) whose divergence after a failure must be
reconciled, or convergence does not hold. The two committed states, each written **last**
(after the work they describe has succeeded):

| | State | Where | Commit rule |
|---|---|---|---|
| **A** | Incremental-sync position (delta cursor `changesStartPageToken`) | the backend's IndexedDB store (`META_STORE`), **co-located with the file-map cache** | Advanced **only on a fully clean cycle** (`failed === 0`), committed in the **same transaction** as the cache. |
| **B** | Per-file sync state (`SyncRecord`) | sync state store | Written **per file, only after** that file's push/pull/delete succeeds (`plan-executor.ts`: IO → then `commitAction`). |

From these two the engine derives a safety property — **a half-finished or crashed cycle
converges by re-running** — but the derivation is **not** "A + B, therefore converged."
*How* the gap is re-detected differs by failure mode, and it leans on a third state:

| | State | Where | Behaviour on failure |
|---|---|---|---|
| **C** | The **in-memory** delta cursor (live `_changesPageToken`) **and** the local **dirty-tracker** | the live `IFileSystem` object + `LocalChangeTracker` — both survive across cycles while the plugin runs | **Overtakes** the committed state — a **byproduct of deferral, not an optimization.** The cursor is held in-memory and its commit **deferred to a clean cycle** (commit-last, rule A) for *crash-safety*, not for performance; so it advances during change *detection* regardless of whether the cycle later fails (the dirty-tracker is acknowledged unconditionally, `orchestrator.ts`). A failed cycle never commits, so the advanced value simply **lingers in the live FS object, ahead of what committed**, until `recoverViaColdScan` reconciles it. The overtaking is a liability the cold path pays for, **not a benefit C provides**. |

**Two convergence paths, both load-bearing:**

1. **Crash** (the process dies ⇒ the FS object is rebuilt): the in-memory cursor reloads
   from the **committed** cursor A, so replay restarts at the last clean position and
   re-detects the gap. This is the path the atomicity argument below protects.
2. **Same-session failure** (the FS object lives on): C has already advanced past the
   un-committed work, so a warm delta replay would **miss** the gap and `hasCheckpoint()`
   (which reads the in-memory token) stays true. What recovers it is neither A nor B but
   `recoverViaColdScan = failed > 0` (`orchestrator.ts`), forcing the **next** cycle to
   cold-reconcile (full list × `SyncRecord` baseline join) — catching the gap regardless of
   cursor position. Delete it and a remote-only add/delete, or a push-failed local edit, is
   **silently and permanently dropped for the rest of the session.** FS-level crash tests
   stay green (they rebuild the FS and exercise only path 1); only `orchestrator.test.ts`
   *"forces a cold reconcile on the cycle after a failure"* catches the regression.

An already-synced file is skipped; an incompletely-synced one is re-pushed/-pulled/-deleted
⇒ committed ⇒ converged — via whichever of the two paths the failure mode selects.

The Google Drive backend additionally keeps an **IndexedDB metadata cache** (the
`path↔id` map in `GoogleDriveMetadataCache`, persisted via `MetadataStore`). **This, too, is
_not_ authoritative** (distinct from C: the cache **is** a performance optimization — a
derivable snapshot — whereas C is *not*: it is the deferred-commit cursor lingering as live
divergence). It is a performance optimization that lets
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

1. **The metadata cache is non-authoritative.** Authority = Google Drive (remote truth) + **A**
   (cursor) + **B** (`SyncRecord`). Never reason about correctness from the cache; reason
   from A + B + "re-run converges."

2. **Convergence is a property of A + B + the cold-reconcile-after-failure mechanism — not
   of A + B alone.** Two paths close the gap: a **crash** replays from the committed cursor
   A; a **same-session failure** relies on `recoverViaColdScan` to force the next cycle
   cold. State **C** (the in-memory cursor and the dirty-tracker) is *allowed* to overtake
   the committed state on failure precisely because the cold path re-derives the truth.
   Removing that path because "the committed cursor already holds" is the canonical way to
   re-open silent in-session data loss — and it is invisible to crash-only tests.

3. **The cache has exactly one invariant: it must never be committed _ahead of_ (nor
   _behind_) the committed cursor.** This is now **structural**: the cache and the cursor
   live in the **same IndexedDB store** and commit in **one transaction**
   (`commitGoogleDriveCache` → `MetadataStore.saveAll` / `commitIncremental`), so they cannot
   diverge — a failed flush lands neither. A failed flush still **propagates** (the cycle
   surfaces an error and the next run re-detects the un-flushed work), but there is no
   longer a two-store ordering to get wrong, nor a buffer-clear that could outrun a
   failed persist.

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
- adding locks/lockstep for a **phantom** race. Note the boundary precisely, because
  `cacheMutex` is **not** phantom: `syncMutex` serializes whole *cycles*, not the actions
  *within* a cycle, and Group A (push/pull/match/cleanup) runs under `AsyncPool(5)` — so
  concurrent `ensureFolder`/cache mutations on the live `path↔id` map are real and
  `cacheMutex` is **required**. (The earlier claim here that "concurrent writers do not
  exist" was wrong.)

  The three-phase `withCacheMutex` **stale-guard** is **not** a phantom lock either, and
  is **retained** (T7 concluded — 2026-06-09). It is not a lock at all: it is the
  **compare-and-swap of an optimistic protocol**. The phase split releases `cacheMutex`
  during the phase-2 network call (so Group-A uploads run concurrently instead of
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
  the same path") *cannot occur*; (3) in execute only Group A is parallel, and its only
  cache-*mutating* op is `push`=`write`; concurrent writes target **disjoint file paths**
  (one plan action per path), and a write's only cross-path cache mutation is
  `ensureFolder` on **ancestor folder paths**, which can never coincide with another
  write's *file* path (no path is both a file and a folder in one consistent vault
  state); (4) `rename_remote`/`delete_remote` run **serially** in Group B. So keep it as
  **defense-in-depth for invariants the type system can't express**: if a future change
  violates one (parallelizing Group B, a concurrent remote-browse outside `syncMutex`, or
  a plan that emits two actions for one path), the guard degrades the failure from
  **silent cache corruption** to a logged skip + next-cycle re-detect. Do not re-justify
  it with the phantom "concurrent delta" story; the real (current) producer it would
  guard against is a concurrent Group-A write, and the load-bearing invariant that keeps
  it dormant is **one plan action per path**.

**Pinned by tests** (keep these green; extend them, do not weaken them):
- `orchestrator.test.ts` → *"does not advance the committed cursor when the checkpoint
  flush (cache persist) fails"* (the flush throws ⇒ the post-checkpoint persist step is
  skipped) and *"…when a cycle has failures"* (a failed cycle never calls
  `commitCheckpoint`, so the cursor it would advance stays put). These pin convergence
  **path 1** (the committed cursor holds) — holding alone is *not* sufficient in-session.
- `orchestrator.test.ts` → *"forces a cold reconcile on the cycle after a failure
  (in-memory cursor may have advanced past the committed one)"* — pins convergence
  **path 2 (same-session)**. Deleting `recoverViaColdScan` on the belief that the committed
  cursor alone closes the gap re-opens the silent in-session data loss this ADR exists to
  prevent; the path-1 tests above stay green, so this test is the only guard.
- `index.test.ts` → *"GoogleDriveFs.commitCheckpoint persistence-failure safety"*,
  *"re-reports an un-pulled remote DELETION after a crash…"*, *"treats an empty store as
  no checkpoint: full-scans fresh and warrants no replay"*, and the rest of the
  *"cursor consolidation (crash safety)"* suite.
- `metadata-store.test.ts` → *"commitIncremental upserts, deletes, and writes meta in one
  transaction"* (the atomic cache+cursor co-commit).
- **T7 stale-guard disposition.** The guard *mechanism* is pinned by
  `googledrive/index.test.ts` / `dropbox/index.test.ts` → the *"stale-cache guard(s)"*
  suites (a cache re-key injected mid-phase-2 ⇒ the phase-3 write is skipped with a
  warning). Its *dormancy* rests on **one plan action per path**, pinned by
  `decision-engine.test.ts` → *"emits exactly one action per path across every action
  type"* and `rename-optimizer.test.ts` → *"keeps concurrent Group-A actions on distinct
  paths"*. Breaking that invariant (a plan emitting two Group-A actions for one path) is
  what would wake the guard — these tests fail the day it does.
