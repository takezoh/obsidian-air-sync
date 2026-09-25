# Backend capability-tiered conditional mutation — technical plan

## Requirements (EARS)

- **Ubiquitous** The adapter boundary shall expose, for each provider, the exact
  precondition guarantees it can make: `exclusiveCreate`,
  `conditionalContentUpdate` (`all` | `none`),
  `conditionalMetadataMutation`, and the `read()` binding mode.
- **Event-driven** When `updateFile` is called with an `ExpectedVersion` and the provider
  supports a content precondition, the adapter shall carry that version to the provider
  operation, not only to a local comparison.
- **Event-driven** When `createFile` is called and the provider supports exclusive create,
  the adapter shall request a create that fails when the destination is occupied.
- **Event-driven** When `move`/`delete` is called with an `ExpectedVersion` and the
  provider supports a metadata precondition, the adapter shall send it.
- **State-driven** While `read(input)` runs, the adapter shall return `content` only when
  the downloaded bytes are proven to belong to `input.versionToken`; otherwise it shall
  return `target_changed` or `unverifiable`.
- **Unwanted** If the provider has no precondition for an operation, the adapter shall
  compare before mutating and fail closed on an observed mismatch, and shall not advertise
  the precondition as enforced.
- **Ubiquitous** Google Drive version evidence shall be the provider's monotonic `version`,
  so a metadata-only change is a version change.

## Provider contract

|              | exclusiveCreate | conditionalContentUpdate | conditionalMetadataMutation | versionBoundRead |
|--------------|-----------------|--------------------------|-----------------------------|------------------|
| Dropbox      | yes (`add`)     | `all` (`update(rev)`, `strict_conflict`) | no             | revision (`download rev`) |
| OneDrive     | yes (`conflictBehavior:fail`) | `none` (session `If-Match` binds creation, not commit) | yes (`If-Match` on the item `eTag`, files and folders) | reobserve |
| Google Drive | no              | `none`                   | no                          | reobserve |

## Implementation contract

### `remote-adapter.ts`

- `BackendCapabilities` is a readonly record on `RemoteBackendAdapter.capabilities`.
- Doc comments on `UpdateFileInput`, `MoveInput`, `DeleteInput`, `VersionBoundReadResult`
  state that provider enforcement is capability-conditional.

### Dropbox

- `DropboxWriteMode = "add" | { tag: "update"; rev: string }` on `client.upload`.
- `createFile`: `mode: "add"`; a conflict maps to `target_changed` (409).
- `updateFile`: compare observed rev to expected, then `mode: update(rev)`,
  `autorename: false`, `strict_conflict: true`; a mismatch is rejected by Dropbox.
- `read`: after the local version check, `download(id, rev)` returns the exact revision.
- `move`/`delete`: capability false; keep compare-before-mutate.

### OneDrive

- `normalize-object.ts`: version evidence is the item `eTag` (metadata + content,
  returned for folders too), not the content-only `cTag`.
- `client.upload(parentId, name, content, mtime, opts?)` where `opts` carries
  `conflictBehavior` and `ifMatch`/`ifNoneMatch`.
- `client.move(id, name, parentId, etag?)` and `client.deleteItem(id, etag?)` add
  `If-Match`.
- `uploadSession` accepts `ifMatch`/`ifNoneMatch`/`conflictBehavior`.
- Any non-empty write carrying a precondition routes through the upload session (the
  documented carrier); a zero-byte write has no byte range and takes the simple PUT,
  with `@microsoft.graph.conflictBehavior` in the URL and the precondition headers.
- `read`: fetch item, check version, download, fetch item again, compare the `eTag`;
  changed => `target_changed`.
- `move`/`delete`: guard on `eTag` for files and folders; a real expected token that
  cannot be re-proven fails closed. Content updates declare `none` and
  compare-before-mutate.

### Google Drive

- `normalizeGoogleDriveObject`: `versionToken = googledrive:v:<version>` for files AND
  directories; absent version => undefined (fail closed).
- `read`: fetch file, check version, download, fetch file again, compare `version`;
  changed => `target_changed`.
- create/update/move/delete: capability `none`; keep compare-before-mutate and fail
  closed when a real expected token cannot be re-proven.
- create uniqueness is the sync engine's Admission responsibility on this backend.

## Failure modes

- A provider precondition failure (409/412) is translated to `target_changed` by the
  existing error translators.
- An adapter that holds a real expected token (`expected.versionToken !== ""`) but
  cannot re-prove it fails closed (`unverifiable`) BEFORE the provider mutation.
- A missing version on a file yields `unverifiable`.
- A read whose version moves during download yields `target_changed`, and the returned
  bytes are asserted to belong to the requested version.

## Verification

- `tests/fs/contracts/backend-concurrency.contract.ts`: for each adapter, observe an
  object, inject a provider change before the call and immediately after the adapter's
  metadata observation, and require `target_changed`/`unverifiable` or the exact
  requested revision's bytes; assert no overwrite. Move/delete races run where
  `conditionalMetadataMutation` is declared, and a missing-evidence case must fail
  closed.
- Provider wire shape is pinned by client tests: Dropbox `mode:add`/`update(rev)` +
  `strict_conflict` + `rev` download; OneDrive `If-None-Match`/`If-Match` and
  `conflictBehavior`; Google Drive resumable `fields` includes `version`.
- The capability table above is asserted against the real adapters.
- The five existing managed contracts stay green.
