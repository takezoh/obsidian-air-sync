# Air Sync -- Architecture

This document owns the design principles, the invariant whole-picture, and each
subsystem's responsibility. Concrete type shapes, function-level algorithms, constants,
and wire protocols live in the code.

## Design principles

Air Sync aims to deliver a sophisticated synchronization experience without making users
aware of its underlying mechanisms or complexity. Advanced mechanisms serve this
experience; feature count and customizability are not goals in themselves. The
[support policy](docs/support-policy.md) defines the target audience and feature criteria.

1. **3-state sync** -- Compare local, remote, and last-sync-record to detect changes. Text conflicts use 3-way merge.
2. **Swappable production core** -- All remote I/O in the backend-agnostic production core goes through `IFileSystem` + `IBackendProvider`. Adding a backend leaves that core unchanged and extends explicit integration and verification points: its implementation/provider, `fs/registry.ts`, backend-specific settings UI where applicable, the shared contract catalog/matrix, and opt-in live E2E.
3. **Delta-first** -- Only process files that changed. O(n) full scans are allowed when durable facts require COLD: cold start, missing checkpoint, scope change, and manual rescan.
4. **Fact-first pipeline** -- `ChangeSet → BatchObservation → AuthorizedSyncPlan → Result`. Observation freezes facts; Admission binds identity/topology before pure content comparison and constructs the only executable plan. Execution performs its exact effects; no intermediate result is durable authority.
5. **Crash-safe by construction** -- State is committed only *after* success: per-file baselines after each admitted action, and the remote delta checkpoint only when no action or Admission failure remains. An interrupted attempt aborts its live derived working view and is freshly reclassified on the next invocation; COLD/WARM/HOT follow durable/current facts only. Operation intent, rename evidence, and cross-cycle failure quarantine are never persisted.
6. **Duplicate over delete** -- When in doubt, keep the file. Deleting an unwanted copy is easy; recovering a lost file is impossible.
7. **Single responsibility per module** -- Each file owns one concept. Target 200-300 lines; split when exceeded.

## Module map

One row per directory; see the layer diagram and per-doc references for module detail.

