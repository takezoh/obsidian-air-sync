---
id: design-core-backend-integration
kind: design
title: Core backend integration
status: active
created: '2026-09-20'
updated: '2026-09-20'
relations:
- {type: references, target: design-backend-module-api}
- {type: references, target: adr-20260920-backend-module-boundary}
- {type: references, target: adr-0001-metadata-cache-is-subordinate-to-commit-last}
summary: How core turns a RemoteBackendAdapter into the managed remote filesystem —
  normalized cache and topology, cursor/scope/checkpoint lifecycle, and priority observation.
  A persisted metadata-record format change is handled by ordinary cold-start, not a codec.
---

# Core backend integration

Core owns everything above the `RemoteBackendAdapter` boundary: the filesystem, the
normalized metadata cache, topology/identity projection, the delta cursor, scope, priority
observation, and the crash-safe checkpoint. A backend module never implements these. See
[design-backend-module-api.md](design-backend-module-api.md) and
[adr-20260920-backend-module-boundary.md](../adr/adr-20260920-backend-module-boundary.md).

## The managed remote filesystem

`ManagedRemoteFs` (`src/fs/managed/`) is the single remote `IFileSystem`. It wraps one
adapter and reuses the shared `CachingRemoteFs` internally — a module depending on that
inheritance seam is forbidden, but core reusing it is allowed. It supplies every backend
seam by translating the normalized adapter contract:

| `CachingRemoteFs` seam | Adapter operation |
|---|---|
| `getStartCursor` | `adapter.getStartCursor()` |
| `fullList` | `adapter.listAll()` → `validateRemoteObject` |
| `assertRootAlive` | `adapter.assertRootAlive()` |
| `fetchChanges` | `adapter.getChanges(cursor)`; `cursor_invalid` → `needsFullScan` |
| `downloadFile` | `adapter.read({id, versionToken})` |
| `deleteRemote` | `adapter.delete(...)` |
| `fetchCurrentFile` / `fetchCurrentPath` | `adapter.getById` / `getByPath` |

Mutation path operations are translated by `MutationBridge` into the adapter's
identity/version/destination inputs under the existing mutex → network → guarded
cache-write protocol.

## Normalized cache and topology

`NormalizedMetadataCache` is `AbstractMetadataCache<RemoteObject>` with the four
extractors plus `toEntity`. Addressing is the only place the two location forms differ:
`parent_id` passes the provider parent through, with `null` reserved for the bound root
and only the bound root — a module must not emit `null` for an object that has no parent,
because core reads `null` as a bound-root address; `provider_path` resolves the parent from
a core-maintained provider-path index built during the same complete snapshot, and drops
an entry whose parent chain does not reach the root rather than seating it at a bare-name
root address. Merged folders keep every id at one path.

## Cursor, scope, and checkpoint

Correctness has exactly two durable publication points: a file's `SyncRecord` after its
admitted action succeeds, and the remote cursor/derived cache/scope checkpoint after a
wholly clean cycle ([adr-0001](../adr/0001-metadata-cache-is-subordinate-to-commit-last.md)).
A checkpoint-capable attempt must finish with exactly one lifecycle result: commit on a
clean cycle, or abort on every incomplete outcome/exception before classification or
retry. Abort clears only the live working view; it never mutates the provider or the
durable checkpoint.

The cursor, the complete final cache snapshot, and the scope fingerprint commit in a
single `saveAll` transaction. The persisted cursor's presence is the checkpoint signal.
Priority observation reads detached current facts and never consumes the batch cursor or
cache.

## Persisted metadata-record format

The metadata checkpoint cache is a derived projection of the remote, never an authority
([adr-0001](../adr/adr-0001-metadata-cache-is-subordinate-to-commit-last.md)). A committed
generation in an encoding the current core cannot read as `RemoteObject` is therefore
treated as **no usable checkpoint**: the cache is dropped and re-created by a full scan,
and the next cycle re-observes current provider facts. There is no record codec and no
format marker. Validation happens when records enter the normalized cache (`bulkLoad`),
the one seam shared by a fresh scan and a restored checkpoint, so an unrecognized
generation fails closed instead of seating provider-native fields as normalized objects.

Physical profiles are preserved: `air-sync-<service>…` SecretStorage keys and
`air-sync-googledrive` / `air-sync-onedrive[-custom]` / `air-sync-dropbox[-custom]`
IndexedDB prefixes are unchanged, so alias normalization never moves a token or loses a
checkpoint.

### Downgrade

A downgrade to a pre-migration version is not a compatibility guarantee. To roll back,
stop sync and discard only the derived remote checkpoint cache, then let the old version
COLD-rescan. Never delete `SyncRecord` data, remote data, or user-owned secrets for a
rollback.

## Disconnect, switch, and unload

Core stops new sync, settles in-flight work, revokes (best effort), clears the module's
plugin-owned secret namespace (never a user-owned secret reference), clears the active
config, clears the target checkpoint store even without a live filesystem, resets the
baseline, and disposes the connection (closing the prepared filesystem and its checkpoint
store). `close()` is idempotent. A callback or config patch
from a superseded connection generation is rejected.
