# Air Sync -- Architecture

## Design principles

1. **3-state sync** -- Compare local, remote, and last-sync-record to detect changes. Text conflicts use 3-way merge.
2. **Swappable backends** -- All remote I/O goes through `IFileSystem` + `IBackendProvider`. Adding a backend requires no changes outside `fs/`.
3. **Delta-first** -- Only process files that changed. O(n) full scans are allowed only on cold start and crash recovery (when no committed remote checkpoint exists).
4. **Pipeline as data** -- Each sync phase is a pure transformation: `ChangeSet → SyncPlan → Result`. I/O is isolated at boundaries; all intermediate states are testable.
5. **Crash-safe by construction** -- State is committed only *after* success: per-file baselines after each action, and the remote delta checkpoint only when the whole cycle succeeds (`failed === 0`). An interrupted sync converges by re-syncing — delta-replay from the last committed checkpoint, or a full cold reconcile when none is committed.
6. **Duplicate over delete** -- When in doubt, keep the file. Deleting an unwanted copy is easy; recovering a lost file is impossible.
7. **Single responsibility per module** -- Each file owns one concept. Target 200-300 lines; split when exceeded.

## Module map

One row per directory; see the layer diagram and per-doc references for module detail.

| Path | Responsibility |
|------|----------------|
| `main.ts` | Plugin entry point — lifecycle only: load settings, register commands, wire components, handle the OAuth protocol callback. |
| `settings.ts` | `AirSyncSettings` type and `DEFAULT_SETTINGS`; `settings-normalize.ts` lifts a legacy per-type `backendData` map into the active flat bag on load. |
| `sync/` | The sync pipeline and its orchestration: change tracking and detection (hot/warm/cold), the decision engine, rename optimization, plan execution (3-phase lane/tier scheduling), per-action state commit, conflict resolution and 3-way merge, the orchestrator (mutex/retry/status), the scheduler (vault events + triggers), the IndexedDB `SyncStateStore`, error classification, and the conflict-history audit writer. |
| `fs/` | Backend-agnostic contracts and lifecycle: `IFileSystem` + `IncrementalCheckpoint`, `IAuthProvider`, `IBackendProvider` + `WebFolderPicker`, `FileEntity`/`RemoteChecksum`, the provider registry, error classification (`errors.ts`), the OAuth PKCE helper (`oauth-pkce.ts`), the backend settings-renderer contract (`settings-renderer.ts`), `BackendManager`, and the `ISecretStore`/token-store wrappers over Obsidian SecretStorage. |
| `fs/caching/` | Shared base for id-addressed remote backends: `CachingRemoteFs<T>` (path↔id resolution and the `IncrementalCheckpoint` checkpoint lifecycle, ADR 0001) and `AbstractMetadataCache<T>`. Google Drive, Dropbox, OneDrive, and pCloud all build on it. The id-keyed delta apply (`id-delta.ts`) makes their remote-rename detection order-independent for free (ADR 0006). |
| `fs/local/` | `LocalFs` (Obsidian Vault API wrapper) plus the raw adapter for dot-prefixed paths. |
| `fs/googledrive/` | The Google Drive backend: `GoogleDriveFs` with metadata cache, the REST v3 `GoogleDriveClient`, server + PKCE auth, the path↔ID `GoogleDriveMetadataCache`, incremental sync (changes.list), resumable upload, remote-vault resolution, the Google Drive types, and the built-in (`provider-base.ts`) / custom (`provider-custom.ts`) OAuth providers. |
| `fs/dropbox/` | The Dropbox backend (App Folder scope): `DropboxFs` with a relative-path-keyed `DropboxMetadataCache`, the HTTP v2 `DropboxClient`, in-plugin Authorization Code + PKCE auth (worker-less), incremental sync (`list_folder/continue` + cursor), and the `"dropbox"` `content_hash` checksum. The vault is addressed solely by its **stable folder id** (`id:<id>/<subpath>` for every operation — no absolute path is stored), so a remote move/rename of the folder keeps syncing with no migration. The current absolute path is re-resolved from the id each cycle (`get_metadata`) only to relativize `list_folder`'s absolute results into vault-relative keys, and for the settings display. Its path-addressed delta encodes a rename as a `deleted(old)`+`add(new)` pair and is applied upserts-before-deletes so detection is order-independent like the id-addressed backends (ADR 0006). |
| `fs/onedrive/` | The OneDrive backend (App Folder scope, personal Microsoft accounts): `OneDriveFs` with `OneDriveMetadataCache` over the Microsoft Graph v1.0 `OneDriveClient`, worker-less Authorization Code + PKCE auth, incremental sync (`/delta`), chunked `upload-session.ts`, remote-vault resolution, and the `"quickxor"` QuickXorHash checksum — computed locally (`utils/quickxor.ts`) so cross-side dedup works. Like Google Drive it addresses items by **stable driveItem id**. |
| `fs/pcloud/` | The pCloud backend: `PCloudFs` with metadata cache, the JSON `PCloudClient` (hand-built multipart upload), code-flow OAuth (long-lived token, no refresh), the path↔id `PCloudMetadataCache`, and the provider. Incremental sync uses the account-wide `diff` for **Full-access** apps; a **Specific-folder-only** app can't call `diff` (result 2096), so `getStartCursor()` returns an empty cursor and the orchestrator cold-reconciles every cycle (full `listfolder` × baseline). Content change detection uses pCloud's opaque content hash (`remoteChecksum.algo === "opaque"`). |
| `ui/` | Settings UI: the main settings tab, the backend-connection section, and the per-backend settings (Google Drive / Dropbox / OneDrive / pCloud) and folder-pick modals. |
| `store/` | IndexedDB plumbing: the `IDBHelper` transaction wrapper, the generic `MetadataStore<T>` file-metadata cache, and `content-codec` (deflate compression for stored 3-way merge base content). |
| `logging/` | `Logger` — structured log writer (`.airsync/logs/`). |
| `queue/` | Concurrency primitives: `AsyncPool` (fixed bounded concurrency), `AdaptivePool` (AIMD concurrency for the transfer phase — ramps on success, halves on a rate-limit), and `AsyncMutex`. |
| `utils/` | Helpers: `sha256()` / `md5()` hashing, the QuickXorHash implementation (`quickxor.ts`) for OneDrive, path utilities (`getFileExtension`, etc.), gitignore-style `isIgnored()` pattern matching, and line parsing (`parse-lines.ts`). |