| Path | Responsibility |
|------|----------------|
| `main.ts` | Plugin lifecycle only: load settings, register commands, wire components, handle the OAuth protocol callback. |
| `settings.ts` | Settings type and defaults; `settings-normalize.ts` lifts a legacy per-type `backendData` map into the active flat bag on load. |
| `config-sync.ts` | Experimental config-directory sync (augments dot-path scope and ignore patterns when enabled) plus the guard that keeps this plugin's own settings file from ever syncing. |
| `sync/` | Four-stage sync (fact acquisition and scope projection; single-owner identity Admission; ordered component execution; per-action publication and clean-cycle checkpoint), plus conflict resolution/merge, orchestration, scheduler, state store, error classification, and conflict-history audit. |
| `fs/` | Core filesystem contracts and lifecycle: `IFileSystem` and its optional capabilities, the core `IAuthProvider`/`ISecretStore` interfaces, the provider registry, the settings-renderer contract, `BackendManager`, and the secret host that maps a module's logical secret key to its physical SecretStorage key. Provider-neutral runtime helpers live in the public `backend-api/`. |
| `backend-api/` | The public Backend Module API: `BackendModule` / `BackendRuntimeContext` / `RemoteBackendAdapter`, the provider-neutral auth/binding/settings/errors/checksum types, and the runtime helpers a module bundles (error classification, HTTP transport, OAuth/PKCE, headers, error logging, remote-vault contract, and the concurrency primitive). Free of core internals, Obsidian, stores, and Node/Electron (guard-pinned). |
| `fs/modules/` | Core side of the module boundary: the backend-module registry, the single built-in import root, runtime/http/secret/auth/pkce hosts, config-patch handling, checksum registry, and the compatibility owner for settings aliases and physical storage profiles. It is core-internal; a backend implementation must not import it. |
| `backends/` | The consolidated backend implementation directory: `googledrive/`, `dropbox/`, `onedrive/`, and `shared/` for the provider-neutral helpers they build on (`error-shape`, `adapter-state`, `module-utils`, `pkce-module-auth`, `auth-config`). One module is one backend: a provider imports only `src/backend-api/**`, `shared/`, and its own directory; `shared/` imports only the public API and itself. No backend imports the internal backend-module API, core state, or a plain `src/fs/**` helper (guard-enforced). |
| `fs/managed/` | The core-managed remote filesystem (`ManagedRemoteFs` over the shared caching base): normalized metadata cache and topology projection, delta projection, and the mutation bridge from path operations to adapter identity/version/destination inputs. |
| `tests/fs/` | Shared filesystem behaviour contracts, backend harnesses, the implementation-family and module-definition catalogs, the auth matrix, and the required-contract matrix — kept outside `src/` to preserve the production/community-lint boundary. |
| `fs/caching/` | Shared base for id-addressed remote backends (path↔id resolution, checkpoint lifecycle, derived metadata cache, order-independent delta apply). Google Drive, Dropbox, and OneDrive build on it. Derived cache-address assignment is a separate pure concern: a contended address is resolved by a stated rule (provider-resolved spelling beats a request echo; ties by lowest stable id), applied across a claim set by cascading down the resolved parent chain. Every displacement is a **returned fact** naming the path, both stable ids, and the removed descendants; a displaced address is never reported as a provider deletion. |
| `fs/local/` | `LocalFs` (Obsidian Vault API wrapper) plus the raw adapter for dot-prefixed paths and authoritative actual-casing resolution when vault-index spellings collide. |
| `backends/googledrive/` | The Google Drive backend module: declarative settings/auth/binding, the provider adapter, normalization, folder resolution, and resumable upload. |
| `backends/dropbox/` | The Dropbox backend module (App Folder scope): adapter over the HTTP client, worker-less PKCE, and normalization. The vault is addressed solely by its **stable folder id** (`id:<id>/<subpath>` for every operation — no absolute path is stored), so a remote move/rename of the folder keeps syncing with no migration. Its path-addressed delta encodes a rename as a delete+add pair; the shared core cache applies upserts before deletes so detection is order-independent (ADR 0006). |
| `backends/onedrive/` | The OneDrive backend module (App Folder scope, Microsoft Graph): adapter, in-plugin PKCE, chunked upload, remote-vault resolution, and normalization, with a locally-computed QuickXorHash. |
| `ui/` | Settings UI: the main settings tab, the backend-connection section, the declarative Backend Module settings renderer, and folder-pick modals. |
| `store/` | IndexedDB plumbing: transaction wrapper, generic metadata store, and deflate compression for stored 3-way merge base content. |
| `logging/` | Structured log writer (`.airsync/logs/`). |
| `queue/` | Concurrency primitives: bounded concurrency, AIMD concurrency with an optional byte budget, and `AsyncMutex`. |
| `utils/` | Hashing, QuickXorHash, path utilities, gitignore-style pattern matching, and line parsing. |

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
     │  mutex, retry loop,                │
     │  status transitions, pullSingle     │
     └───────────────┬────────────────────┘
                     │
     ┌───────────────▼────────────────────┐
     │            Pipeline                │
     │                                    │
     │  1 Observation                     │  ChangeDetector / ScopeProjection
     │    collectChanges()                │    hot / warm / cold
     │      → captureBatchObservation()   │    immutable facts only
     │        │                           │
     │        ▼                           │
     │  2 Admission                       │  PlanAdmission / DecisionEngine
     │    admitBatchObservation()         │    current identity binding
     │      → compare bound content      │    private pure comparison
     │      → AuthorizedSyncPlan          │    authorization, disposition, lifecycle
     │        │                           │
     │        ▼                           │
     │  3 Execution                       │  PlanExecutor
     │    executePlan()                   │
     │    independent singletons pool     │    AdaptivePool (AIMD)
     │    settle pool + priority          │    defer new priority work
     │    complex components serial       │    exact admitted action order
     │      publish before successor      │    failed prefix blocks suffix
     │    exact outcomes only             │    no action invention or rerouting
     │        │                           │
     │        ▼                           │
     │  4 Commit / finalization           │  StateCommitter / cycle boundary
     │    commitAction() per success      │    per-path state publication
     │    finalizeSyncCycle()             │    mechanical completion fold
     │    checkpoint, then retirement     │    no safety re-decision
     └───────────────┬────────────────────┘
                     │
         ┌─────────────────────────────────────┐
         │                IFileSystem                │
          │  LocalFs │ ManagedRemoteFs (googledrive/onedrive/dropbox) │
         └───────────────────────────────────────────┘
