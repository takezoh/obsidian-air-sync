---
change: change-20260919-googledrive-folder-binding-seam
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

**Seam (`folder-usability.ts`).** `inspectGoogleDriveFolder(client, id)` reads the folder with the
existing `getFile` (`trashed` is already in `FILE_FIELDS`) and returns a discriminated
`GoogleDriveFolderInspection`. It owns only the decision. `isGoogleDriveTrashed` is the one reader
of Drive's `trashed` flag. 404/403 become `not_found`/`inaccessible` with the original error on
`cause`; other errors are rethrown.

**Binding sites.**
- `completeWebFolderPick` replaces its inline try/catch + mimeType + trashed checks with the seam;
  the user-facing wording is unchanged (`describeUnusableGoogleDriveFolder`).
- `resolveLinked` replaces its `getFile` + `file.trashed` with the seam, keeping its
  `Failed to access remote vault folder: …` wrapping (unclassified throws are still wrapped).
- `assertRootAlive` uses the seam; 404/403 rethrow the original error to preserve classification,
  a trashed root throws the existing Trash message.
- `fetchCurrentFile` uses `isGoogleDriveTrashed` (it handles arbitrary files, not only folders).

**Connect-boundary validation.** `IBackendProvider.validateRemoteVault?` is implemented by
`GoogleDriveProviderBase`: when a folder is bound, it inspects it and throws a user-facing error
for non-usable outcomes. `BackendManager.completeBackendConnect` calls it after auth and before
`createFs`; on rejection it notifies `Folder selection failed: …` and runs the shared teardown
(`teardownActiveBackend`): provider `disconnect` + `clearPluginSecrets`, clear the synced
identity, close and drop the FS, and `onDisconnected`. Reusing the disconnect path keeps the gate
closed — with no token, a later `initBackend`/`runSync` cannot rebuild the target — and makes the
custom id field editable again (custom `disconnect` preserves its credentials and id). Validation
is deliberately not run in `initBackend`: that method is a network-free local lifecycle step, and
sync-time `assertRootAlive` already re-observes the target every cycle and recovers automatically.

**Failure classification.** `inspectGoogleDriveFolder` classifies only a *genuine* 403 permission
failure as `inaccessible`; a 403 that `classifyGoogleDriveError` reads as a rate limit (and every
auth/transient/server failure) is rethrown, so R3 holds. `validateRemoteVault` then fails **open**
on such a rethrow (warn and continue) — a throttle or unreachable Drive is not a binding defect, so
the FS is still built and the sync engine surfaces/retries it with its own classification.

**Display.** `resolveFolderPath` classifies its already-fetched file through the seam's pure
`classifyFetchedGoogleDriveFolder` (no direct `trashed` read) and returns `{ path, problem? } | null`
from the same `getFile`. `getRemoteVaultDisplayPath` returns the backend-neutral
`{ path, warning? }`; Dropbox/OneDrive return `{ path }`. The provider phrases every fetched
problem through an exhaustive switch, so a new problem cannot fall through to a silent ordinary
path. `renderBoundFolderField` shows the warning in place of the description.
`isGoogleDriveTrashed` lives on the leaf `types.ts`, so the incremental delta mapper and the seam
share the one predicate.