## Layer architecture

```
┌──────────────────────────────────────────────────────┐
│  main.ts                                             │
│  Plugin lifecycle: load settings, register commands, │
│  wire up components, handle OAuth protocol callback  │
└────────────┬──────────────────────┬──────────────────┘
             │                      │
     ┌───────▼───────┐    ┌────────▼─────────┐
     │ SyncScheduler │    │  BackendManager   │
     │ vault events, │    │  auth flow,       │
     │ timers,       │    │  remote vault     │
     │ file-open     │    │  resolution,      │
     │ priority sync │    │  IFileSystem init  │
     └───────┬───────┘    └────────┬─────────┘
             │                      │
     ┌───────▼──────────────────────▼──────┐
     │         SyncOrchestrator            │
     │  mutex, retry loop (3x + backoff), │
     │  status transitions, pullSingle     │
     └───────────────┬────────────────────┘
                     │
     ┌───────────────▼────────────────────┐
     │            Pipeline                │
     │                                    │
     │  collectChanges()                  │  ChangeDetector
     │    collect (hot / warm / cold)     │    temperature modes
     │    enrichHashesForInitialMatch()   │    local digest vs remoteChecksum
     │        │                           │
     │        ▼                           │
     │  planSync()                        │  DecisionEngine
     │        │                           │    9 action types
     │        ▼                           │
     │  refinePlan()                      │  RenameOptimizer
     │    optimizeLocalFileRenames         │    → rename_remote (hash-verified)
     │    optimizeRemoteFileRenames        │    → rename_local  (trusted)
     │        │                           │
     │        ▼                           │
     │  executePlan()  (3 phases)         │  PlanExecutor
     │    1 transfers: push/pull          │    AdaptivePool (AIMD); match/cleanup inline
     │    2 conflict (serial)             │    own phase (sibling-path safe)
     │    3 structural: 2 lanes ||        │    remote & local, concurrent
     │      per lane: rename then del     │    rename serial; delete pooled
     │        │                           │
     │        ▼                           │
     │  commitAction()  (per action)      │  StateCommitter
     └───────────────┬────────────────────┘
                     │
         ┌───────────────────────────────────────────────────────────────┐
         │                          IFileSystem                          │
         │  LocalFs │ GoogleDriveFs │ DropboxFs │ OneDriveFs │ PCloudFs  │
         └───────────────────────────────────────────────────────────────┘
```

