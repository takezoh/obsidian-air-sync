---
change: change-20260927-gdrive-native-object-exclusion
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Implementation

`src/backends/googledrive/types.ts` adds the one provider-native predicate:
`GOOGLE_WORKSPACE_MIME_PREFIX` and `isGoogleDriveNativeObject(mimeType)` — true for the
`application/vnd.google-apps.*` prefix except the folder mimeType.

`src/backends/googledrive/normalize-object.ts` owns the view policy built on that predicate:
`isSyncableGoogleDriveObject`, `toSyncableRemoteObject(file, rootId): RemoteObject | null`
(null for native or absent), and `mapSyncableGoogleDriveObjects(files, rootId)`. Native
objects never cross this seam as a `RemoteObject`.

`src/backends/googledrive/adapter.ts` routes every view-feeding read through the helpers:
`listAll` and `listSubtreeById` use `mapSyncableGoogleDriveObjects`; `getById` and the final
segment of `getByPath` use `toSyncableRemoteObject`/`mapSyncableGoogleDriveObjects`;
`collectChanges` drops a native upsert but still emits a native delete by id; `read` returns
`{ kind: "unverifiable" }` for a native object before any download. `createFile`,
`updateFile`, `move`, and `delete` are unchanged — the app never creates a native object, and
an id that never entered the view is never mutated.

## Boundaries kept

- The adapter still reports provider facts and mutations only; it reads no cache, cursor,
  scope, or store state.
- `RemoteObject`, the Backend Module API, `ManagedRemoteFs`, and the OneDrive/Dropbox
  modules are untouched.
- Filtering happens once per read path at the module boundary, not in core.