```

`runSync` early-returns when no remote backend is present, the backend is connecting, or
layout is not ready; it serializes via an `AsyncMutex` and coalesces a sync arriving mid-run.
Each cycle is retried under the shared classification/backoff policy. See
[docs/error-handling.md](docs/error-handling.md).

File-open priority is a narrow side entrance, not a second decision engine: it obtains a
detached observation without consuming the batch delta, may replace only the exact
still-pending singleton pull projected by Admission, and fails closed to the normal
lifecycle on missing authority or a race. Its receipt is cycle-local bookkeeping, not
another record authority.

## Core data models

- **`FileEntity`** describes one path on one side. Invariants: mtime 0 and an empty hash mean "no data" (never the epoch, never a real hash for a directory); change comparisons use mtime only when both values are > 0; an identity key is comparable only within one filesystem/root; a `pathAuthority` of requested-echo is presence without exact-slot proof; a remote checksum tagged with its algorithm powers temporal change detection and, when locally reproducible, cross-side dedup.
- **`SyncRecord`** is the baseline snapshot stored after each successful sync. It is keyed by the remote object's own provider identity, with a unique index over path: one remote object holds at most one record, and at most one record claims a vault address. Both fields are mandatory — a record is written only after the remote side has settled, so it is refused rather than folded to an empty string.
- **`MixedEntity`/`ChangeSet`** combine local, remote, and baseline state for the decision engine; a `ChangeSet` carries exact entries, path observations, normative identity evidence, and the acquisition temperature. A thrown `stat()` aborts the cycle and is never converted to absence ([ADR 0008](docs/adr/0008-logical-identity-admission-fails-closed.md)).
- **`SyncAction`/`SyncPlan`**: the plan is the only executable artifact. A rename action is addressed by a stable provider id for a remote-only namespace repair, never by path, and may carry a folder flag plus descendant mappings for one folder rename. `match` (identical bilateral files with no baseline) and `cleanup` (baseline exists, neither side does) are state-only and perform no file I/O. See [docs/conflict-resolution.md](docs/conflict-resolution.md).

## IFileSystem interface

All paths are relative to the sync root, forward-slash separated, no leading/trailing
slashes. The interface lives in `fs/interface.ts`; its non-obvious contract points:

- `list()` may omit content hashes for performance; `stat()` is authoritative for casing and absence. The vault index can under-report or retain both spellings after a case-only rename, so `LocalFs` resolves collisions through the raw adapter and drops a spelling only when both resolve to one physical path; genuine case-sensitive siblings remain. Absence must never be derived from listing alone — it drives deletion.
- **Dot-prefixed (hidden) paths bypass the indexed Vault API**: Obsidian's index excludes them, so `LocalFs` routes every operation through the raw adapter. This is a **mechanism** choice, independent of the **policy** of whether to sync the path (dot-path scope + ignore patterns + reserved paths, enforced by `SyncOrchestrator.isExcluded()`). OS-generated junk is dropped unconditionally on every backend.
- `checkpoint` is optional and all-or-nothing: a delta-capable backend exposes the full crash-safe lifecycle. Its rename field supplies normative remote movement evidence, and its contended field reports derived addresses claimed by two live stable ids — a fact about the cycle, never a deletion and never an instruction. No caller above the filesystem may move a contention into the deleted set.
- `identityRename` is optional, consulted for presence exactly like `checkpoint` (never by filesystem name), and renames a provider object by stable id. There is no path-addressed fallback: renaming by path would move the claimant that keeps the address.
- `delete()` is idempotent and may soft-delete; deleting a directory is recursive, and the caller separately cleans up the corresponding SyncRecords.
- A mutation argument is an address, not proof of provider casing. A requested echo may update metadata only at the stable identity's resolved path and never re-keys topology; provider-resolved metadata or a successful explicit rename is required to move a cache identity. A case-only parent transition is one parent folder rename after child publication, decided once from complete current-cycle facts.

## Backend providers

`IFileSystem` and `IBackendProvider`/`IAuthProvider` are the swappable-core boundary:
main.ts and sync/ never import backend-specific modules directly. The provider's type is its
stable registry key and also indexes settings and per-backend secrets; the registry is the
source of truth and is injected with the secret store once at plugin load.

The backend extension boundary is now the **Backend Module API v3**
([design-backend-module-api.md](docs/design/design-backend-module-api.md)): a
`BackendModule` implements provider operations through a `RemoteBackendAdapter`, and core
owns the filesystem, normalized cache, cursor, scope, and checkpoint through
`ManagedRemoteFs`
([design-core-backend-integration.md](docs/design/design-core-backend-integration.md),
[adr-20260920-backend-module-boundary.md](docs/adr/adr-20260920-backend-module-boundary.md)).
The three canonical module ids are `googledrive` / `onedrive` / `dropbox`; the `*-custom`
ids are settings aliases (`authMode: custom`), not separate providers.

Key non-obvious decisions (full contracts in `fs/backend.ts` and `fs/auth.ts`):

- The remote delta cursor is crash-safe at the **filesystem** layer, not the provider (ADR 0001): the checkpoint commits cursor plus complete derived cache atomically, only after a wholly clean cycle, and an incomplete attempt aborts its live view without touching the durable checkpoint. `readBackendState()` persists only non-secret provider/auth state and no longer carries the cursor.
- `settings.backendData` is one flat bag holding only the **active** backend's parameters; tokens live in SecretStorage. Switching backends hard-resets the bag and sweeps every backend's plugin-owned secrets, so the new backend starts disconnected and cannot reuse another's token under the wrong OAuth client.
- OAuth completion and refresh-token rotation publish credentials only when the same SecretStorage key immediately reads back the exact candidate. This is an API-level postcondition, not proof of an OS-level flush. Custom PKCE attempts snapshot their nonsecret client/authority beside the pending verifier so callback exchange cannot drift with later settings edits.
- Remote-vault binding is **explicit**, not automatic on connect: the user binds the convention folder or picks one. The folder is the sole binding; there is no `.airsync/metadata.json`. See [docs/google-drive-backend.md](docs/google-drive-backend.md).
- The provider registry validates the built-in `BackendModule`s and wraps each in a core `BackendModuleProvider` (connection host + single `ManagedRemoteFs`); it is the production composition root and is initialized once at plugin load. See [adr-20260920-backend-module-boundary.md](docs/adr/adr-20260920-backend-module-boundary.md).
- Core holds no per-backend knowledge: an adapter declares its `addressing` (`parent_id` | `provider_path`), an auth block declares its owned `credentialKeys`, and a module declares the `disconnectConfig` bag it keeps. Credential readiness and target presence are separate axes, so core never guesses a secret key name or branches on a module id. See [adr-20260921-backend-module-api-v3.md](docs/adr/adr-20260921-backend-module-api-v3.md).

## Detailed documentation

- [Sync pipeline](docs/sync-pipeline.md) -- temperature modes, decision principles, execution groups, deletion safety
- [Conflict resolution](docs/conflict-resolution.md) -- strategies, 3-way merge, conflict history
- [Support policy](docs/support-policy.md) -- project goal, target users, product boundaries, maintained services, and criteria for feature and backend additions
- [Remote backend implementation contract](docs/design/design-remote-backend-implementation-contract.md) -- service qualification, required filesystem/provider semantics, supported provider variability, and conformance evidence for adding a backend
- [Cloud backend investigation](docs/note/note-20260915-cloud-backend-qualification.md) -- provider evidence, technical qualification findings, and service support decisions
- [Google Drive backend](docs/google-drive-backend.md) -- metadata cache, authentication, and the sole owner of incremental sync / cache invalidation
- [Dropbox backend](docs/dropbox-backend.md) -- App Folder scope, id-only addressing, worker-less PKCE auth, in-app folder modal
- [OneDrive backend](docs/onedrive-backend.md) -- App Folder scope (personal accounts), Microsoft Graph, locally-computed QuickXorHash, in-app folder modal
- [Error handling](docs/error-handling.md) -- resilience: error classification, retry, rate limiting
- [OAuth worker & auth site](https://github.com/takezoh/obsidian-air-sync-auth) -- server-side Google token exchange plus the static site, in a dedicated repo. Dropbox no longer uses this site.