`runSync` early-returns when no remote backend is present, the backend is connecting, or layout is not ready; it serializes via an `AsyncMutex`. A sync arriving while one runs sets a `syncPending` flag and the running cycle re-runs via a `do/while` loop (coalescing). Each cycle retries up to `MAX_RETRIES = 3`: `AuthError` (status 401) and a non-rate-limit HTTP 403 abort the whole sync immediately; HTTP 404 breaks the retry loop without special handling. For 429 or a rate-limit 403 carrying a `Retry-After` header, delay = `retryAfter * 1000` ms; otherwise exponential backoff with jitter = `2^(attempt-1) * 1000 * (0.5 + Math.random())` ms. See [docs/error-handling.md](docs/error-handling.md) for the full classification/recovery table.

## Core data models

### FileEntity (fs/types.ts)

```typescript
type ChecksumAlgo = "md5" | "sha1" | "sha256" | "dropbox" | "quickxor" | "opaque";
interface RemoteChecksum { algo: ChecksumAlgo; value: string; }

interface FileEntity {
  path: string;          // relative path from sync root
  isDirectory: boolean;
  size: number;          // bytes (0 for directories)
  mtime: number;         // Unix epoch ms (0 = unknown)
  hash: string;          // SHA-256 hex ("" = not computed)
  remoteChecksum?: RemoteChecksum;         // remote-provided checksum, tagged with its algorithm
  backendMeta?: Record<string, unknown>;  // backend-specific, e.g. { googleDriveId } (Google Drive), { dropboxId, rev } (Dropbox), or { pcloudId } (pCloud)
}
```

Invariant: mtime/hash comparisons must treat sentinels as "no data" — mtime 0 is not the epoch, and hash is always `""` for directories. `hasChanged`/`hasRemoteChanged` only use mtime when both values are > 0.

`remoteChecksum` carries a remote-supplied content checksum when the backend returns `hash: ""`. It powers temporal change detection (remote-now vs last-sync) and, when the algo is locally reproducible (everything except `"opaque"`), cross-side dedup: Google Drive uses `"md5"`, Dropbox its block-based `"dropbox"` `content_hash`, OneDrive Microsoft's `"quickxor"`, and a pCloud-style opaque hash is `"opaque"`.

### SyncRecord (sync/types.ts)

The baseline snapshot stored per path after each successful sync.

```typescript
interface SyncRecord {
  path: string;            // primary key
  hash: string;            // content hash at last sync
  localMtime: number;      // local mtime at last sync
  remoteMtime: number;     // remote mtime at last sync
  localSize: number;
  remoteSize: number;
  remoteChecksum?: RemoteChecksum;  // remote checksum at last sync (for change detection)
  backendMeta?: Record<string, unknown>;
  syncedAt: number;        // when this sync completed
}
```

### MixedEntity (sync/types.ts)

Combined view of a path across local, remote, and baseline state. Input to the decision engine.

```typescript
interface MixedEntity {
  path: string;
  local?: FileEntity;
  remote?: FileEntity;
  prevSync?: SyncRecord;
}
```

### SyncAction / SyncPlan (sync/types.ts)

