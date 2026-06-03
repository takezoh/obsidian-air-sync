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
| `settings.ts` | `AirSyncSettings` type and `DEFAULT_SETTINGS`. |
| `sync/` | The sync pipeline and its orchestration: change tracking and detection (hot/warm/cold), the decision engine, rename optimization, plan execution (groups A–D), per-action state commit, conflict resolution and 3-way merge, the orchestrator (mutex/retry/status), the scheduler (vault events + triggers), the IndexedDB `SyncStateStore`, error classification, and the conflict-history audit writer. |
| `fs/` | Backend-agnostic contracts and lifecycle: `IFileSystem`, `IAuthProvider`, `IBackendProvider`, `FileEntity`, the provider registry, `AuthError`, `BackendManager`, and the `ISecretStore`/token-store wrappers over Obsidian SecretStorage. |
| `fs/local/` | `LocalFs` (Obsidian Vault API wrapper) plus the raw adapter for dot-prefixed paths. |
| `fs/googledrive/` | The Google Drive backend: `GoogleDriveFs` with metadata cache, the REST v3 `DriveClient`, server + PKCE auth, the path↔ID `DriveMetadataCache`, incremental sync (changes.list), resumable upload, remote-vault resolution, the Drive types, and the built-in / custom OAuth providers. |
| `ui/` | Settings UI: the main settings tab, the backend-connection section, and Google Drive-specific settings. |
| `store/` | IndexedDB plumbing: the `IDBHelper` transaction wrapper and the generic `MetadataStore<T>` file-metadata cache. |
| `logging/` | `Logger` — structured log writer (`.airsync/logs/`). |
| `queue/` | Concurrency primitives: `AsyncPool` (bounded concurrency) and `AsyncMutex`. |
| `utils/` | Helpers: `sha256()` / `md5()` hashing, path utilities (`getFileExtension`, etc.), and gitignore-style `isIgnored()` pattern matching. |

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
     │    enrichHashesForInitialMatch()   │    MD5 vs contentChecksum
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
     │  executePlan()                     │  PlanExecutor
     │    Group A: push/pull/match/cleanup│    AsyncPool(5)
     │    Group B: rename_*/delete_remote │    serial
     │    Group C: delete_local           │    serial
     │    Group D: conflict               │    serial
     │        │                           │
     │        ▼                           │
     │  commitAction()  (per action)      │  StateCommitter
     └───────────────┬────────────────────┘
                     │
         ┌───────────▼───────────┐
         │      IFileSystem      │
         │  LocalFs │ GoogleDriveFs │
         └───────────────────────┘
```

`runSync` early-returns when no remote backend is present, the backend is connecting, or layout is not ready; it serializes via an `AsyncMutex`. A sync arriving while one runs sets a `syncPending` flag and the running cycle re-runs via a `do/while` loop (coalescing). Each cycle retries up to `MAX_RETRIES = 3`: `AuthError` (status 401) and a non-rate-limit HTTP 403 abort the whole sync immediately; HTTP 404 breaks the retry loop without special handling. For 429 or a rate-limit 403 carrying a `Retry-After` header, delay = `retryAfter * 1000` ms; otherwise exponential backoff with jitter = `2^(attempt-1) * 1000 * (0.5 + Math.random())` ms. See [docs/error-handling.md](docs/error-handling.md) for the full classification/recovery table.

## Core data models

### FileEntity (fs/types.ts)

```typescript
interface FileEntity {
  path: string;          // relative path from sync root
  isDirectory: boolean;
  size: number;          // bytes (0 for directories)
  mtime: number;         // Unix epoch ms (0 = unknown)
  hash: string;          // SHA-256 hex ("" = not computed)
  backendMeta?: Record<string, unknown>;  // e.g. { driveId, contentChecksum }
}
```

Invariant: mtime/hash comparisons must treat sentinels as "no data" — mtime 0 is not the epoch, and hash is always `""` for directories. `hasChanged`/`hasRemoteChanged` only use mtime when both values are > 0.

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
type ConflictStrategy = "auto_merge" | "duplicate" | "ask";

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
  getChangedPaths?(): Promise<{
    modified: string[];
    deleted: string[];
    renamed?: RenamePair[];  // RenamePair = { oldPath, newPath, isFolder? }
  } | null>;
  close?(): Promise<void>;
}
```

