---
id: adr-20260827-file-open-fast-pass-uses-targeted-freshness
kind: adr
title: File-open fast pass uses targeted remote freshness
status: rejected
created: '2026-08-27'
decision_makers:
- unknown
consulted: []
informed: []
tags:
- sync
- file-open
- remote-freshness
owners: []
relations:
- {type: originatedFrom, target: change-20260827-fast-pass-remote-freshness}
source_paths:
- src/fs/interface.ts
- src/fs/caching/remote-fs.ts
- src/fs/googledrive/index.ts
- src/fs/dropbox/index.ts
- src/fs/onedrive/index.ts
- src/sync/scheduler.ts
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md
consequences:
  positive:
  - Opening a synced file can pull its latest remote version without waiting for normal
    sync order.
  - Normal sync later observes the same change and all siblings because the global
    cursor is untouched.
  negative:
  - Each eligible open performs targeted metadata I/O; Dropbox also refreshes the
    root path.
  neutral:
  - Generic stat remains cache-only and SyncRecord remains the temporal baseline authority.
confirmation: Shared tests prove cursor preservation, structural rejection, individual
  SyncRecord update, sibling processing, and no opened-file retransfer; the gate remains
  mandatory.
summary: Fetch only the opened cached identity without consuming delta, admitting
  it only when it still resolves to the exact requested path.
updated: '2026-08-27'
---

# File-open fast pass uses targeted remote freshness

## Context

The file-open scheduler compared a `SyncRecord` with `CachingRemoteFs.stat(path)`. That
operation intentionally reads cached metadata and assumes normal sync has already replayed
the provider delta, so opening a remotely changed file did nothing until a lifecycle sync.

Fast pass must not wait for the opened file's normal batch order. Consuming
`getChangedPaths()` is the wrong operation because it advances one global batch containing
unrelated paths and structural evidence.

## Decision

Remote caching filesystems expose optional `statFresh(path)`. `CachingRemoteFs` implements
it once using a provider seam that fetches metadata for the stable ID cached at the path.
It does not call, advance, commit, or reset the incremental checkpoint.

After the request, the base rechecks that the path still has the same ID and that fresh
metadata resolves to the exact requested path. Only then is the live cache entry refreshed.
Missing, deleted, trashed, renamed, moved-out, and same-path replacement cases return
`null`; normal delta processing owns those structural changes.

The scheduler calls `statFresh` after finding a `SyncRecord`, then uses the existing local
and remote change comparisons. `pullSingle` writes content and updates only that path's
record. Later normal sync still receives the global delta. The opened path is a no-op
because its record is current, while siblings proceed normally.

## Rejected alternatives

- Replay `getChangedPaths()` from file-open: consumes global evidence for one path and
  requires a second handoff lifecycle to avoid losing siblings.
- Make `stat()` network-backed: changes a widely used cache query into implicit I/O.
- Reorder the normal queue: does not provide freshness before normal acquisition/planning.
- Use a TTL: can suppress the exact observation needed when a file is opened.

## Consequences

Checkpoint commit-last remains unchanged. Targeted cache refresh is not persisted alone;
after a crash, the still-uncommitted global delta is replayed. Provider differences are
limited to direct metadata fetch and path resolution.


{% transition from="proposed" to="rejected" date="2026-08-27" %}
Superseded before acceptance: mutating shared cache and whole-batch mutex ordering violate the reviewed priority/concurrency contract.
{% /transition %}
