# pCloud Backend

The pCloud backend (`fs/pcloud/`) syncs against a regular folder
`/obsidian-air-sync/<vault>` resolved to a numeric **folder id** that roots the
FS. Authentication is OAuth (code flow via the auth worker), and the vault is
addressed entirely by its **stable folder id** so a remote move/rename of the
folder needs no migration.

It is built on the same shared machinery as the Google Drive and OneDrive
backends, because pCloud — like both of them, and unlike Dropbox — references
each item's parent by id (a single numeric `parentfolderid`). The id-chain path
resolver in `AbstractMetadataCache` therefore drives it unchanged. Only the wire
protocol (pCloud's HTTP JSON API) and the auth (long-lived token, no refresh) are
pCloud-specific.

> **Account-wide access.** Unlike Dropbox and OneDrive (App Folder scope) or
> Google Drive (`drive.file`), pCloud's OAuth has **no app-folder / restricted
> scope** — the access token grants access to the whole account. Air Sync only
> ever reads or writes the `obsidian-air-sync/<vault>` folder it creates, and its
> account-wide `diff` feed is filtered to that subtree client-side, but nothing at
> the API-permission layer confines it. This is called out in the README's
> privacy section.

## PCloudFs

`PCloudFs` (`fs/pcloud/index.ts`) extends `CachingRemoteFs<PCloudEntry>`. The
crash-safe cache/checkpoint machinery (ADR 0001) lives in the base; this subclass
supplies the pCloud-specific seams and the mutating ops:

| Seam | pCloud API call |
|---|---|
| `getStartCursor()` | `diff?last=0` → the latest `diffid` (a baseline that emits no past events) |
| `fullList()` | recursive `listfolder?recursive=1` of the root, flattened to a flat `PCloudEntry[]` |
| `assertRootAlive()` | **no-op** — `listfolder` *errors* (result 2005) on a missing root, so the `fullList()` the base just ran already proved the root is alive (an empty result is a genuinely empty folder, not a trashed root) |
| `fetchChanges(cursor)` | drain the account-wide `diff` feed from the cursor; a `reset` event → `needsFullScan` |
| `downloadFile(id)` | `getfilelink` → GET the returned content host + path |
| `deleteRemote(id)` | `deletefile` (file) or `deletefolderrecursive` (folder), by id (the API itself errors on an already-gone id — pCloud returns no 404; FS-level idempotency comes from the base `delete()` cache guard, which no-ops a missing path before calling this) |
| `write` | hand-built multipart `uploadfile` (`nopartial=1`), carrying the preserved mtime |
| `mkdir` / folder create | `createfolderifnotexists` (idempotent) |
| `rename` | `renamefile` / `renamefolder` with `toname` and/or `tofolderid` |

### Addressing: id, never a path

Every remote operation is addressed by the item's numeric id (`fileid` /
`folderid`); the account root is folder id `"0"`. The cache joins on a typed id
string — `"d<folderid>"` for folders, `"f<fileid>"` for files — because pCloud's
`diff` feed returns account-wide events whose metadata carries **no absolute
path**: a delete is reverse-resolved from id to path through the cache
(`getPathById`). The numeric `parentfolderid` is lifted into the same id
namespace (`"d" + parentfolderid`), and the sync-root folder id is lifted to its
`"d"`-prefixed id so a top-level item's parent matches the root. The remote path
is never stored, so a remote move/rename of the bound folder keeps syncing.

### Change detection

`stat()` returns `hash: ""`; the sync engine compares the item's `modified`
timestamp (the preserved local mtime) plus the `remoteChecksum`. pCloud exposes
an internal 64-bit content `hash` that is stable per content but **not
cryptographic and not reproducible from local bytes**, so it is surfaced as
`{ algo: "opaque" }` — it rides for free on `listfolder`/`stat`/`diff` and drives
temporal change detection, but cannot seed cross-side dedup the way Google Drive's
md5 or OneDrive's QuickXorHash can. (Caveat: the hash arrives as a JSON `number`,
so values above 2^53 lose low bits; this is stable per content, so change
detection is unaffected — only a ~2^-53 different-content collision is
theoretically possible, far below other risks, and pCloud offers no string-typed
hash to avoid it.)

mtime is preserved at **whole-second** precision: `uploadfile` takes
`mtime=Math.floor(ms/1000)`, so a written file reads back stamped with the local
mtime floored to the second (the same shape as OneDrive).

## PCloudMetadataCache

`PCloudMetadataCache` (`fs/pcloud/metadata-cache.ts`) only reads pCloud's entry
shape (single-parent `parentfolderid`, the `isfolder` flag) and projects a
`FileEntity` carrying the opaque content hash. All path/tree logic is inherited
from `AbstractMetadataCache` (id→parent-chain resolution, identical to Google
Drive and OneDrive). `flattenPCloudListing` turns the recursive `listfolder`
response (a root entry with nested `contents`) into the flat `PCloudEntry[]` the
cache expects, stamping each child's `parentfolderid` from its position in the
tree and dropping the `contents` array so cached/persisted entries stay flat.

## Incremental sync

