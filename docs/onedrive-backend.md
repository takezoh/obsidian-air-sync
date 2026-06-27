# OneDrive Backend

The OneDrive backend (`fs/onedrive/`) syncs against a folder inside the app's
**App Folder** (Microsoft Graph `special/approot`, scope
`Files.ReadWrite.AppFolder`). It is worker-less: authentication is in-plugin
Authorization Code + PKCE, and the vault is addressed entirely by its **stable
driveItem id** so a remote move/rename of the folder needs no migration.

It is built on the same shared machinery as the Google Drive backend, because
OneDrive — like Google Drive, and unlike Dropbox — references each item's parent by id
(`parentReference.id`). The id-chain path resolver in `AbstractMetadataCache`
therefore drives it unchanged. Only the wire protocol (Microsoft Graph v1.0) and
the PKCE auth (Dropbox-style, no relay) are OneDrive-specific.

> The **built-in** `onedrive` backend is personal Microsoft accounts only (the
> `consumers` authority). The **`onedrive-custom`** backend (see below) lets the user
> pick the authority (`common`/`organizations`/a tenant GUID), reaching work/school
> (Azure AD) accounts the built-in cannot.

## OneDriveFs

`OneDriveFs` (`fs/onedrive/index.ts`) extends `CachingRemoteFs<OneDriveItem>`. The
crash-safe cache/checkpoint machinery (ADR 0001) lives in the base; this subclass
supplies the OneDrive-specific seams and the mutating ops:

| Seam | Microsoft Graph call |
|---|---|
| `getStartCursor()` | `GET …/items/{root}/delta?token=latest` → token from `@odata.deltaLink` |
| `fullList()` | drain `GET …/items/{root}/delta` (no token) via `@odata.nextLink`, excluding the root item and `deleted` tombstones |
| `fetchChanges(cursor)` | drain the delta from the cursor token; **410 Gone** → `needsFullScan` |
| `downloadFile(id)` | `GET …/items/{id}/content` (requestUrl follows the 302) |
| `deleteRemote(id)` | `DELETE …/items/{id}` (404 → idempotent no-op) |
| `write` | simple `PUT …:/{name}:/content` + `PATCH fileSystemInfo` (mtime), or a resumable session for ≥ 4 MiB |
| `mkdir` / folder create | `POST …/children` (`folder:{}`, `conflictBehavior:"fail"`); 409 → idempotent GET |
| `rename` | `PATCH …/items/{id}` with `name` and/or `parentReference.id` |

### Addressing: id, never a path

Every remote operation is addressed by the item's stable driveItem id
(`/me/drive/items/{id}`), or path-relative under a folder
(`/me/drive/items/{folderId}:/{relPath}:`). The vault is bound by the folder's id
(`remoteVaultFolderId`), so a remote move/rename keeps syncing because the id is
unchanged — the remote path is never stored.

### Change detection

`stat()` returns `hash: ""`; the sync engine compares the item's
`fileSystemInfo.lastModifiedDateTime` (the preserved local mtime) plus the
`remoteChecksum`. Personal OneDrive exposes ONLY `file.hashes.quickXorHash`
(Microsoft's QuickXorHash, base64; it does not return `sha1Hash`/`sha256Hash`,
which are Business/SharePoint only) — mapped to `{ algo: "quickxor" }`. It is
locally reproducible (`utils/quickxor.ts`, verified against the live API), so it
drives cross-side dedup just like Google Drive's md5. `sha256Hash`/`sha1Hash` are kept as
fallbacks (lowercased) for the Business shape.

## OneDriveMetadataCache

`OneDriveMetadataCache` (`fs/onedrive/metadata-cache.ts`) only reads Graph's
driveItem shape (`parentReference.id` as a one-element parent array, the `folder`
facet) and projects a `FileEntity`. All path/tree logic is inherited from
`AbstractMetadataCache` (id→parent-chain resolution, identical to Google Drive).

## Incremental sync

