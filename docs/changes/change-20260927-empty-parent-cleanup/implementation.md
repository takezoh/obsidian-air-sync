---
change: change-20260927-empty-parent-cleanup
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

Implemented as designed. The prune is an action-carried protocol, not a new action kind,
and nothing is persisted.

## Units landed

1. **Scope predicate** — `ScopeProjection.includes?(path)` (`src/sync/types.ts`), populated
   from the projection's own `isIncluded` in `applyScope` (`src/sync/scope-projection.ts`)
   and threaded through `captureBatchObservation` (`src/sync/sync-cycle-planning.ts`).
   Optional: its absence means scope cannot be proven, so no candidate is offered.
2. **Admission candidate chain** — `withPruneCandidates` / `pruneCandidateChain` in
   `src/sync/identity-component-decision.ts` attach `pruneEmptyAncestors` to the delete
   and file-rename actions `materializeFile` produces, derived from the target-side
   removed path (`localPath`/`remotePath` for deletes, `move.from` for renames) and cut at
   the first out-of-scope ancestor. Folder renames go through `decideFolder` and carry
   nothing.
3. **Execution** — `pruneEmptiedDirectories` (`src/sync/prune-empty-parents.ts`) is invoked
   once from `executePlan` after every serial removal, while the structural permit is
   held. It unions the succeeded actions' `pruneEmptyAncestors` chains, keyed by side and
   directory, so each candidate is read at most once per cycle, and processes them
   deepest-first. A candidate is deleted only after `IFileSystem.hasChildren` answers
   false; a child, an out-of-scope/hidden child, or a failed read/delete keeps it and skips
   its ancestors unread. A prune failure is logged at warn and never fails the cycle.
4. **Occupancy as a port semantic** — `IFileSystem.hasChildren` replaces the unused
   metadata-rich `listDir` (`src/fs/interface.ts`), answered from each backend's authority:
   `LocalFs` delegates to its disk authority (raw adapter, names only, no per-child stat),
   `CachingRemoteFs` to the derived cache.
5. **Local authority split** — `LocalFs` now composes `DiskSurface` (`src/fs/local/disk-surface.ts`:
   existence, actual casing, occupancy, hidden-path mutation) and `VaultSurface`
   (`src/fs/local/vault-surface.ts`: indexed mutation and discovery), owning only the
   authority rule, cross-regime parent creation, and cross-regime rename.

## Notes

- `AGENTS.md` continues to hold the `identity-component-decision.ts` line cap, re-pinned
  from 901 to 931 with a justifying comment for the prune helper that stays under the
  sole identity-policy owner.
- No `BatchObservation` / `IdentityComponent` member, no `SyncActionType`, no folder
  `SyncRecord`, no IndexedDB change; both sync AST guards pass unmodified.