`applyPCloudDiff` (`fs/pcloud/incremental-sync.ts`) drains pCloud's account-wide
`diff` event log — a chronological feed keyed by ascending `diffid`. Entries are
applied **in the order returned** (never reordered folders-first like Google
Drive's coalesced `changes.list`, which would break create/delete causality); one
call may cap the events, so it loops until a page comes back empty (a guard caps
the pathological case where the cursor never advances). Because the feed is
account-wide and path-less:

- events that don't resolve under the sync root (unrelated account files) are
  ignored;
- deletes (`deletefile`/`deletefolder`) are reverse-resolved by id through the
  cache, removing the subtree;
- a rename/move surfaces as a `modifyfile`/`modifyfolder` whose `parentfolderid`
  and/or `name` changed — detected via the shared `applyFileChangeDetectMove`
  (the same parents-comparison Google Drive uses), which reports the
  `renamed` pair for native rename optimization.

A `reset` event means the server wants clients to discard state, so it returns
`needsFullScan` and the base full-scans and diffs by id to recover
adds/deletes/renames (the same fallback as Google Drive's / OneDrive's
cursor-expiry). The diff only mutates the in-memory cache; persistence to
IndexedDB is deferred to the checkpoint commit, so the persisted cache never runs
ahead of the committed cursor (ADR 0001).

## PCloudClient

`PCloudClient` (`fs/pcloud/client.ts`) wraps pCloud's HTTP JSON API via Obsidian's
`requestUrl` (never `fetch`). Notes:

- **Auth is a query param.** Every call carries `auth=<token>`; the API host
  (US `api.pcloud.com` or EU `eapi.pcloud.com`) is read from `getApiHost` on every
  request, so the region pinned at connect time is honored for the client's whole
  lifetime.
- **HTTP 200 is not success.** pCloud signals logical errors with a non-zero
  `result` field in an HTTP-200 body, so every response is checked by `assertOk`
  (`types.ts`), which maps auth-class result codes (`1000` log-in required,
  `2000` log-in failed, `2012` invalid token, `2094`/`2095` invalid/expired code,
  `4000` too many tries) to `AuthError(401)` and any other non-zero result to a
  generic `Error`. There is **no retry/backoff loop** here (unlike the Google
  Drive / OneDrive clients) — retries are left to the orchestrator.
- **Uploads are hand-built multipart.** `requestUrl` has no `FormData`, so
  `uploadfile`'s `multipart/form-data` body is assembled as raw bytes; the
  filename is UTF-8 encoded in the part's `Content-Disposition`, preserving
  non-ASCII (e.g. Japanese) names. `nopartial=1` rejects truncated uploads.
- **Downloads are two-step.** `getfilelink` returns `{hosts, path}`; the content
  is then fetched with a plain GET to the first host.

## Authentication

OAuth **authorization-code flow via the auth worker** (`fs/pcloud/auth.ts`).
Authorization opens `my.pcloud.com/oauth2/authorize` (`response_type=code`,
redirect `auth-airsync.takezo.dev/pcloud/callback`); the worker exchanges the code
for a token and redirects back through the existing
`obsidian://air-sync-auth?access_token=…&hostname=…&state=…` protocol handler. The
callback is pCloud-specific because it carries `hostname` for **region pinning**
(stored in `backendData.apiHost`).

- **No scope.** The authorize request sends no `scope` param — pCloud grants
  account-wide access (see the note at the top).
- **Long-lived token, no refresh.** pCloud issues a long-lived access token with
  no refresh token and no expiry, so only the `access` secret is stored (Obsidian
  SecretStorage, keyed per backend type `pcloud`). Expiry is handled reactively:
  an auth-class `result` surfaces as an `AuthError` → reconnect prompt. There is
  no per-cycle token state to persist.
- **CSRF.** The `state` param is `{app, nonce}` base64 — the shape the OAuth
  worker's `parseState` expects, so it routes the callback back to the Obsidian
  app — and is verified against the pending state on completion.
- The committed `client_id` is a placeholder (`REPLACE_WITH_PCLOUD_CLIENT_ID`);
  the maintainer must register the app at <https://docs.pcloud.com/> and set both
  this constant and the worker's `PCLOUD_CLIENT_ID` var before release.

## Provider model

`PCloudProvider` (`fs/pcloud/provider.ts`, type `pcloud`):

- `isConnected` = an `access` secret is present **and** a `remoteVaultFolderId` is
  bound; `getIdentity` = `pcloud:<folderId>` (drives identity-change handling).
- The incremental checkpoint (`diff` cursor + file-map cache) is owned by the FS's
  `checkpoint` capability (inherited from `CachingRemoteFs`): both live in the
  per-target IndexedDB store (`air-sync-pcloud` prefix) and commit in **one
  transaction** (ADR 0001) — the cursor is never kept in settings.
- `disconnect` just drops the secret and resets `backendData` (the token is
  immutable and has no revoke endpoint); `clearCheckpointStore` drops the
  per-target store by its settings key when there is no live FS, so a stale
  checkpoint can't survive a disconnect.
- `createFs()` returns `null` unless an access token and a `remoteVaultFolderId`
  are both present; otherwise it builds a `PCloudFs` from the id and the per-target
  checkpoint store. The cursor is **not** seeded from settings — it is restored
  from the metadata store alongside the file map on init.

### Remote vault resolution & default

`resolveRemoteVault` binds the vault by find-or-creating
`obsidian-air-sync/<vault>` under the account root (`createfolderifnotexists` is
idempotent, so a second device with the same vault name binds to the same folder).
Unlike OneDrive, a **local vault rename renames the remote folder to match**: when
a `remoteVaultFolderId` is already bound and the last-known vault name differs, the
provider issues a `renamefolder` rather than re-creating — the folder is tracked
by id, so it keeps syncing under the new name.

There is **no folder picker.** The settings UI (`ui/pcloud-settings.ts`) offers
only Connect / Disconnect and a read-only display of the bound folder id; the
sync target is always the convention folder above.
