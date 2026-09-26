---
change: change-20260927-gdrive-out-of-subtree-exclusion
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Implementation

`src/backends/googledrive/normalize-object.ts` extends the representability predicate:
`isSyncableGoogleDriveObject(file)` is now `!isGoogleDriveNativeObject(file.mimeType) &&
hasGoogleDriveParent(file)`, where `hasGoogleDriveParent` requires a non-empty `parents`.
The bound root's own direct children carry `parents: [rootId]`, so they remain syncable;
an item with no parent is dropped before it can be projected as `parentId: null`.

`src/backends/googledrive/adapter.ts` needs no new call sites: `listAll` and
`listSubtreeById` already use `mapSyncableGoogleDriveObjects`, and `getById`, `getByPath`,
`getChanges` (via `collectChanges`), and `read` already use
`toSyncableRemoteObject`/`isSyncableGoogleDriveObject`. `read`'s unverifiable reason is
generalized to cover every non-representable object rather than only native ones.

## Boundaries kept

- The adapter still reports provider facts and mutations only; the predicate is
  context-free and reads no cache.
- `RemoteLocation`, `NormalizedMetadataCache`, core, and OneDrive/Dropbox are unchanged.
- The account-wide changes feed is still consumed whole; core continues to drop a
  changed object whose parent is a real id that is not in the working view.
