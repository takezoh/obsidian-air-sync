# Air Sync -- Architecture

## Vision

Sync should be invisible -- like air. When the user opens Obsidian, changes since the last session are reflected within hundreds of milliseconds. After editing, background sync runs on a 5-second batch interval. Opening a note always shows the latest version. If the network drops or the app crashes, the worst case is a duplicate file; user data is never lost. Conflicts are resolved transparently via auto-merge, and the user is only prompted when edits truly contradict each other.

## Design principles

1. **3-state sync** -- Compare local, remote, and last-sync-record to detect changes. Text conflicts use 3-way merge.
2. **Swappable backends** -- All remote I/O goes through `IFileSystem` + `IBackendProvider`. Adding a backend requires no changes outside `fs/`.
3. **Delta-first** -- Only process files that changed. O(n) full scans are allowed only on cold start.
4. **Pipeline as data** -- Each sync phase is a pure transformation: `ChangeSet → SyncPlan → Result`. I/O is isolated at boundaries; all intermediate states are testable.
5. **Crash-safe by construction** -- State is updated only *after* an action succeeds (per-action commit). An interrupted sync converges by simply re-syncing.
6. **Duplicate over delete** -- When in doubt, keep the file. Deleting an unwanted copy is easy; recovering a lost file is impossible.
7. **Single responsibility per module** -- Each file owns one concept. Target 200-300 lines; split when exceeded.

## File structure

```
src/
├── main.ts                          # Plugin entry point (lifecycle only)
├── settings.ts                      # AirSyncSettings type & defaults
├── constants.ts                     # Shared constants (AIRSYNC_DIR)
├── sync/
│   ├── types.ts                     # SyncRecord, MixedEntity, SyncAction, SyncPlan, SafetyCheckResult
│   ├── local-tracker.ts             # LocalChangeTracker — in-memory dirty path set
│   ├── change-compare.ts            # hasChanged(), hasRemoteChanged() — diff against baseline
│   ├── change-detector.ts           # collectChanges() — hot/warm/cold temperature modes
│   ├── decision-engine.ts           # planSync() — builds SyncPlan from MixedEntity[]
│   ├── safety-check.ts              # checkSafety() — mass-deletion guard
│   ├── plan-executor.ts             # executePlan() — grouped execution (A/B/C/D)
│   ├── state-committer.ts           # commitAction() — per-action SyncRecord upsert/delete
│   ├── conflict-resolver.ts         # resolveConflict() — 3-strategy conflict resolver
│   ├── rename-optimizer.ts           # refinePlan() — rename optimization orchestrator
│   ├── rename-optimizer-types.ts    # RenameOptResult, SkippedRename — optimization result types
│   ├── optimize-local-renames.ts    # Local rename optimization (hash-verified)
│   ├── optimize-remote-renames.ts   # Remote rename optimization (trusted)
│   ├── conflict.ts                  # resolveWithStrategy() — low-level strategy implementations
│   ├── merge.ts                     # threeWayMerge() — git-style merge via diffIndices
│   ├── orchestrator.ts              # SyncOrchestrator — retry loop, mutex, status transitions
│   ├── scheduler.ts                 # SyncScheduler — vault events, timers, file-open priority sync
│   ├── state.ts                     # SyncStateStore — IndexedDB persistence for SyncRecords
│   ├── error.ts                     # getErrorInfo(), isRateLimitError(), sleep()
│   ├── conflict-history.ts          # ConflictHistory — JSON audit log per device
│   └── remote-vault.ts              # RemoteVaultResolution type, REMOTE_VAULT_ROOT constant
│
├── fs/
│   ├── types.ts                     # FileEntity
│   ├── interface.ts                 # IFileSystem — abstract filesystem contract
│   ├── auth.ts                      # IAuthProvider — OAuth/credential lifecycle
│   ├── backend.ts                   # IBackendProvider — backend provider abstraction
│   ├── registry.ts                  # Backend registry (initRegistry, getBackendProvider)
│   ├── errors.ts                    # AuthError
│   ├── backend-manager.ts           # BackendManager — init, connect, disconnect lifecycle
│   ├── secret-store.ts              # ISecretStore — Obsidian SecretStorage wrapper
│   ├── token-store.ts               # Token read/write/clear helpers for SecretStorage
│   ├── local/
│   │   └── index.ts                 # LocalFs — Vault API with raw adapter fallback for dot-prefixed paths
│   ├── googledrive/
│   │   ├── index.ts                 # GoogleDriveFs — IFileSystem with metadata cache
│   │   ├── client.ts                # DriveClient — Drive REST API v3 client
│   │   ├── auth.ts                  # GoogleAuth (server), GoogleAuthDirect (PKCE)
│   │   ├── metadata-cache.ts        # DriveMetadataCache — path<->ID mapping
│   │   ├── incremental-sync.ts      # applyIncrementalChanges() — changes.list integration
│   │   ├── resumable-upload.ts      # ResumableUploader — large file upload (>5 MB)
│   │   ├── remote-vault.ts          # resolveGDriveRemoteVault() — vault folder resolution
│   │   ├── provider-base.ts         # GoogleDriveProviderBase, GoogleDriveAuthProviderBase
│   │   ├── provider.ts              # GoogleDriveProvider (built-in OAuth)
│   │   ├── provider-custom.ts       # GoogleDriveCustomProvider (user-provided credentials)
│   │   └── types.ts                 # DriveFile, DriveFileList, DriveChangeList, assertions
│   └── mock/
│       └── index.ts                 # InMemoryFs — test double
│
├── ui/
│   ├── settings.ts                  # AirSyncSettingTab — main settings UI
│   ├── backend-settings.ts          # Backend connection settings section
│   └── googledrive-settings.ts      # Google Drive specific settings
│
├── store/
│   ├── idb-helper.ts                # IDBHelper — IndexedDB transaction wrapper
│   └── metadata-store.ts            # MetadataStore<T> — generic IDB-backed file metadata cache
│
├── logging/
│   └── logger.ts                    # Logger — structured log writer (.airsync/logs/)
│
├── queue/
│   └── async-queue.ts               # AsyncPool (bounded concurrency), AsyncMutex
│
└── utils/
    ├── hash.ts                      # sha256() — Web Crypto wrapper
    ├── md5.ts                       # md5() — js-md5 wrapper for cold start hash matching
    ├── path.ts                      # Path utilities (getFileExtension, etc.)
    └── ignore.ts                    # isIgnored() — gitignore-style pattern matching
```

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
     │  checkSafety()                     │  SafetyCheck
     │        │                           │    deletion ratio guard
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
  local?: FileEntity;
  remote?: FileEntity;
  baseline?: SyncRecord;
}

