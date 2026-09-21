---
id: adr-20260920-backend-module-boundary
kind: adr
title: The Backend Module API is the extension boundary; core owns the managed remote filesystem
status: accepted
created: '2026-09-20'
updated: '2026-09-20'
decision_makers:
- project owner
consulted:
- implementation plan obsidian-air-sync-issue-89-static-built-in-plan
consequences:
  positive:
  - A backend module implements only provider operations (RemoteBackendAdapter); core owns
    IFileSystem, the normalized metadata cache, the delta cursor, scope fingerprint,
    checkpoint commit/abort, and priority observation, so crash-safety is identical across
    built-in and future external backends.
  - Provider-native DTOs never enter durable cache or the sync engine; the normalized object
    gives core one identity/topology/checksum model to reason about.
  - Core registers the standard checksum ids (sha256/sha1/md5) and the compatibility ids
    (dropbox/quickxor) itself; the registry's `register` method plus the extension test are
    the proof of the extension point, and an unknown algorithm fails closed instead of being
    treated as locally computable. A built-in module does NOT declare an algorithm in this
    milestone; reaching the registry from a loaded module is future-loader work.
  - Three services are three modules; built-in vs custom OAuth is an authMode within a module,
    so legacy `*-custom` ids stop being parallel providers.
  negative:
  - The public contract must be runtime-validated (TypeScript is insufficient for dynamically
    loaded JavaScript), adding a validator and boundary guard that did not exist.
  - Migrating the legacy six providers touches the registry, settings normalization, identity,
    and secret profiles at once.
  - Fully removing CachingRemoteFs as the subclass seam requires a Core-managed filesystem
    (ManagedRemoteFs), which is a large structural refactor of the sync-critical path.
  neutral:
  - CachingRemoteFs may be reused INSIDE ManagedRemoteFs; only a module's dependence on the
    inheritance seam is forbidden.
  - Physical SecretStorage keys, remote object ids, existing checksum ids, and IndexedDB
    profile names are preserved; module ids are logical.
  - The external dynamic loader is out of scope for this milestone; API v1 is implemented and
    tested for static built-ins without claiming external artifact compatibility.
confirmation: >-
  `backend-module-boundary-guard.test.mjs` (in `npm run lint:bot-repro`) fails if
  `src/backend-api/**` imports obsidian, Node/Electron, or any path outside itself;
  `tests/backend-api/fake-module.ts` is the compile fixture proving a static module builds with
  only the public API; `tests/backend-api/validate-module.test.ts` pins the runtime rejection of
  alias ids, unsupported API versions, missing functions, unpaired pickers, and duplicate
  declarations.
decision_bindings:
- src/backend-api/index.ts
- src/backend-api/module.ts
- src/backend-api/remote-adapter.ts
- src/backend-api/remote-object.ts
- src/fs/modules/validate-module.ts
- backend-module-boundary-guard.test.mjs
source_paths:
- src/backend-api
- src/fs/modules
- tests/backend-api
---

# ADR — Backend Module API boundary

## Context

Today `IFileSystem` (and `CachingRemoteFs<TProviderObject>`) is the de-facto extension
boundary. `src/fs/registry.ts` statically constructs six providers (Google Drive / OneDrive /
Dropbox, each with a built-in and a `-custom` variant) whose `createFs(app, settings, logger)`
receives the global settings, the Obsidian `App`, and an internal logger. Each provider's
filesystem subclasses the shared cache and also owns its metadata store and checkpoint store.

That shape makes the extension boundary wider than a backend's real responsibility. A backend
needs only to *talk to its provider*; identity, topology, change detection, cache/cursor
durability, and sync safety are core concerns that must be identical for every backend. The
wider boundary also cannot be runtime-validated for a future dynamically loaded module, because
it hands over core internals and expects class inheritance.

Issue #89 asks for a pluggable backend module architecture. This milestone implements the
**static** half: the public module/adapter contract, a core-managed remote filesystem, the
normalized object model, and the migration of the three services onto it. Dynamic external
loading, artifact install, integrity manifests, and external distribution are explicitly a later
milestone and are not claimed here.

## Decision

1. **`BackendModule` / `BackendRuntimeContext` / `RemoteBackendAdapter` are the public
   boundary** (`src/backend-api/`, `apiVersion: 1`). One module is one backend. The module
   object carries no mutable per-connection auth state and performs no I/O during
   enumeration/validation. The `src/backend-api` boundary stays self-contained
   (guard-enforced), while a static built-in module implementation MAY use core-internal
   helpers (`http-transport`, `error-shape`, `pkce-module-auth`, `oauth-pkce`) that are not
   part of the public API.

2. **Module ids are canonical.** `module.id === settings.backendType`, one of
   `googledrive`/`onedrive`/`dropbox`. The `*-custom` ids are legacy settings aliases only; they
   are never registered as modules. Built-in vs custom OAuth is an `authMode` inside each
   module.

3. **The runtime context is narrow.** Only `http`, namespaced `secrets`, `logger`, and `auth`
   are injected. `App`, `AirSyncSettings`, the internal logger, metadata/checkpoint
   stores, and `IFileSystem` are never exposed. Secret access is logical, declared, and
   module-scoped; there is no enumeration and no cross-module access.

