# Dropbox Backend

The Dropbox backend (`fs/dropbox/`) syncs against a folder inside the app's
**App Folder** (`/Apps/<App>/`). It is worker-less: authentication is in-plugin
Authorization Code + PKCE, and the vault is addressed entirely by its **stable
folder id** so a remote move/rename of the folder needs no migration.

## DropboxFs

`DropboxFs` (`fs/dropbox/index.ts`) implements `IFileSystem`. Like the Google Drive
backend it keeps an in-memory metadata cache (`path`, `mtime`, `size`,
`content_hash`) so `list()`/`stat()` never download; content is fetched only on
`read()`.

### Addressing: id, never a path

Every remote operation is addressed by the vault's folder id, not an absolute
path. Dropbox accepts a path of the form `id:<folderid>/<subpath>`, so
`addr(rel)` returns `` `${rootFolderId}/${rel}` `` (or `rootFolderId` for the
root). `read()`/`delete()` prefer each entry's own stable id; `write()`,
`rename()` (`move_v2`), and folder creation use `addr()`. Consequences:

- The remote vault path is **never stored**. `DropboxFs` takes no `rootPath` —
  only the folder id. A remote move/rename of the folder keeps syncing because
  the id is unchanged.
- `list_folder` still returns each entry's **absolute** `path_display`, so to
  produce vault-relative cache keys the cache needs the folder's current
  absolute path. `refreshRootPath()` resolves it from the id via `get_metadata`
  once per cycle and re-anchors the cache (`DropboxMetadataCache.setRootPath`).
  This is the only use of the absolute path, and it is never persisted.

### Initialization lifecycle

The remote delta cursor lives in `settings.backendData.cursor`, seeded onto the
FS by `createFs()`. The `MetadataStore` (IndexedDB, keyed
`{vaultId}-{remoteVaultFolderId}`) caches **only the file map** — never the
cursor or the root path.

On the first operation, `ensureInitialized()` runs under the cache mutex:

1. **Cursor present** → `loadFromCache()` restores the file map from IndexedDB
   (relative keys only — it does **not** set the relativize anchor), then
   `refreshRootPath()` re-anchors from the id so a subsequent `applyDelta()` (in
   `list()`) relativizes new entries correctly. If the cache is empty, fall back
   to `fullScan()` but restore the seeded cursor so the next delta spans the gap.
2. **No cursor** (first sync / after rescan / after a folder change) →
   `fullScan()`: clear the cache, `refreshRootPath()`, capture a baseline cursor
   with `get_latest_cursor` BEFORE listing (so changes during the scan aren't
   missed), drain `list_folder` recursively, build the cache, and
   fire-and-forget `persistCache()` (files only).

`getChangedPaths()` re-anchors (`refreshRootPath()`) then applies the delta;
`list()` reuses the anchor set earlier in the same cycle. Both the cursor and
the `list_folder` traversal are rooted at the folder **id**, so the cursor
survives a remote rename of the vault folder.

## DropboxMetadataCache

