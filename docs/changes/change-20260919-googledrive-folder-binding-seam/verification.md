---
change: change-20260919-googledrive-folder-binding-seam
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Content

### Evidence

Full gate: `npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`
(all green). Full unit suite: 104 files / 2395+ tests pass.

### Test coverage

- `src/fs/googledrive/folder-usability.test.ts` — R1/R3: every classified problem (`not_found`,
  `inaccessible`, `not_folder`, `trashed`) and the unchanged rethrow of a non-404/403 error.
- `src/fs/googledrive/provider.test.ts` — R1/R2/R3/R6/R7: Picker rejects inaccessible (404/403
  with re-pick wording), non-folder, and trashed; unclassified server errors surface unchanged;
  `getRemoteVaultDisplayPath` returns the path with a Trash warning, and no warning when live;
  `validateRemoteVault` accepts a live folder, rejects a trashed folder and a missing id, fails
  open on a 403 rate limit (rather than blaming the folder id), and is a no-op with no network call
  when nothing is bound.
- `src/fs/googledrive/folder-usability.test.ts` — R1/R3: `classifyFetchedGoogleDriveFolder` for a
  live folder / non-folder / trashed file; `isGoogleDriveTrashed` tolerates an absent file; the
  fetch seam classifies 404 and a genuine 403, rethrows a 403 rate limit and other failures unchanged.
- `src/fs/googledrive/remote-vault.test.ts` — R2: cached-id rebind still throws the wrapped
  inaccessible message and the Trash message.
- `src/fs/googledrive/index.test.ts` — R2: an empty listing with a 404 root rejects with the
  original `Not Found`; a trashed root rejects with the Trash message.
- `src/fs/backend-manager.test.ts` — R4: `completeBackendConnect` calls `validateRemoteVault`;
  on failure it runs the disconnect teardown (`disconnect` + `clearPluginSecrets`), builds no
  filesystem, reports `onDisconnected` and notifies `Folder selection failed: …`; when validation
  passes it proceeds to `onConnected` without disconnecting.
- `src/ui/backend-settings-ui.test.ts` — R6: the field shows the id first, then the resolved path,
  and replaces the description with the warning for a present-but-unusable folder.

### Not covered

No live/E2E assertion is added: binding is not part of the four shared filesystem contracts, and
the seam reads only metadata already requested by `getFile`. The custom connect validation and the
Trash display are exercised against the provider/manager/UI seams with mocked `requestUrl`.
