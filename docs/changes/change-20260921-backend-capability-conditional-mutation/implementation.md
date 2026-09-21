# Implementation — backend capability-tiered conditional mutation

## Backend Module API

- `src/backend-api/remote-adapter.ts`: adds `RemoteBackendCapabilities` and a required
  `capabilities` on `RemoteBackendAdapter`; `expected` on update/move/delete is required; rewrites the `VersionBoundReadResult`,
  `UpdateFileInput`, `MoveInput`, and `DeleteInput` doc comments to state that provider
  enforcement is capability-conditional.
- `src/backend-api/index.ts`: exports the capability type.
- `tests/backend-api/fake-module.ts`, `tests/fs/managed/fake-adapter.ts`,
  `src/fs/modules/backend-module-provider.test.ts`: doubles declare capabilities.

## Dropbox

- `src/fs/dropbox/client.ts`: `DropboxWriteMode`; `download(path, rev?)`; `upload` takes
  `mode` and `strictConflict`.
- `src/fs/dropbox/adapter.ts`: capability `{exclusiveCreate: true,
  conditionalContentUpdate: "all", conditionalMetadataMutation: false, versionBoundRead:
  "revision"}`; create uses `add`; update uses `update(rev)` + `strict_conflict`; read
  downloads the exact revision; move/delete fail closed when a real expected token
  cannot be re-proven.

## OneDrive

- `src/fs/onedrive/normalize-object.ts`: version evidence is the item `eTag` alone
  (metadata + content; returned for folders too) and does NOT depend on size or
  QuickXorHash — a missing checksum leaves the checksum unknown, not the version. An
  item without `eTag` yields no token, so metadata mutation fails closed rather than
  falling back to `cTag`.
- `src/fs/onedrive/client.ts`: `OneDriveUploadOptions` (`existingId`,
  `conflictBehavior`, `ifMatch`, `ifNoneMatch`); a non-empty write with a precondition
  routes to the resumable session; a zero-byte write takes `simpleUpload`, which puts
  `@microsoft.graph.conflictBehavior` in the URL and the precondition headers on the
  wire; the post-PUT mtime PATCH is conditional on the eTag the PUT returned;
  `move`/`deleteItem` carry `If-Match`.
- `src/fs/onedrive/upload-session.ts`: carries `If-Match`/`If-None-Match` and
  `conflictBehavior`; targeted update route `/items/{id}/createUploadSession`.
- `src/fs/onedrive/adapter.ts`: capability `conditionalContentUpdate: "none"` (the
  upload session's `If-Match` is checked only at session creation, not at commit) with
  `versionBoundRead: "reobserve"`; create is provider-enforced by `conflictBehavior: fail`;
  `move`/`delete` guard files and folders on `eTag` and fail closed when a real expected
  token cannot be re-proven; read re-observes after download.

## Google Drive

- `src/fs/googledrive/normalize-object.ts`: version token is `googledrive:v:<version>`
  for files AND directories; an absent version yields no token.
- `src/fs/googledrive/resumable-upload.ts`: the resumable create `fields` include
  `version`, so a ≥5 MiB upload also carries version evidence.
- `src/fs/googledrive/adapter.ts`: capability `conditionalContentUpdate: "none"` with
  `versionBoundRead: "reobserve"`; read re-observes `version` after download and fails
  closed on a move; move/delete fail closed when a real expected token cannot be
  re-proven.

## Core rounding

- `src/fs/interface.ts`, `src/fs/managed/managed-remote-fs.ts`, `src/fs/managed/mutation-bridge.ts`:
  an identity-addressed rename now takes the admitted source path; at execution the
  bridge re-observes, fails closed when the object is no longer addressed there, and
  carries that object's `expected` version into `MoveInput`. A post-Admission move to
  another parent can no longer be justified by a fresh observation.
- `src/backend-api/module.ts`: `BACKEND_MODULE_API_VERSION` becomes 2 (capabilities is
  a required adapter member).
- `src/fs/modules/validate-module.ts`: `validateAdapterCapabilities` runtime-validates
  the returned adapter against the v2 shape (missing capabilities or an out-of-enum
  value is rejected).
- `src/fs/modules/backend-module-provider.ts`: validates the adapter immediately after
  `createAdapter`, before it reaches `ManagedRemoteFs`.
- `src/fs/caching/detached-priority.ts`: `DetachedReadOutcome`; `readDetachedPriority`
  returns the download's typed outcome instead of requiring a throw/success.
- `src/fs/caching/remote-fs.ts`, `src/fs/managed/managed-remote-fs.ts`: a
  `downloadForPriority` seam surfaces the adapter's `target_changed`/`unverifiable`
  typed result; `downloadFile` keeps throwing for `IFileSystem.read`.
- `src/fs/caching/metadata-cache.ts` + `managed-remote-fs.ts`: `objectById` resolves the
  exact object for an id (representative or merged-folder member), and `deleteRemote`
  builds `expected` from it — so each member of a merged folder is deleted with its own
  version, not the path representative's.

## Tests

- New `tests/fs/contracts/backend-concurrency.contract.ts` drives the real adapter.
  The harness derives each object's token from the adapter's own observation (so a
  wrong-field adapter cannot pass by seeding the expected field), models content and
  metadata-only changes independently, and asserts: the exact requested revision's
  bytes, zero overwrite, `target_changed` for a mid-read change on a `reobserve`
  backend, provider rejection of a post-observation change, a metadata-only delete
  race that a `cTag`-based adapter would miss, a folder move guarded by its own
  version, and fail-closed when a real expected token cannot be re-proven.
- The three managed harnesses register it; the OneDrive fake models independent
  `cTag`/`eTag`, gives folders an `eTag`, and advances only `eTag` on a metadata-only
  change.
- Provider wire shape is pinned by client tests: Dropbox `mode:add`/`update(rev)` +
  `strict_conflict` and `rev` download; OneDrive `If-None-Match`/`If-Match` +
  `conflictBehavior`, the zero-byte simple PUT, the conditional mtime PATCH, and the
  session update route; Google Drive resumable `fields` includes `version`.
- `tests/fs/contracts/remote-backend-family.ts` gains the `concurrency` kind; the
  central matrix registers it for all three modules.

## Docs

- New `docs/adr/adr-20260921-backend-capability-tiered-conditional-mutation.md` and
  `docs/changes/change-20260921-backend-capability-conditional-mutation/` (the change
  package uses the canonical `promotion: []` list form).
- `AGENTS.md`, `docs/code-enforcement.md`: the shared contract count moves from four to
  five.
- `docs/design/design-backend-module-api.md`, `ARCHITECTURE.md`, and
  `docs/adr/adr-20260920-backend-module-boundary.md` name API v2, matching the single
  version core implements.

The pre-existing uncommitted work in the tree (`src/sync/change-detector.ts`,
`src/fs/local/*`, `src/main.ts`, `e2e/bench`, `tests/bench`, and the earlier part of
`eslint.config.mts`/`remote-fs.ts`) is not part of this change.