`DropboxMetadataCache` (`fs/dropbox/metadata-cache.ts`) stores entries keyed by
sync-relative path and answers `list`/`stat`/`getChildren`. `relativize()`
strips the root's case-folded absolute segments from each entry's `path_display`
(preserving the user's casing from `path_display` for the returned key). The
anchor is set per cycle via `setRootPath()` (driven by `refreshRootPath`), so a
remote move of the root only updates the anchor — no entry is rebuilt. The
constructor takes no root up front (it is unknown until resolved from the id).

## Incremental sync

After the initial recursive scan, remote changes are tracked with
`list_folder/continue` from the committed cursor (`fs/dropbox/incremental-sync.ts`).
A delta yields modified/deleted/renamed paths consumed by warm change detection.
A lost/expired cursor (`reset`) falls back to a fresh full scan diffed against
the prior cache by id (`computeFullScanDelta`) to recover renames/deletes.

Rename detection is **order-independent** ([ADR 0006](adr/0006-remote-rename-detection-is-order-independent.md)).
A rename arrives as `deleted(old)` + `file/folder(new)` sharing a stable `id`, but
Dropbox does not guarantee the add precedes the delete. The whole delta is drained,
then **upserts are applied before deletes** (folders shallow-first): the move
coalesces into one `RenamePair` via the still-present `id→path` mapping, and the
trailing `deleted(old)` is a no-op. A `deleted` is skipped when its path was reclaimed
by an upsert in the same delta (a rename target, or a same-path recreate with a
different id), so a delete-then-recreate is not mistaken for — or destroyed by — the
reorder. Without this, a folder rename whose `deleted(old)` was listed first degraded
to a file-by-file delete+pull of the whole subtree. See
[ADR 0006](adr/0006-remote-rename-detection-is-order-independent.md) for the full
edge-case matrix (cross-page renames, delete-then-recreate, move-onto-freed-path,
moved-outside-root, id-less entries, and the deltas Dropbox's coalescing makes
unrealizable).

Change detection is **checksum-based**: `stat()` returns `hash: ""` and the
sync engine compares Dropbox's `content_hash` (4 MiB block SHA-256 tree) plus
`server_modified` — so a metadata-only touch (same content, bumped mtime) is
correctly seen as unchanged.

## DropboxClient

`DropboxClient` (`fs/dropbox/client.ts`) wraps Dropbox HTTP API v2 via Obsidian's
`requestUrl` (never `fetch`), with `throw: false` + `assertOk`. RPC calls hit
`api.dropboxapi.com/2` (JSON); content calls hit `content.dropboxapi.com/2`
(octet-stream body + `Dropbox-API-Arg` header). Notes:

- **401** triggers one forced token refresh-and-retry; **429** is retried with
  backoff (honoring `Retry-After`, else exponential, always capped) up to
  `MAX_RATE_LIMIT_RETRIES` — transient write-lock contention during a bulk first
  sync doesn't fail the cycle.
- `Dropbox-API-Arg` must be ASCII, so every code unit ≥ 0x7F is `\uXXXX`-escaped
  (iterating UTF-16 code units) — this is what makes non-ASCII (e.g. Japanese)
  paths work.
- `create_folder_v2` / `upload` / `move_v2` return a **bare** metadata struct
  with no `.tag`. The client stamps it for `create_folder_v2` / `upload`; for
  `move_v2` the FS layer (`DropboxFs.rename`) stamps it from the known prior
  type, so a moved folder stays classified as a folder.

## Authentication

In-plugin **Authorization Code + PKCE**, fully worker-less (`fs/dropbox/auth.ts`).
The app key (`client_id`) is public and there is **no client secret** — the
ephemeral `code_verifier` is the proof. The authorization code returns directly
to the in-plugin `obsidian://air-sync-auth` protocol handler — Dropbox permits a
custom-scheme redirect URI for PKCE apps, so no relay page is involved (matching
the OneDrive backend). The plugin then exchanges the code for tokens directly
with Dropbox. Refreshing an access token needs only the `client_id`.

- **Scope**: App Folder permission with `files.metadata.read`,
  `files.content.read`, `files.content.write` — access is confined to
  `/Apps/<App>/`.
- **Token storage**: refresh + access tokens in Obsidian SecretStorage (keyed per
  backend type); the access-token expiry lives in `settings.backendData`. Tokens
  refreshed mid-sync are written back after the cycle.
- The built-in app key is committed in `fs/auth-config.ts` (`DROPBOX_AUTH`); it is a
  public PKCE identifier (no secret), so it ships embedded and connects with no per-user setup.

## Custom app (`dropbox-custom`)

`DropboxCustomProvider` (`fs/dropbox/provider-custom.ts`) is a thin subclass of the
shared `DropboxProviderBase` — identical client/FS/folder behaviour and the same App
Folder scope — that swaps the auth identity. The user supplies **their own Dropbox app
key** (a public PKCE identifier — no secret), stored in `backendData.customClientId` as a
plain value; they must register `obsidian://air-sync-auth` as a redirect URI in that app.
`DropboxCustomAuthProvider` overrides the PKCE seams to read the app key from
`backendData` per call. Tokens live under the `dropbox-custom` SecretStorage keys,
separate from the built-in. `disconnect` clears the tokens but preserves `customClientId`
so a reconnect needs no re-entry. (Dropbox has no authority/account-type concept, so —
unlike `onedrive-custom` — there is no account-type selector.)

## Provider model

`DropboxProvider` (`fs/dropbox/provider.ts`, type `dropbox`):

- `isConnected` = a token is present **and** a `remoteVaultFolderId` is bound;
  `getIdentity` = `dropbox:<folderId>` (drives identity-change handling).
- The incremental checkpoint (delta cursor + file-map cache) is owned by the FS's
  `checkpoint` capability (`hasCheckpoint` / `resetCheckpoint` / `commitCheckpoint`,
  inherited from `CachingRemoteFs`): both live in the per-target IndexedDB store and
  commit in **one transaction** (ADR 0001) — the cursor is no longer kept in settings.
- `readBackendState` writes back refreshed tokens only; it never touches the cursor.
  The remote path is never persisted (it is resolved from the folder id on demand).
- `clearCheckpointStore` drops the per-target store by its settings key when there is
  no live FS (e.g. an expired backend), so a stale checkpoint can't survive a disconnect.

### Remote vault resolution & default

`resolveRemoteVault` binds the vault on first connect by find-or-creating
`/<name>` directly under the App Folder root, where `name` is the folder name
queued by the in-app modal (`pendingPickedFolderPath`) or, by default, the vault
name — so the **default sync folder is `App Folder/<vault>`** (the App Folder
scope already namespaces the app, so there is no wrapper folder).
`create_folder_v2` is idempotent, so a picked existing folder (or a second device
with the same vault name) binds to that same folder. A LOCAL vault rename does not
rename the remote folder (it is tracked by id); only `lastKnownVaultName`
advances so `BackendManager`'s name-equality short-circuit resumes.

### Choosing a different folder

When connected, settings offers **Choose folder**, which opens an **in-app modal**
(the shared `AppFolderPickerModal`, `ui/app-folder-picker.ts`) — the same pattern as
OneDrive, no web Chooser or relay page:

- The modal lists the folders directly under the App Folder root
  (`client.listAppRootFolders()`, i.e. `list_folder` on path `""`) and lets the
  user pick an existing one or type a new name. Because the App Folder scope only
  ever sees folders under the App Folder, an in-app list is honest — the old
  Chooser browsed the whole Dropbox and then had to reject picks outside the app
  folder.
- On confirm, the chosen name is written to `pendingPickedFolderPath` and the
  default-bind action runs, so `resolveRemoteVault` find-or-creates `/<name>`
  (idempotent `create_folder_v2`) and binds its id. No CSRF nonce or deep link is
  involved — there is no browser round-trip.
- Changing the folder resets the cursor (and, via the identity change, clears
  per-path sync state), so the next sync is a cold reconcile against the new
  folder.

`getRemoteVaultDisplayPath` resolves the bound folder's current path from its id
(`get_metadata`) for the read-only settings display — through a **detached** auth
so the UI read can't reset the live sync's in-memory tokens.

### createFs() contract

`createFs()` returns `null` unless a token and a `remoteVaultFolderId` are both
present; otherwise it builds a `DropboxFs` from the id (no path) and seeds the
committed cursor.