```typescript
type SyncActionType =
  | "push" | "pull"
  | "delete_local" | "delete_remote"
  | "rename_remote" | "rename_local"
  | "conflict" | "match" | "cleanup";

type SyncAction = StandardSyncAction | RenameAction;

interface StandardSyncAction {
  path: string;
  action: Exclude<SyncActionType, "rename_remote" | "rename_local">;
  local?: FileEntity;
  remote?: FileEntity;
  baseline?: SyncRecord;
}

interface RenameAction {
  path: string;
  action: "rename_remote" | "rename_local";
  oldPath: string;
  isFolder?: boolean;          // when true, oldPath/path are folder paths and descendants lists affected children
  descendants?: RenamePair[];  // descendant path mappings consumed by this folder rename
  local?: FileEntity;
  remote?: FileEntity;
  baseline?: SyncRecord;
}

interface SyncPlan {
  actions: SyncAction[];
}
```

`match` is emitted only when local and remote have equal non-empty hashes and equal sizes with no baseline (identical files first seen together); otherwise `conflict`. `cleanup` is emitted when a baseline exists but neither side does (both deleted). Both are state-only and perform no file I/O: `match` upserts a SyncRecord (the files are now in sync), while `cleanup` DELETES the baseline SyncRecord (the path is gone on both sides).

### Supporting types (sync/types.ts)

```typescript
// Orchestrator / status-bar state machine
type SyncStatus = "idle" | "syncing" | "error" | "partial_error" | "not_connected";

// User-facing conflict resolution strategy (settings.conflictStrategy)
type ConflictStrategy = "auto_merge" | "duplicate";

// Source/destination path pair for rename detection (also used by IFileSystem.getChangedPaths)
interface RenamePair {
  oldPath: string;
  newPath: string;
  isFolder?: boolean;  // true = folder rename
}

// Audit record of a resolved conflict (see docs/conflict-resolution.md)
interface ConflictRecord {
  path: string;
  actionType: SyncActionType;
  strategy: ConflictStrategy;
  action: "kept_local" | "kept_remote" | "duplicated" | "merged";
  // ... local?, remote?, duplicatePath?, hasConflictMarkers?, resolvedAt, sessionId
}
```


## IFileSystem interface

All paths are relative to the sync root, forward-slash separated, no leading/trailing slashes.

```typescript
interface IFileSystem {
  readonly name: string;
  list(): Promise<FileEntity[]>;
  stat(path: string): Promise<FileEntity | null>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity>;
  mkdir(path: string): Promise<FileEntity>;
  listDir(path: string): Promise<FileEntity[]>;
  delete(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  checkpoint?: IncrementalCheckpoint;  // present only for backends with incremental sync
  close?(): Promise<void>;
}

// A backend's incremental-sync capability — all-or-nothing. A backend that can
// detect deltas MUST expose the full crash-safe checkpoint lifecycle, so the four
// methods travel together on one object (ADR 0001).
interface IncrementalCheckpoint {
  getChangedPaths(): Promise<{
    modified: string[];
    deleted: string[];
    renamed?: RenamePair[];  // RenamePair = { oldPath, newPath, isFolder? }
  } | null>;
  hasCheckpoint(): Promise<boolean>;   // committed delta cursor present? false ⇒ force a cold reconcile
  resetCheckpoint(): Promise<void>;    // discard cursor + derived cache (used by Rescan)
  commitCheckpoint(): Promise<void>;   // atomically flush cursor + cache, ONLY after a fully-successful cycle
}
```

Key design points:

- `list()` may return `hash: ""` for performance; use `stat()` when an accurate hash is needed. `LocalFs.stat()` is authoritative: on a vault-index miss it falls back to the filesystem adapter, so a not-yet-indexed file on disk is never reported absent (absence drives deletions).
- **Dot-prefixed (hidden) paths bypass the indexed Vault API.** Obsidian's vault index excludes any hidden path (`.airsync`, `.obsidian`, nested `foo/.bar`), so `getAbstractFileByPath()` returns `null` and `vault.createBinary()` either returns `null` (→ NPE on `.stat`) or throws `File already exists`. `LocalFs` therefore routes every operation on a dot-prefixed path (`isDotPrefixed()`, `utils/path.ts`) through `DotPathAdapter` (the raw `vault.adapter`, which overwrites and is index-independent). This is a **mechanism** decision (which API to use) and is independent of sync **policy** (whether to sync it) — policy is `syncDotPaths` + `ignorePatterns`, enforced separately by `SyncOrchestrator.isExcluded()`. `list()` only enumerates hidden paths under configured `syncDotPaths` roots (it cannot scan every hidden folder, e.g. `.obsidian`), so a hidden path is synced only when opted in. `isExcluded()` also drops OS-generated junk (`desktop.ini`, `thumbs.db`, `.DS_Store` — `isSystemJunkFile()`) unconditionally on every backend, like the reserved metadata path: these are never worth syncing and some backends (Dropbox) reject them outright, which would otherwise fail every cycle and block the delta checkpoint.
- `checkpoint` is optional; when present, `checkpoint.getChangedPaths()` should be called before `list()`. When implemented (e.g. Google Drive `changes.list`, Dropbox `list_folder/continue`, OneDrive delta query) it supplies the remote-side changed/deleted/renamed paths consumed by both hot and warm change detection (the hot path is triggered by the local change tracker's dirty paths, not by this method). The `renamed` field lets backends report file moves for native rename optimization. The rest of the capability (`hasCheckpoint`/`resetCheckpoint`/`commitCheckpoint`) makes the delta cursor crash-safe — see the checkpoint lifecycle below.
- `delete()` is idempotent (deleting a non-existent path is a no-op) and backends may use soft deletion (trash). Deleting a directory removes its children recursively; the caller must separately clean up the SyncRecord for each removed child path (`delete()` does not touch sync state).
- `write()` auto-creates parent directories.
- `rename(oldPath, newPath)` throws if `oldPath` does not exist or if `newPath` already exists (the rename optimizer relies on the latter to skip occupied destinations); it auto-creates parent directories. `mkdir()` is idempotent and throws if an intermediate component is an existing file.

## IBackendProvider / IAuthProvider

### IBackendProvider (fs/backend.ts)

Abstraction for a remote storage backend. main.ts and sync/ never import backend-specific modules directly.

```typescript
interface IBackendProvider {
  readonly type: string;             // "googledrive", "googledrive-custom", "dropbox", "onedrive", "pcloud". Stable, unique registry key;
                                     // also indexes settings.backendData and per-backend secrets. Immutable once published.
  readonly displayName: string;
  readonly auth: IAuthProvider;
  createFs(app, settings, logger?): IFileSystem | null;
  isConnected(settings): boolean;
  getIdentity(settings): string | null;
  createSettingsRenderer?(): IBackendSettingsRenderer;   // the backend's own settings-UI renderer (registry is the source of truth)
  classifyError?(err): ErrorClassification;              // map this backend's I/O errors to a retry-policy kind
  readBackendState?(): Record<string, unknown>;          // non-secret provider/auth state to persist in backendData (no FS arg)
  resolveRemoteVault?(app, settings, vaultName, logger?): Promise<RemoteVaultResolution>;  // find/create the default vault folder
  picker?: WebFolderPicker;          // web-hosted folder-pick flow (Google Picker); Dropbox/OneDrive pick in an in-app modal instead
  getRemoteVaultDisplayPath?(settings, logger?): Promise<string | null>;      // resolve the bound folder's path for settings
  clearCheckpointStore?(settings): Promise<void>;        // clear the per-target IndexedDB checkpoint without needing a live FS
  disconnect(settings): Promise<Record<string, unknown>>;
  clearPluginSecrets?(): void;       // sweep this backend's plugin-owned secrets (used by the backend-switch reset)
}

// The web-hosted folder pick is one object so a backend can't ship half of it.
interface WebFolderPicker {
  startWebFolderPick(settings): Promise<Record<string, unknown>>;             // open the web picker; selection returns via an obsidian:// deep link
  completeWebFolderPick(params, settings, logger?): Promise<RemoteVaultResolution>;  // bind the picked folder (by id)
}
```

The remote delta cursor is crash-safe at the **filesystem** layer, not the provider (it moved there with ADR 0001): `IFileSystem.checkpoint` commits the cursor plus its derived cache to the backend's own IndexedDB store atomically, and only after a fully-successful cycle. When no checkpoint is committed (`checkpoint.hasCheckpoint() === false`: first sync, an interrupted/partial sync, or after a manual rescan) the orchestrator forces a full cold reconcile — delta detection alone can't surface remote files an interrupted sync left un-baselined. `readBackendState()` persists only non-secret provider/auth state (e.g. token expiry) to `settings.backendData`; it no longer carries the cursor, so it takes no FS argument.

`settings.backendData` is a single flat bag holding **only the active backend's** parameters (tokens live in `SecretStorage`, keyed per backend — never in `backendData`). Switching backends hard-resets it: all params are wiped and every registered backend's plugin-owned secrets are swept (`clearPluginSecrets`), so the new backend starts disconnected and can't reuse another's token under the wrong OAuth client.

Remote-vault binding is **explicit**, not automatic on connect. After auth the user either binds the convention folder `obsidian-air-sync/<Vault Name>` (`BackendManager.bindDefaultRemoteVault` → `resolveRemoteVault`, which find-or-creates it and migrates a legacy `obsidian-air-sync/<uuid>` vault if one matches) or picks any folder via the web Google Picker (`provider.picker`: `startWebFolderPick` → `completeWebFolderPick`, bound by id; Dropbox and OneDrive use an in-app modal instead). The folder is the sole binding; there is no `.airsync/metadata.json`. See [docs/google-drive-backend.md](docs/google-drive-backend.md) for the Google Drive specifics.

### IAuthProvider (fs/auth.ts)

```typescript
interface IAuthProvider {
  isAuthenticated(backendData): boolean;
  startAuth(backendData): Promise<Record<string, unknown>>;
  completeAuth(input, backendData): Promise<Record<string, unknown>>;
}
```

The provider registry (`fs/registry.ts`) maps backend types to provider instances. New backends register here; no changes needed elsewhere. `initRegistry(secretStore)` must be called once during plugin load (`main.ts` onload) before any `getBackendProvider` call; it injects `ISecretStore` into the provider constructors. Until then the registry is empty and `getBackendProvider` returns undefined. Built-in providers: `GoogleDriveProvider` (type `googledrive`), `GoogleDriveCustomProvider` (type `googledrive-custom`), `DropboxProvider` (type `dropbox`), `OneDriveProvider` (type `onedrive`), and `PCloudProvider` (type `pcloud`). On a duplicate `type`, the first registration wins (later ones are skipped in the type lookup).

## Detailed documentation

- [Sync pipeline](docs/sync-pipeline.md) -- temperature modes, decision table, execution groups, deletion safety
- [Conflict resolution](docs/conflict-resolution.md) -- strategies, 3-way merge, conflict history
- [Google Drive backend](docs/google-drive-backend.md) -- metadata cache, authentication, and the sole owner of incremental sync / cache invalidation
- [Dropbox backend](docs/dropbox-backend.md) -- App Folder scope, id-only addressing, worker-less PKCE auth, in-app folder modal
- [OneDrive backend](docs/onedrive-backend.md) -- App Folder scope (personal accounts), Microsoft Graph delta-query incremental sync, worker-less PKCE auth, in-app folder modal, locally-computed QuickXorHash
- [pCloud backend](docs/pcloud-backend.md) -- folder-id addressing, account-wide `diff` delta, long-lived token (no refresh), opaque content hash
- [Error handling](docs/error-handling.md) -- resilience: error classification, retry, rate limiting (recovery scenarios cross-reference the sync pipeline)
- [OAuth worker & auth site](https://github.com/takezoh/air-sync-auth) -- server-side Google token exchange plus the static site (privacy/terms, the Google custom-OAuth callback, and the Google Drive Picker page), in the dedicated `air-sync-auth` repo (kept out of this plugin's tree). Dropbox no longer uses this site — its OAuth returns straight to `obsidian://air-sync-auth` and its folder pick is an in-app modal.