4. **A module reports provider facts and performs provider mutations, nothing above that.**
   `getStartCursor`/`listAll`/`assertRootAlive`/`getChanges` for observation;
   `getById`/`getByPath` for detached current facts; version-bound `read`; and
   create/update/mkdir/move/delete. Pagination completes or fails; a partial result is never
   published as complete; `cursor_invalid` is distinct from empty changes.

5. **Core owns the managed remote filesystem.** `ManagedRemoteFs` wraps a
   `RemoteBackendAdapter` with `IFileSystem`, the normalized metadata cache, topology/identity
   projection, the delta cursor, scope fingerprint, priority observation, and the atomic
   commit-or-abort checkpoint lifecycle. Modules never implement
   `hasCheckpoint`/`commitCheckpoint`/`abortWorkingView`/`resetCheckpoint`, scope persistence,
   or store transactions. Reusing `CachingRemoteFs` inside `ManagedRemoteFs` is allowed; a
   module depending on that inheritance seam is not.

6. **The normalized object model is the only durable remote representation.** `RemoteObject`
   carries stable `id`, `kind`, optional `size`/`mtimeMs` (absent = unknown, `0` = real),
   `checksum`, `versionToken`, a discriminated `RemoteLocation` (parent-id tree vs
   stable-root provider path), and explicit `pathAuthority`. Provider-native DTOs are confined
   to the module.

7. **Checksums are a registry.** Core registers the standard ids (sha256/sha1/md5) and the
   compatibility ids (dropbox/quickxor) itself; the registry's `register` method is the
   extension point (it refuses a reserved id), proven by the extension test rather than by a
   built-in declaration. In this static milestone no `BackendModule` declares algorithms, and
   reaching the registry from a loaded module is future-loader work.
   `isLocallyComputable` becomes `registry.has(id)`; an unregistered algorithm is
   unsupported/unverifiable and fails closed. No provider-name switch enters the content
   comparer.

8. **Errors cross the boundary in one taxonomy** (`auth`/`permission`/`rate_limit`/
   `not_found`/`target_changed`/`cursor_invalid`/`transient`/`permanent`/`unverifiable`) with a
   bounded `retryAfterMs`. Core owns retry/backoff; it never re-parses a provider error or
   calls a module-specific `classifyError()` after the fact.

9. **Auth, binding, and settings are declarative.** Core renders Obsidian UI and owns the
   disconnect sequence (revoke → clear module secret namespace → clear config → clear target
   checkpoint → reset baseline → dispose the connection). A module returns config patches and a stable
   target; it never mutates global settings or uses a second settings store.

10. **Static scope only.** This milestone registers the three built-ins through the same
    validate→register path a future loader will use, but implements no external discovery,
    dynamic import, install UI, or integrity store.

### Limited compatibility exception (D12)

`AGENTS.md` forbids migration code and mandates cold-start on an IndexedDB schema change. Issue
#89 forbids unnecessary re-authentication and destructive reset on a representation change.
Those rules conflict for the settings/aliases. The resolution is a **bounded exception**, not a
general migration framework:

- **Settings normalizations** (`liftActiveBackendData`, `normalizeConflictStrategy`, plus the
  new legacy-alias/canonical-id normalization) reshape-or-discard an incompatible old shape.
  They are idempotent and never invent data.
- **A change to the persisted metadata-record format is NOT a compatibility case.** The
  metadata checkpoint cache is a derived projection of the remote (ADR 0001), never an
  authority. A record-format change bumps `METADATA_CACHE_VERSION`, so on upgrade the
  store is dropped and re-created and the old provider-native records AND the old cursor
  disappear together — there is no window in which an unreadable generation's cursor
  remains. Same-generation corrupt/foreign records are still rejected by
  `NormalizedMetadataCache.bulkLoad` validation as defense-in-depth, and either way the
  result is an ordinary cold-start: the cache is rebuilt from a full scan, after which
  current provider facts are re-observed. There is no record codec, and none
  may be added: interpreting a re-derivable cache would only preserve an unnecessary second
  encoding of the same facts.
- Physical keys (`air-sync-<service>…`), DB profiles (`air-sync-googledrive` etc.), stable
  remote ids, and existing checksum ids are preserved. Nothing about the exception retains
  operation intent, recovery instructions, or a third durable sync authority.

The retained compatibility set is therefore exactly: the settings alias/normalization reshape
plus the stable physical key and DB profile names. It must not grow into field-by-field
transformation of unrelated data.

## Consequences

**Positive.** Providers shrink to provider integration; sync safety has one implementation; the
normalized model gives Admission one set of facts; the checksum registry plus its extension test
prove the extension point without a built-in declaration; and the boundary is small enough to
runtime-validate.

**Negative.** Runtime validation and a boundary guard are new
required machinery; the migration touches settings, identity, and secrets
together; and `ManagedRemoteFs` is a structural refactor of the sync-critical cache/checkpoint
path, so it must be built beside the existing path and cut over only after the shared contracts
pass.

**Neutral.** CachingRemoteFs may survive as an internal implementation detail. External loader
compatibility is neither implemented nor claimed by this milestone.

## Status

Accepted for the static built-in milestone. The dynamic external loader remains future work and
its requirements must not be used to widen or defer this boundary's completion criteria.
