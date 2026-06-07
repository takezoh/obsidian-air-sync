# ADR 0001 — The remote metadata cache is subordinate to commit-last state

**Status:** Accepted · 2026-06-07
**Context area:** sync pipeline / Google Drive backend
**Related:** [sync-pipeline.md → Crash recovery](../sync-pipeline.md), [google-drive-backend.md](../google-drive-backend.md)

## Context

Sync correctness rests on **two, and only two, authoritative states**, both committed
**last** (after the work they describe has succeeded):

| | State | Where | Commit rule |
|---|---|---|---|
| **A** | Incremental-sync position (delta cursor `changesStartPageToken`) | `settings.backendData` | Advanced **only on a fully clean cycle** (`failed === 0`). |
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
   _behind_) the committed cursor.** Operationally: the cache flush and the cursor
   advance are **one commit-last unit** — flush the cache, *then* advance the cursor, and
   if the flush fails, **propagate the error so the cursor is not advanced** (do not
   swallow). On the next run the cache and cursor are still in step, so the replay
   re-detects any un-flushed work (a remote deletion in particular).

3. **Prefer simple-and-correct over optimized-and-subtle.** The cache flush should do one
   obvious thing. Convergence — not lockstep machinery — is the safety net.

4. **Any future optimization to cache persistence MUST**
   - preserve invariant (2) — never let the cache outrun, or lag, the committed cursor;
   - **fail safe** — a persistence error propagates (the cursor does not advance), it is
     never swallowed into a "success";
   - ship with a **test that pins the safety property**, not just the happy path.

## Consequences

**Accepted tradeoff — the millisecond two-store window.** The cursor lives in
`settings`, the cache in IndexedDB; they cannot be written in one atomic transaction, so
a hard crash in the ~ms between the two writes can momentarily desync them. This is
**deliberately not "fixed"**: keeping the cursor in `settings` (not in IndexedDB
alongside the cache) is what lets the cursor **survive an IndexedDB loss** and drive a
cheap file-map rebuild (`ensureInitialized`'s "cursor present, cache empty" path). Moving
the cursor into IndexedDB to close the window would trade that resilience away — it
relocates the tradeoff rather than removing it. `cc7d9b5` already shrank the window from
"the whole cycle" (eager persist) to "two adjacent awaits" (commit-last); that residual
is accepted.

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
  flush (cache persist) fails"* and *"…when a cycle has failures"*.
- `index.test.ts` → *"GoogleDriveFs.commitCheckpoint persistence-failure safety"*,
  *"re-reports an un-pulled remote DELETION after a crash…"*, and the
  *"cursor consolidation (crash safety)"* suite.