Key design points:

- `list()` may return `hash: ""` for performance; use `stat()` when an accurate hash is needed. `LocalFs.stat()` is authoritative: on a vault-index miss it falls back to the filesystem adapter, so a not-yet-indexed file on disk is never reported absent (absence drives deletions).
- `getChangedPaths()` is optional and should be called before `list()`. When implemented (e.g. Google Drive changes.list) it supplies the remote-side changed/deleted/renamed paths consumed by both hot and warm change detection (the hot path is triggered by the local change tracker's dirty paths, not by this method). The `renamed` field lets backends report file moves for native rename optimization.
- `delete()` is idempotent (deleting a non-existent path is a no-op) and backends may use soft deletion (trash). Deleting a directory removes its children recursively; the caller must separately clean up the SyncRecord for each removed child path (`delete()` does not touch sync state).
- `write()` auto-creates parent directories.
- `rename(oldPath, newPath)` throws if `oldPath` does not exist or if `newPath` already exists (the rename optimizer relies on the latter to skip occupied destinations); it auto-creates parent directories. `mkdir()` is idempotent and throws if an intermediate component is an existing file.

## IBackendProvider / IAuthProvider

### IBackendProvider (fs/backend.ts)

Abstraction for a remote storage backend. main.ts and sync/ never import backend-specific modules directly.

```typescript
interface IBackendProvider {
  readonly type: string;             // "googledrive", "googledrive-custom". Stable, unique registry key;
                                     // also indexes settings.backendData and per-backend secrets. Immutable once published.
  readonly displayName: string;
  readonly auth: IAuthProvider;
  createFs(app, settings, logger?): IFileSystem | null;
  isConnected(settings): boolean;
  getIdentity(settings): string | null;
  resetTargetState?(settings): void;
  hasCheckpoint?(settings): boolean;       // is a committed delta cursor present? false ⇒ force a cold reconcile
  readBackendState?(fs, commitCheckpoint): Record<string, unknown>;  // advance the cursor only when commitCheckpoint (failed === 0)
  resolveRemoteVault?(app, settings, vaultName, logger?): Promise<RemoteVaultResolution>;
  disconnect(settings): Promise<Record<string, unknown>>;
}
```

`hasCheckpoint`/`readBackendState` together make the remote delta cursor crash-safe: the cursor is committed to `settings.backendData` only after a fully-successful cycle, and when no checkpoint is committed (`hasCheckpoint === false`: first sync, an interrupted/partial sync, or after a manual rescan) the orchestrator forces a full cold reconcile — delta detection alone can't surface remote files an interrupted sync left un-baselined.

### IAuthProvider (fs/auth.ts)

```typescript
interface IAuthProvider {
  isAuthenticated(backendData): boolean;
  startAuth(backendData): Promise<Record<string, unknown>>;
  completeAuth(input, backendData): Promise<Record<string, unknown>>;
}
```

The provider registry (`fs/registry.ts`) maps backend types to provider instances. New backends register here; no changes needed elsewhere. `initRegistry(secretStore)` must be called once during plugin load (`main.ts` onload) before any `getBackendProvider` call; it injects `ISecretStore` into the provider constructors. Until then the registry is empty and `getBackendProvider` returns undefined. Built-in providers: `GoogleDriveProvider` (type `googledrive`) and `GoogleDriveCustomProvider` (type `googledrive-custom`). On a duplicate `type`, the first registration wins (later ones are skipped in the type lookup).

## Detailed documentation

- [Sync pipeline](docs/sync-pipeline.md) -- temperature modes, decision table, execution groups, deletion safety
- [Conflict resolution](docs/conflict-resolution.md) -- strategies, 3-way merge, conflict history
- [Google Drive backend](docs/google-drive-backend.md) -- metadata cache, authentication, and the sole owner of incremental sync / cache invalidation
- [Error handling](docs/error-handling.md) -- resilience: error classification, retry, rate limiting (recovery scenarios cross-reference the sync pipeline)
