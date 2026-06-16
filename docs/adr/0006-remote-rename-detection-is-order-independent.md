# ADR 0006 — Remote rename detection is order-independent; Dropbox's path-addressed delta reorders before applying

**Status:** Accepted · 2026-06-14
**Context area:** `fs/` backends — incremental sync / delta application (`fs/dropbox/incremental-sync.ts`, `fs/caching/id-delta.ts`)
**Related:** [ADR 0001](0001-metadata-cache-is-subordinate-to-commit-last.md) (convergence — a missed rename is an efficiency bug, not a correctness one), [ADR 0002](0002-backends-verified-by-shared-behaviour-contracts.md) (the shared crash-safety contract this extends), [ADR 0003](0003-opt-in-e2e-validates-fakes-against-real-backends.md) (the opt-in e2e that backstops the delta SHAPE against live Dropbox), [dropbox-backend.md](../dropbox-backend.md)

## Context

A remote rename/move must surface from `IFileSystem.checkpoint.getChangedPaths()` as a
single `RenamePair` so the engine can replay it as one `rename_local` (or `rename_remote`),
instead of deleting and re-downloading every affected file. For a folder that is the
difference between one `localFs.rename(A→B)` and a delete+pull of the entire subtree.

How a backend encodes a rename in its delta depends on how it addresses files:

- **Id-addressed backends (Google Drive, OneDrive).** A rename is a **single id-keyed
  change**: the same file id reappears with a new name/parent. The shared
  `applyIdDeltaPage` (`fs/caching/id-delta.ts`) detects the move by looking the id up in
  the cache (`getPathById`) and rewrites the descendants. No path-keyed tombstone is
  involved, and the page is sorted folders-shallow-first, so detection is **inherently
  order-independent**. Google Drive doesn't even re-emit a renamed folder's children
  (their metadata is unchanged); OneDrive may, but they resolve against the
  already-renamed parent.

