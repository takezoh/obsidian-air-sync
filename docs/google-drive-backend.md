# Google Drive Backend

## GoogleDriveFs

`GoogleDriveFs` (`fs/googledrive/index.ts`) implements `IFileSystem` for Google Drive. It avoids downloading file content during `list()` and `stat()` by maintaining an in-memory metadata cache. Content is only downloaded when `read()` is called.

### Initialization lifecycle

The remote delta cursor (`changesPageToken`) has a single source of truth: the `MetadataStore` (IndexedDB, keyed `{vaultId}-{remoteVaultFolderId}`), where it is stored in `META_STORE` **alongside the file map and committed in the same transaction** (see [ADR 0001](adr/0001-metadata-cache-is-subordinate-to-commit-last.md)). It is **not** kept in `settings`. The cursor advances only on a fully-successful sync; see [Crash recovery](sync-pipeline.md#crash-recovery).

On first `list()`, `stat()`, `read()`, or `write()`, `ensureInitialized()` runs:

1. **Checkpoint present** (file map + cursor restored together): `loadFromCache()` reads both the file map and the cursor (`META_STORE`) from IndexedDB — they were committed in one transaction, so a checkpoint exists only when **both** are present. An incremental replay is warranted.
2. **No checkpoint** (genuine first sync, an empty/missing store, or after a rescan / state clear): `fullScan()` clears the cache, fetches a fresh changes start token BEFORE listing (so changes that land during the scan are not missed), runs `listAllFiles()` recursively with `AsyncPool(3)` concurrency, builds the `DriveMetadataCache` from the flat file list, and marks the FS initialized. No replay is warranted — the token is "now". Persistence is deferred to the checkpoint commit (a clean cycle), not eager.

`list()` and `getChangedPaths()` apply an incremental `changes.list` only when a replay is warranted (checkpoint restored, or the FS was already initialized); a fresh full scan reports no delta. The cache is scoped to `vaultId` so a plugin reinstall (which regenerates `vaultId`) starts with a fresh cache, preventing stale entries.

### Cache invalidation

`getChangedPaths()` is the sole entry point for remote change detection (`IFileSystem` contract). It runs under the cache mutex (`cacheMutex.run`), calls `ensureInitialized()`, and:

- Returns `null` when no replay is warranted — a fresh full scan just captured "now", so there is no delta (initial sync).
- Otherwise calls `applyIncrementalChanges()` from the current cursor (see [Incremental sync](#incremental-sync)). The collected `changedPaths` are split into `modified`/`deleted` by checking whether each path still exists in the cache (`cache.hasFile(path)`).
- A 410 from `changes.list` (expired token) is converted to `needsFullScan` and falls back to `fullScanWithDelta()`.

`fullScanWithDelta()` is reached only on the 410 path (the cache is already populated). It snapshots the old paths-by-Drive-ID, performs a full scan, then diffs old vs new **by Drive file ID only**: a new ID is `modified` (added), a moved ID (different path) is a `renamed`+`modified`+`deleted`, and an ID present before but absent after is `deleted`. Because it keys on file ID, it **cannot see in-place content edits** (same path + same ID) -- those surface on the next incremental sync or via warm mode's local-vs-record check. It returns `null` only when there is no prior snapshot.

### Mutex protection

All cache reads and writes are protected by `cacheMutex` (an `AsyncMutex`). Write operations use `withCacheMutex()` which:
1. Resolves IDs/paths under the mutex, producing a `{ path, expectedId }` stale-guard descriptor before any I/O
2. Executes network I/O outside the mutex
3. Re-acquires the mutex and skips the cache update (logging a warning) if `expectedId` is set and the cache's current Drive ID for that path no longer equals `expectedId` -- i.e. a concurrent operation re-keyed the path during the I/O

### stat() and hash

`stat()` always returns `hash: ""`. The sync engine uses `backendMeta.contentChecksum` (Drive's `md5Checksum`) for remote change detection via `hasRemoteChanged()`. This avoids downloading file content just to compute a hash.

`stat()` and `read()` deliberately do NOT apply incremental changes -- `list()` is always called first in the sync cycle and refreshes the cache, so these only read it. For folders, the returned entity is `{ isDirectory:true, size:0, mtime:0, hash:"" }` with no `backendMeta`.

### Hiding `.airsync/metadata.json`

`.airsync/metadata.json` is a **legacy** backend-internal file. New vaults never create it — the remote vault is now identified by its folder name (`obsidian-air-sync/<Vault Name>`, see below) — but older vaults may still have one, and a device still running an older plugin version could write one, so the exclusion guards are retained as belt-and-suspenders. `GoogleDriveFs` keeps any such file out of the sync engine by **never ingesting it into the metadata cache** (`INTERNAL_METADATA_PATH`, defined in `sync/remote-vault.ts`; skipped in `DriveMetadataCache.bulkLoad` and `applyFileChange`). Because every read path is cache-backed, that one exclusion covers `list()`, `stat()`, `read()`, `delete()`, `listDir()`, and `getChangedPaths()` uniformly. The single write path that doesn't consult the cache — `write()` (upload) — `throws` for this path rather than fabricating a baseline. (Migration reads/deletes a legacy `metadata.json` out of band via the raw `DriveClient`, never through the `IFileSystem` surface — see Remote vault resolution below.)

The sync engine also reserves the same path symmetrically in `SyncOrchestrator.isExcluded()`, so it is never pushed/pulled/deleted from the local side either — even when the user opts `.airsync` into `syncDotPaths`. (Remote-side hiding alone would be unsafe: a local copy could be pushed, a synthetic write would commit a baseline, and the next cycle would `delete_local` it as a phantom remote deletion. The orchestrator exclusion is the authoritative guarantee; the cache-level skip is enumeration hygiene.)

## DriveMetadataCache

`DriveMetadataCache` (`metadata-cache.ts`) maintains 4 indexes:

| Index | Type | Purpose |
|-------|------|---------|
| `pathToFile` | `Map<string, DriveFile>` | Primary lookup by relative path |
| `idToPath` | `Map<string, string>` | Reverse lookup for changes.list processing |
| `folders` | `Set<string>` | Track which paths are folders |
| `children` | `Map<string, Set<string>>` | Parent-to-children index for O(k) child lookups |

Key operations:
- `buildFromFiles(files)`: builds the cache from a flat `DriveFile[]` list. Uses memoized path resolution (`resolveFilePathCached()`) to compute relative paths from parent chains in O(n) total.
- `applyFileChange(file)`: handles a single incremental change -- resolves path from cache, handles renames/moves, maintains all indexes.
- `applyFileChangeDetectMove(file)`: wraps `applyFileChange()` with before/after path comparison. Returns `{ oldPath, newPath, wasFolder, oldDescendants }` for move detection.
- `removeTree(path)`: removes a path and all descendants (via `collectDescendants()`).
- `rewriteChildPaths(old, new)`: rewrites descendant paths when a folder is renamed.
- `driveFileToEntity(path, driveFile)`: converts cached metadata to `FileEntity` without downloading content. Folders → `{ isDirectory:true, size:0, mtime:0, hash:"" }` (no `backendMeta`). Files → `size = parseInt(size||"0")`, `mtime = new Date(modifiedTime).getTime()` (0 if NaN/absent), `hash:""`, `backendMeta:{ driveId, contentChecksum: md5Checksum }`. This `contentChecksum == Drive md5` is what makes hash-enrichment and `hasRemoteChanged()` work without a download.

## Incremental sync

`applyIncrementalChanges()` (`incremental-sync.ts`) integrates with Drive's changes.list API:

1. Fetch changes pages using the stored `changesPageToken`
2. Sort each page: folders first (shallow before deep) so parent paths resolve correctly before children
3. For each change:
   - **Removed/trashed**: collect descendants, call `cache.removeTree()`, add all paths to `changedPaths`
   - **Modified/created**: call `cache.applyFileChangeDetectMove()`, add resolved path to `changedPaths`. If a move is detected (oldPath ≠ newPath), add oldPath to `deletedPaths` and record in `renamedPaths`
   - If a tracked item moves out of the sync root (old path known, new path unresolvable), its old path -- and, if it was a folder, its old descendant paths -- are reported as deleted
   - When a folder is moved or renamed (it was a folder and oldPath ≠ newPath), all of its new descendant paths are additionally re-emitted as modified/updated, because their resolved paths shifted
4. `applyIncrementalChanges()` mutates only the in-memory cache and advances the cursor in memory (`IncrementalChangesResult.newToken`); it does **not** persist. Persistence is deferred to the checkpoint commit (`commitDriveCache`, called by the orchestrator after a fully-successful cycle), which writes the touched file records **and** the cursor (`META_STORE`) in one atomic transaction (`commitIncremental`), or rewrites the whole map after a full scan (`saveAll`). See [Crash recovery](sync-pipeline.md#crash-recovery)
5. Return `{ newToken, changedPaths, renamedPaths }` or `{ needsFullScan: true }` on 410

The 410 fallback triggers `fullScanWithDelta()` which compares persisted metadata against the fresh cache to compute renames, additions, and deletions.

## DriveClient

`DriveClient` (`client.ts`) wraps the Google Drive REST API v3 using Obsidian's `requestUrl` (CORS-free via Electron's net module).

**Requested fields** (`FILE_FIELDS`): `id, name, mimeType, size, modifiedTime, parents, md5Checksum`

Key methods:

| Method | Description |
|--------|-------------|
| `listAllFiles(rootId)` | Recursive listing with `AsyncPool(3)` concurrency |
| `uploadFile(...)` | Multipart upload for files <= 5 MB, delegates to `ResumableUploader` for larger files |
| `downloadFile(fileId)` | `GET /files/{id}?alt=media` |
| `getChangesStartToken()` | `GET /changes/startPageToken` |
| `listChanges(token)` | `GET /changes?pageToken=...` with full file metadata |
| `deleteFile(fileId)` | Soft delete (trash) by default, permanent delete optional |
| `findChildByName(parentId, name, mimeType?)` | Query `'<parent>' in parents and name = '<escaped name>' and trashed = false` (plus optional `mimeType`), `pageSize` 1; returns the first match or null. Both parent ID and name are backslash/quote-escaped. Dedupes folder creation against Drive's same-name-folder behavior |
| `updateFileMetadata(...)` | PATCH for rename/move with `addParents`/`removeParents` |

### Transport-level 401 retry

`request()` injects `Authorization: Bearer <token>` and, on a 401 from the first attempt only, forces a token refresh via `getToken(true)` and retries the request exactly once (guarded by the `retried` flag). Every Drive error is re-thrown as `Error("Drive API <operation> failed: <msg>")` that copies `status`, `headers`, and `json` from the original, so `getErrorInfo()` (status/headers) and `isRateLimitError()` (json) can classify it -- and so upstream 410 (changes-token-expired) and 308 (resumable-resume) handling can read them.

## Authentication

Two OAuth implementations share a common base class (`GoogleAuthBase`). The server side of the built-in flow — the `auth-airsync.takezo.dev` endpoints — lives in the dedicated [air-sync-auth](https://github.com/takezoh/air-sync-auth) repo.

### GoogleAuth (server-side, built-in)

- Redirects to Google OAuth with `redirect_uri = https://auth-airsync.takezo.dev/google/callback`, `client_id` = the built-in public client ID, `access_type=offline`, and `prompt=consent`
- Auth server exchanges the code for tokens (confidential client with `client_secret`)
- Plugin receives tokens via `obsidian://air-sync-auth?access_token=...&refresh_token=...`
- Token refresh: POST `https://auth-airsync.takezo.dev/google/token/refresh` with JSON body `{ refresh_token }`
- Scope: `drive.file` (app-created files only)

### GoogleAuthDirect (PKCE, custom credentials)

- User provides their own `client_id` and `client_secret`
- Uses PKCE (S256 code challenge) for the authorization flow
- Auth server relays the code back without exchanging it
- Plugin exchanges code and refreshes tokens directly with Google's token endpoint
- Defaults: scope `https://www.googleapis.com/auth/drive.file`, redirect URI `https://airsync.takezo.dev/callback` (distinct from the built-in flow's `auth-airsync.takezo.dev/google/callback`). The PKCE code verifier is a 64-character random string and the state nonce is a 32-character string (embedded in a base64-encoded JSON state object); the challenge is `base64url(SHA-256(verifier))` with `code_challenge_method=S256`. `include_granted_scopes=true` is sent only when the optional `includeGrantedScopes` flag is set (default false). Code exchange and refresh both POST to `https://oauth2.googleapis.com/token` with `client_id` and `client_secret`; exchange additionally sends `code_verifier`, `code`, and `redirect_uri` (`grant_type=authorization_code`), while refresh sends `refresh_token` (`grant_type=refresh_token`)

### Shared behavior (GoogleAuthBase)

- Refresh deduplication: concurrent `getAccessToken()` calls share one in-flight refresh promise
- Proactive refresh: refreshes 60 seconds before expiry
- CSRF protection: random state parameter verified on callback
- Auth failure cooldown: on a 400/401 refresh failure, `handleRefreshError()` records `authFailedAt = Date.now()`. For the next `AUTH_FAILED_COOLDOWN` (60 s) any `getAccessToken()` throws `AuthError` (status 401) immediately without hitting the network; after 60 s it retries the refresh. A successful `setTokens()` / token response resets the timer (`authFailedAt = 0`). Non-400/401 refresh errors are re-thrown unchanged and do not arm the cooldown
- Token revocation: POST to `oauth2.googleapis.com/revoke`

### Token storage

Tokens (`refreshToken`, `accessToken`) are stored in Obsidian's `SecretStorage` via `token-store.ts`, never in `settings.backendData`. Only non-secret data lives in `settings.backendData`: `remoteVaultFolderId`, `accessTokenExpiry`, and `pendingAuthState`/`pendingCodeVerifier` (transient, to survive a plugin reload mid-flow), plus the custom-OAuth fields. The delta cursor is **not** here — it lives in the `MetadataStore` (`META_STORE`), co-located with the file map (ADR 0001) (`customClientId`/`customClientSecret` are SecretStorage secret-name references, `customScope`, `customRedirectUri`, `customIncludeGrantedScopes`).

## Resumable upload

`ResumableUploader` (`resumable-upload.ts`) handles files > 5 MB (`RESUMABLE_THRESHOLD`):

1. Initiate a resumable upload session (POST/PATCH with `uploadType=resumable`)
2. Upload the entire content in a single PUT (chunked upload is avoided due to Obsidian's `requestUrl` limitations with 308 responses)
3. On failure, cache the upload URL (6-hour TTL) so the next retry can resume:
   - Resume entries are keyed by `existingFileId` (or `${parentId}/${name}` for new files), reused only if the cached `totalSize` equals the current byte length and `createdAt` is within the 6 h TTL, and are deleted before the resume attempt so a failed resume falls through to a fresh upload
   - Query Google for bytes received with a status `PUT` carrying `Content-Range: bytes */total`. A 200/201 means the upload already completed (returns the `DriveFile`); on 308 the `range: bytes=0-N` header gives `bytesReceived = N+1` (0 if unparseable); any other status returns null and the caller restarts a fresh upload
   - Send only the remaining `content.slice(bytesReceived)` with `Content-Range: bytes <recv>-<total-1>/<total>`

## Provider model

### GoogleDriveProvider (built-in)

- Type: `"googledrive"`
- Uses `GoogleAuth` (server-side OAuth)
- `resolveRemoteVault()`: finds or creates `obsidian-air-sync/<Vault Name>` in Drive. Invoked **explicitly** when the user binds the default folder (the "default folder" button → `BackendManager.bindDefaultRemoteVault()`), **not** automatically on connect

### GoogleDriveCustomProvider (user credentials)

- Type: `"googledrive-custom"`
- Uses `GoogleAuthDirect` (PKCE with user-provided `client_id` / `client_secret`)
- Requires `remoteVaultFolderId` to be set manually in settings; its `resolveRemoteVault()` override throws (`"Remote vault folder id is required for custom OAuth"`) when it is unset
- On disconnect, preserves custom credential references and folder ID

Both extend `GoogleDriveProviderBase` which handles `createFs()`, `readBackendState(fs)` (persists only non-secret token state — the cursor is committed atomically with the cache by `commitCheckpoint`, not here), `commitCheckpoint(fs)` (forwards to the FS), and `disconnect()` (also clears the per-target `MetadataStore`). The "is there a checkpoint?" query and the checkpoint reset now live on the FS: `IFileSystem.hasCheckpoint()` (async, reads `META_STORE`) and `resetCheckpoint()` (clears the cursor + cache; used by an identity change and the **Rescan vault** action).

### Remote vault resolution

Layout: `<Drive root>/obsidian-air-sync/<Vault Name>` — the folder **name is the vault name**; there is no `.airsync/metadata.json`. Binding is always explicit (the user picks a folder in the Google Picker, or presses the default-folder button); nothing is auto-bound on connect. The default-folder button calls `resolveRemoteVault()`, which builds a `DriveClient` and calls `resolveGDriveRemoteVault()` (returns `{ remoteVaultFolderId }`):

- If `remoteVaultFolderId` is cached, `resolveLinked()` just confirms the folder is accessible via `getFile()`.
- Otherwise it find-or-creates the root `obsidian-air-sync` folder, then:
  1. **Migration:** lists the root's child folders and, for each, reads a legacy `.airsync/metadata.json`; if one's `vaultName` matches, it renames that folder to the vault name (`updateFileMetadata`), trashes the legacy `metadata.json` (`deleteFile`), and binds it — preserving the already-synced data while keeping the folder id stable for other devices.
  2. **By name:** otherwise find-or-creates `obsidian-air-sync/<Vault Name>` (`findChildByName` / `createFolder`) and binds it.

Bound folders picked via the Google Picker are addressed purely by id (`completeWebFolderPick`), independent of this layout.

### createFs() contract

`createFs()` returns null unless both a refresh token (SecretStorage) and `remoteVaultFolderId` exist. It instantiates a `MetadataStore` keyed `${vaultId}-${remoteVaultFolderId}` (`dbNamePrefix` `air-sync-drive`, version 1) and seeds the auth with the stored tokens and `accessTokenExpiry`. It does **not** seed the cursor — the FS restores it (with the file map) from the `MetadataStore` on first init (`loadFromCache`).