interface SyncPlan {
  actions: SyncAction[];
  safetyCheck: SafetyCheckResult;
}
```

### SafetyCheckResult (sync/types.ts)

```typescript
interface SafetyCheckResult {
  shouldAbort: boolean;
  requiresConfirmation: boolean;
  deletionRatio?: number;
  deletionCount?: number;
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
    renamed?: { oldPath: string; newPath: string }[];
  } | null>;
  close?(): Promise<void>;
}
```

Key design points:

- `list()` may return `hash: ""` for performance; use `stat()` when an accurate hash is needed.
- `getChangedPaths()` is optional. When implemented (e.g. Google Drive changes.list), it enables the hot change-detection path. The `renamed` field allows backends to report file moves for native rename optimization.
- `delete()` is idempotent. Backends may use soft deletion (trash).
- `write()` auto-creates parent directories.

## LocalFs (fs/local/index.ts)

`LocalFs` implements `IFileSystem` backed by the Obsidian `Vault` API. Obsidian excludes dot-prefixed paths (`.templates/`, `.airsync/`, etc.) from its file index, so `LocalFs` applies a two-tier access strategy:

- **Operations** (`stat`, `read`, `write`, `delete`, `rename`, `listDir`): vault API first; if the path is absent from the vault index, fall back to the raw `vault.adapter`. This covers both user-configured dot paths and the internal `.airsync/` directory without an explicit allowlist.
- **Sync enumeration** (`list`): returns all vault-indexed files, then appends files from each directory in `syncDotPaths` (user setting) via `vault.adapter`. The `AIRSYNC_DIR` (`.airsync`) directory is intentionally **excluded** from enumeration — it is internal plugin storage and is never synced unless the user explicitly adds it to *dot-prefixed folders to sync* in settings.

The `write()` path uses `path.startsWith(".")` to route new dot-prefixed files to `vault.adapter.writeBinary()`, since they cannot be created via the vault API.

## IBackendProvider / IAuthProvider

### IBackendProvider (fs/backend.ts)

Abstraction for a remote storage backend. main.ts and sync/ never import backend-specific modules directly.

```typescript
interface IBackendProvider {
  readonly type: string;             // "googledrive", "googledrive-custom"
  readonly displayName: string;
  readonly auth: IAuthProvider;
  createFs(app, settings, logger?): IFileSystem | null;
  isConnected(settings): boolean;
  getIdentity(settings): string | null;
  resetTargetState?(settings): void;
  readBackendState?(fs): Record<string, unknown>;
  resolveRemoteVault?(app, settings, vaultName, logger?): Promise<RemoteVaultResolution>;
  disconnect(settings): Promise<Record<string, unknown>>;
}
```

### IAuthProvider (fs/auth.ts)

```typescript
interface IAuthProvider {
  isAuthenticated(backendData): boolean;
  startAuth(backendData): Promise<Record<string, unknown>>;
  completeAuth(input, backendData): Promise<Record<string, unknown>>;
}
```

The provider registry (`fs/registry.ts`) maps backend types to provider instances. New backends register here; no changes needed elsewhere.

## Detailed documentation

- [Sync pipeline](docs/sync-pipeline.md) -- temperature modes, decision table, execution groups
- [Conflict resolution](docs/conflict-resolution.md) -- strategies, 3-way merge, conflict history
- [Google Drive backend](docs/google-drive-backend.md) -- metadata cache, incremental sync, authentication
- [Error handling](docs/error-handling.md) -- classification, retry, recovery scenarios
