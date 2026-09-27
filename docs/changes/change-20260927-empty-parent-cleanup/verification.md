---
change: change-20260927-empty-parent-cleanup
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

Implemented and verified. Evidence is deterministic; the opt-in live e2e is not run in
the gate.

## Witnesses added

- `src/fs/local/local-fs.test.ts` — `hasChildren` is true when a normal folder's only
  child is hidden, and false for an empty directory, a missing path, or a file.
- `src/fs/local/disk-surface.test.ts` — the disk authority's `hasChildren`, `scanRoots`,
  `stat`, and `rename` behaviour.
- Shared `IFileSystem` contract (`tests/fs/contracts/ifilesystem-writes.contract.ts`) —
  `hasChildren` runs for the mock, `LocalFs`, and every managed remote harness: true for a
  directory whose only child is hidden-named, false for empty/missing/file.
- `src/sync/plan-admission.test.ts` — a `delete_local` carries the deepest-first
  scope-filtered ancestor chain; an out-of-scope ancestor yields no candidate (the
  un-ignore shape); a file at the sync root yields none; an admitted file rename carries
  the source-side chain.
- `src/sync/plan-executor.test.ts` — a remote delete prunes its emptied remote folder;
  a two-level chain cascades deepest-first; an in-scope sibling or a hidden/ignored
  child keeps the folder; a local propagated delete prunes locally; a failed emptiness
  read or folder delete keeps the folder and the cycle still succeeds; two sibling
  deletes in one folder read it once, not once per action; an occupied folder's
  ancestors are never read.
- `src/sync/orchestrator.test.ts` — end-to-end: a local-origin delete removes the remote
  folder and keeps the local one; a remote-origin delete removes the local folder and
  keeps the remote one; a local-origin rename-out prunes the remote source folder and
  keeps the local source folder.

## Gate

- `npm run lint` — pass.
- `npm run lint:bot-repro` — pass (69 guard tests), including
  `sync-admission-authority-guard.test.mjs` and `sync-state-ownership-guard.test.mjs`
  with no fixture edits.
- `npm run build` — pass.
- `npm run test:coverage` — 118 files, 2443 tests pass; thresholds met.

## Residual risk

- The live e2e was not run here; the shared caching contract and the mock-level witnesses
  cover the semantics, but a real provider round trip (remote-side delete → local folder
  removed) is the opt-in confirmation.
- A prune that fails I/O is best-effort and not retried; a folder already empty on both
  sides re-plans as state-only `cleanup` and is not pruned (accepted v1 boundary).
