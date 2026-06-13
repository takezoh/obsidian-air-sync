# ADR 0004 — Sync re-runs are classified by trigger; the `isSyncing` guard and `syncPending` are load-bearing

**Status:** Accepted · 2026-06-13
**Context area:** sync pipeline / scheduler + orchestrator
**Related:** [ADR 0001](0001-metadata-cache-is-subordinate-to-commit-last.md) (convergence — why a dropped or extra cycle is never a correctness bug, only an efficiency one), [sync-pipeline.md](../sync-pipeline.md), [`TrackerSnapshot`](../../src/sync/local-tracker.ts) (the per-cycle snapshot this decision builds on)

## Context

Three kinds of events ask the engine to sync, and they carry different work:

| Class | Events | What it carries | What it wants |
|---|---|---|---|
| **signal** | `focus`, `visibilitychange`, `online` | nothing local | "the world may have changed while we were away — re-check everything" (a full re-scan) |
| **vault** | `create` / `modify` / `delete` / `rename` | a concrete local change (a dirty path / rename pair) | push/pull exactly that change |
| **rescan** | the Rescan command | nothing | discard the checkpoint and force one cold reconcile |

They reach `runSync` by **deliberately different paths**:

- **signal** → `SyncScheduler.triggerSync()`, which is guarded by `orchestrator.isSyncing()`:
  if a sync is in flight the signal is **dropped** — it never reaches `runSync`, never sets
  `syncPending`.
- **vault** → `markDirty()` / `markRenamed()` **+ `debouncedSync()`** (5 s). The debounced call
  lands on `runSync`; if a sync is in flight, `runSync` sets `syncPending = true`
  (`orchestrator.ts`, the `isLocked` branch) and the `do/while` loop runs another cycle.
- **rescan** → `resetCheckpoint()` under `syncMutex`, then `runSync()`; the `do/while` body runs
  once.

Since ADR 0001's sibling work landed the per-cycle [`TrackerSnapshot`](../../src/sync/local-tracker.ts),
a `markDirty` arriving **mid-cycle** survives that cycle's `acknowledge` (the cycle clears only
what its snapshot captured). So the vault re-run actually has its dirty path to consume on the
fast **HOT** path instead of degrading to a full scan.

### The tempting simplification — and why it is a regression

Now that the snapshot makes mid-cycle dirt observable, it looks like the two mechanisms could
collapse into one rule: *"loop while there are dirty paths"* (`while (getDirtyPaths().size)`),
and the `isSyncing()` guard could be **deleted** because signals "naturally leave no dirty." Both
moves are regressions:

- **Delete the `isSyncing()` guard.** A signal arriving mid-sync would then reach `runSync`, hit
  `isLocked`, and set `syncPending = true`. That extra cycle runs with an **empty** dirty set, so
  it cannot take HOT (HOT requires `initialized && dirtyPaths.size > 0`) and degrades to a **WARM
  full local scan** — redundant with the in-flight scan the signal was already asking for. The
  guard is the structural place that classifies a signal as discardable; removing it does not make
  the discard "structural," it **removes the discard**.
- **Replace `syncPending` with `while(dirty)`.** `markDirty` does **not** set `syncPending` — only
  a debounce-fired (or rescan) `runSync` call does. Looping on "dirty exists" would re-run the
  instant a mid-cycle edit lands, **bypassing the 5 s debounce** — a tight sync loop during
  continuous editing. The debounce is the rate limiter; `syncPending` is the signal that the
  debounce already fired. (`rescan` is **not** a blocker for `while(dirty)` — the `do/while` body
  runs once regardless — contrary to an earlier draft that claimed it carried a trailing cold cycle
  via `syncPending`; it does not.)

None of this is a **correctness** question. Per ADR 0001, the `SyncRecord` baseline is the source
of truth and any missed or extra cycle re-converges. This decision is purely about keeping the
fast path fast and not burning a redundant full scan.

## Decision

1. **Re-run eligibility is classified by trigger, not by a single rule.**
   - **signal** → *discard while a sync is in flight.* The in-flight cycle already performs the
     full re-scan a signal asks for. Mechanism: the `isSyncing()` guard in `triggerSync`.
   - **vault** → *debounce (rate-limit) + `syncPending` (re-run).* The re-run lets the
     snapshot-surviving dirty path be consumed on HOT.
   - **rescan** → *one explicit cold cycle* (the `do/while` body runs once).

2. **The `isSyncing()` guard in `triggerSync` is load-bearing, not redundant** with `runSync`'s own
   `isLocked` check. `isLocked` *sets* `syncPending` (schedules a re-run); the guard *suppresses*
   that for signals. Do not delete it to "simplify."

3. **`syncPending` is not equivalent to "dirty exists."** It means *"a debounce-fired or rescan
   `runSync` arrived while locked."* Do not replace the `do/while` condition with a dirty-count loop.

4. **This is an efficiency contract, not a safety one** (ADR 0001). A change here can only make sync
   slower or wasteful, never unsafe — review proposals on that axis, and do not reach for it to fix
   a convergence concern.

## Consequences

**Prohibited patterns** (each trades a real optimization for apparent tidiness):
- removing or relaxing the `triggerSync` `isSyncing()` guard;
- replacing the `runSync` `do/while` `syncPending` condition with a dirty-count loop;
- routing **signal** events through `markDirty` + `debouncedSync` — a content-less re-check would
  masquerade as a dirty edit and defeat the in-flight discard;
- routing **vault** events through `triggerSync` — a real local edit would be dropped whenever a
  sync happened to be running.

**Pinned by tests** (keep green; extend, do not weaken):
- `scheduler.test.ts` → *"trigger classification"*: a signal (`focus` / `online` /
  `visibilitychange`) does **not** call `runSync` when `isSyncing()` is true, while a vault change
  **still** drives `runSync` (after debounce) when `isSyncing()` is true. This asymmetry **is** the
  classification — without it the guard is unpinned and a future "cleanup" deletes it silently.
- `orchestrator.test.ts` → *"a markDirty arriving mid-cycle survives the cycle's acknowledge"* — the
  vault re-run has work to consume on HOT (the snapshot premise of decision 1).
- `orchestrator.test.ts` → the `syncPending` coalescing suite (*a second `runSync` while locked sets
  `syncPending` and runs another cycle*; *notifies once for a coalesced burst*).