`applyOneDriveDelta` (`fs/onedrive/incremental-sync.ts`) drains the `/delta`
pages, sorting folders shallow-first so child paths resolve against
already-applied parents. A `deleted` facet (or a move out of the tracked root)
removes the subtree; everything else goes through `applyFileChangeDetectMove`,
which surfaces renames/moves. The final page's `@odata.deltaLink` carries the new
cursor token. A **410 Gone** (cursor expired, resync required) returns
`needsFullScan`, and the base full-scans and diffs by id to recover
adds/deletes/renames (the same fallback as Google Drive's 410).

## OneDriveClient

`OneDriveClient` (`fs/onedrive/client.ts`, with the resumable session split into
`upload-session.ts` to stay under the line cap) wraps Microsoft Graph v1.0 via
Obsidian's `requestUrl` (never `fetch`), with `throw: false` + `assertOk`. Notes:

- **401** triggers one forced token refresh-and-retry; **429** is retried with
  backoff (honoring `Retry-After`, else exponential, always capped) up to
  `MAX_RATE_LIMIT_RETRIES`.
- Small files upload via a simple content `PUT`, then a `PATCH` of
  `fileSystemInfo.lastModifiedDateTime` — a plain content PUT stamps the server's
  clock, so without the PATCH every upload would read back as "changed".
- Files ≥ 4 MiB use a **resumable upload session**: `createUploadSession` (which
  carries the conflict behaviour + preserved mtime), then 320 KiB-aligned chunk
  PUTs with `Content-Range`. The chunk PUTs go to the pre-authenticated
  `uploadUrl` and deliberately **omit** the bearer (`skipAuth`) — Graph rejects an
  unexpected `Authorization` header there — while still flowing through the shared
  `request` for 429 backoff.
- `assertOk` maps **401 / auth-class error codes** (e.g.
  `InvalidAuthenticationToken`) to `AuthError`; everything else to `GraphApiError`
  (preserving status + Graph error `code`, so a 410 resync / 409 conflict / 404 is
  branchable). `classifyOneDriveError` (`errors.ts`) then maps these to the
  backend-neutral retry kinds (507 → permission, 423/503/509 → transient, plus the
  shared 429/401/404 mapping).

## Authentication

In-plugin **Authorization Code + PKCE**, fully worker-less (`fs/onedrive/auth.ts`),
on the `consumers` authority (`login.microsoftonline.com/consumers/oauth2/v2.0`) for
the built-in backend. The authority host segment is parameterized — `authorizeUrlFor`/
`tokenUrlFor(authority)` build the endpoints, and `OneDriveAuth`/`buildOneDriveAuthorizeUrl`
take an `authority` (default `consumers`) — so the custom backend can target `common`/
`organizations`/a tenant GUID. The `client_id` is public and there is **no client secret** — the ephemeral
`code_verifier` is the proof. The authorization code returns **directly** via the
existing `obsidian://air-sync-auth` protocol handler (no relay page is needed,
since Entra permits the custom-scheme redirect for a desktop/mobile public
client); the plugin then exchanges the code for tokens directly with Microsoft.

- **Scope**: `Files.ReadWrite.AppFolder offline_access` — access is confined to
  the App Folder (`special/approot`); `offline_access` enables the refresh token.
- **Token storage**: refresh + access tokens in Obsidian SecretStorage (keyed per
  backend type, `onedrive`); the access-token expiry lives in
  `settings.backendData`. Tokens refreshed mid-sync are written back after the
  cycle. Microsoft's consumer endpoint has no programmatic token revoke, so
  disconnect clears the SecretStorage tokens (sufficient) and drops the in-memory
  manager.
- The committed `client_id` is a placeholder (`REPLACE_ME`); the maintainer must
  register the Entra app (personal accounts only, redirect `obsidian://air-sync-auth`)
  and drop in the real id before release.

## Custom app (`onedrive-custom`)

`OneDriveCustomProvider` (`fs/onedrive/provider-custom.ts`) is a thin subclass of the
shared `OneDriveProviderBase` — identical client/FS/folder-binding/error behaviour, same
App Folder scope — that swaps the auth identity. The user supplies their own Entra
**Application (client) ID** and an **account type**, both stored in `backendData`
(`customClientId`, `customAuthority`) as plain values (the client id is a public PKCE
identifier — no secret). `OneDriveCustomAuthProvider` overrides the PKCE seams to read
the client id and authority from `backendData` per call, so the authorize URL and token
endpoint hit the chosen tenant. Tokens live under the `onedrive-custom` SecretStorage
keys, separate from the built-in. `disconnect` clears the tokens but preserves
`customClientId`/`customAuthority` so a reconnect needs no re-entry.

The account-type dropdown maps to the authority host segment: Personal →`consumers`,
Work/school + personal →`common`, Work/school →`organizations`, Specific tenant →the
typed GUID. This is the lever that reaches **work/school (Azure AD)** accounts.

> **OneDrive for Business / SharePoint checksums.** Business drives expose
> `sha1Hash`/`sha256Hash` rather than personal's `quickXorHash`; the metadata cache
> already keeps those as fallbacks (`types.ts` hash selection), so change detection
> works without an FS-layer change. This path is exercised only by the opt-in e2e — a
> real Business tenant is the remaining verification gap.

## Provider model

`OneDriveProvider` (`fs/onedrive/provider.ts`, type `onedrive`):

- `isConnected` = a token is present **and** a `remoteVaultFolderId` is bound;
  `getIdentity` = `onedrive:<folderId>` (drives identity-change handling).
- The incremental checkpoint (delta cursor + file-map cache) is owned by the FS's
  `checkpoint` capability (inherited from `CachingRemoteFs`): both live in the
  per-target IndexedDB store (`air-sync-onedrive` prefix) and commit in **one
  transaction** (ADR 0001) — the cursor is never kept in settings.
- `readBackendState` writes back refreshed tokens only; it never touches the
  cursor. The remote path is never persisted (resolved from the id on demand via
  `getRemoteVaultDisplayPath`, through a **detached** auth so the UI read can't
  reset the live sync's tokens).
- `clearCheckpointStore` drops the per-target store by its settings key when there
  is no live FS, so a stale checkpoint can't survive a disconnect.

### Remote vault resolution & default

`resolveRemoteVault` binds the vault by find-or-creating a folder directly under
the App Folder root — the **default sync folder is `App Folder/<vault>`** (the App
Folder scope already namespaces the app, so there is no wrapper folder).
`createFolder` is idempotent (409 → existing folder), so a second device with the
same name binds to the same folder. A LOCAL vault rename does not move the remote
folder (it is tracked by id).

### Choosing a different folder (in-app modal)

Because the App Folder scope confines access to `approot`, there is **no web
picker** (a full-Drive picker would only mislead). Instead, settings offers
**Choose folder**, which opens the shared in-plugin `AppFolderPickerModal`
(`ui/app-folder-picker.ts`): it lists the folders directly under `approot`
(`listAppRootFolders`) and lets the user pick one or type a new name. On confirm
it writes the chosen name to `backendData.pendingPickedFolderPath` (via the
renderer's `onSave`) and triggers the existing default-bind action, so
`resolveRemoteVault` find-or-creates `approot:/<name>` and binds its id. No
`BackendManager` surface is added, and no `obsidian://` round-trip is needed.

### createFs() contract

`createFs()` returns `null` unless a token and a `remoteVaultFolderId` are both
present; otherwise it builds an `OneDriveFs` from the id and the per-target
checkpoint store.