- **Path-addressed backend (Dropbox).** `list_folder/continue` encodes a rename as a
  **pair**: `deleted(oldPath)` + `file/folder(newPath)` sharing a stable `id`. Coalescing
  back into a rename requires the old `id→path` mapping to still be present when the new
  entry is applied — but **Dropbox does not guarantee the add precedes the delete.** If
  the `deleted(old)` is applied first, `cache.removeTree(old)` drops the id mapping (and
  every descendant's), so the later same-id upsert can no longer reverse-resolve the old
  path. Detection fails and the rename degrades to delete+add — for a folder, a
  file-by-file re-pull of the whole subtree. This was a real, user-reported bug; the
  earlier code applied entries in raw receive order and the source even acknowledged the
  degradation.

This is the "path↔id resolution difference" that made the same remote action behave
differently per backend.

## Decision

**Make remote rename detection order-independent on every backend, and bring Dropbox's
path-addressed delta up to that bar by reordering before applying.**

Concretely, `applyDropboxDelta` (`fs/dropbox/incremental-sync.ts`):

1. **Drain the whole delta first, then apply upserts before deletes.** A rename's
   `deleted(old)` and `add(new)` can land on different pages, so the reorder spans the
   full drained delta, not one page. Applying every `file`/`folder` upsert first means the
   old `id→path` mapping is still present, so `getPathById` coalesces the move into one
   `RenamePair` (folders also rewrite child paths); the trailing `deleted(old)` then finds
   the path already vacated and is a no-op.

2. **Sort upserts folders-then-shallow-first** (parity with `applyIdDeltaPage`), so a
   parent folder's rename is applied — rewriting child paths — before any child entry, and
   a nested rename collapses to one pair instead of emitting redundant per-child pairs.

3. **Guard the delete pass against a reclaimed path.** A `deleted(path)` removes the
   subtree **only if** that `path` was *not* (re)written by an upsert in this same delta
   (`upsertedPaths`). If it was, the path is a rename target or a delete-then-recreate at
   the same path with a **different** id (the upsert already evicted the old occupant) —
   the upsert is authoritative and removing it would drop the live file. This guard is what
   keeps the legitimate "delete P, then create a new file at P" case correct; a naive
   "upserts-before-deletes" reorder without it would wrongly delete the recreated file. The
   guard keys on **path, not id**, because Dropbox `deleted` tombstones carry no id and an
   upsert's `id` is itself optional.

4. **Record an evicted subtree before it is silently dropped.** When an upsert lands on a
   path already held by a *different* id — a folder delete-then-recreated at the same path
   (`applyUpsertEntry`), or a folder moved onto a path freed by a deleted folder
   (`applyRename`) — `cache.setEntry` evicts the old occupant's whole subtree but reports
   nothing. Both call sites therefore capture the displaced descendants **before** the
   eviction and add them to the changed set, so they surface as deletions instead of
   orphaning locally until the next full scan.

Bounding (from ADR 0001): a *missed* rename is never data loss — it degrades to delete+add,
which still converges (the file is re-downloaded). So this is an **efficiency/quality**
fix, not a correctness patch; the guard above exists to avoid *introducing* a correctness
bug while making the common case efficient.

## Consequences

- **Dropbox folder/file renames now replay as a single `rename_local`**, regardless of the
  order Dropbox lists the delete vs the add — matching Google Drive and OneDrive.

- **Order-independence is now a cross-backend contract, run against the REAL FS.** The
  shared crash-safety contract (`fs/caching/remote-fs-contract.ts`, ADR 0002) gained a
  `stageRemoteRename` seam and two rename cases; each backend's harness emits its own
  faithful delta and the **Dropbox harness lists `deleted(old)` FIRST** so the contract
  pins exactly the ordering that used to break.

- **The delta SHAPE is backstopped by the opt-in e2e (ADR 0003), not the fakes.** The unit
  contracts prove "given this delta, the FS coalesces"; only the live e2e proves real
  Dropbox actually emits a folder rename as a same-id `deleted`+`add` (the
  `getChangedPaths` surface was previously unexercised against any live backend).

- **Prohibited:** applying Dropbox delta entries in raw receive order; "fixing" this by
  merely sorting upserts ahead of deletes without the `upsertedPaths` guard (re-breaks
  delete-then-recreate-at-the-same-path); assuming a `deleted` tombstone always means
  "remove the subtree" without checking whether the path was reclaimed this delta; calling
  `cache.setEntry` over a different-id occupant without first recording the evicted subtree.

## Edge cases & irregular deltas

How the drained-then-reordered apply behaves on the irregular deltas (all order-independent
unless noted):

| Delta | Behaviour |
|---|---|
| `deleted(old)` before `add(new)`, same id (the bug) | One `rename_local`; the stale `deleted(old)` is a no-op (path already vacated). |
| Rename split across pagination pages | Coalesced — the whole delta is drained before applying. |
| Delete-then-recreate a **file** at the same path, **different id** | Not a rename: new file kept, `deleted(old)` guarded out, surfaced as a content change (`modified`). |
| Delete-then-recreate a **folder** at the same path, **different id** | New folder kept; the old folder's children surface as deletions (evicted-subtree recording). |
| Folder **moved onto a path freed by a deleted folder** (`X` deleted, `A`→`X`) | One `rename_local(A→X)`; the displaced old `X/*` children surface as deletions. |
| **Rename `A`→`B` *and* a new file created at `A`** in the same sync | Delta level: the cache detects `A`→`B` by id and the new `A` (different id) survives — `deleted(A)` is guarded out. Plan level: it does **not** coalesce into a rename. `A` is now `modified` (replaced), not `deleted`, so the rename optimizer's `delete_*`+`pull`/`push` pattern does not match; it resolves as two independent transfers (`pull(B)`+`pull(A)`, or `push`+`push` for a local rename). Correct end state (`B` = old content, `A` = new file), just without the move optimization. The folder variant (rename folder `A`→`B`, new file at `A`) still coalesces the folder move and pulls the new `A` separately; because `A` is locally a directory until the rename runs, the file lands at `A` over one or two cycles. |
| Entry **moved outside the vault root** (`relativize` → null) | Old path + descendants surfaced as deletions; the out-of-root destination is not tracked. |
| Move **onto the reserved metadata path or the root itself** | Destination ignored (never cached); the old location is surfaced as gone. |
| `file`/`folder` entry with **no `id`** | Handled — the stale-tombstone guard keys on path, not id. |
| Cursor **`reset`** | `applyDropboxDelta` returns `needsFullScan`; `CachingRemoteFs` full-scans and diffs by id to recover renames/deletes. |
| Server never clears **`has_more`** | Throws at `LIST_PAGE_CAP` rather than applying a truncated (lossy) delta. |

**Known non-handled-but-unrealizable deltas** (Dropbox's per-path latest-wins coalescing
prevents them, so no code guards them): a same-id `create`/`modify` then `delete` of the
**same path** in one delta (Dropbox emits only the net state — a present upsert *or* a
`deleted`, never both for one id); and a live child upsert under a folder that is deleted
and **not** recreated (a live child cannot exist under a deleted parent).

## Optimization opportunity (not implemented)

When a remote **folder rename's destination is already occupied locally**
(`coalesceRemoteFolderRenames`, reason `destination_occupied`), the whole-folder
`localFs.rename(A→B)` would collide, so the optimizer skips coalescing entirely and the
children fall back to per-file `delete_local`+`pull` — i.e. **every child is re-downloaded**,
even those whose own destination `B/x` is free. A finer fallback is possible: expand the
folder pair into per-child pairs and route them through `optimizeRemoteFileRenames`, so each
child whose destination is free becomes a `rename_local(A/x→B/x)` (no re-download) and only
the genuinely-colliding child stays a `conflict`/`match` (its behaviour is unchanged from
today, so no new dangling-delete risk). This is purely an efficiency win in a rare case —
convergence already guarantees correctness — and is deliberately left unimplemented to keep
the coalescer all-or-nothing.

**Pinned by tests** (keep green; extend, don't weaken):
- `fs/dropbox/incremental-sync.test.ts` — DELETE-FIRST file & folder rename, child-before-parent
  ordering, delete-then-recreate-same-path-different-id ⇒ NOT a rename, the folder
  delete-recreate evicted-child surfacing, and a folder moved onto a path freed by a deleted
  folder (displaced old children surface as deletions).
- `fs/caching/remote-fs-contract.ts` — the cross-backend "remote FILE/FOLDER rename ⇒ one
  renamed pair" cases, run against the real Dropbox/Google Drive/OneDrive FS.
- `sync/convergence.test.ts` — remote folder/file rename collapses to one `rename_local` and
  reaches a fixed point on re-sync.
- `e2e/dropbox.e2e.ts` — out-of-band folder rename via `getChangedPaths` against live Dropbox.
