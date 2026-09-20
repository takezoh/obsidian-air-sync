# Google Drive Backend

This document owns the Google Drive-specific design judgements. Wire protocols, cache
internals, and method-level algorithms live in `fs/googledrive/`.

## GoogleDriveFs

The Google Drive filesystem implements `IFileSystem`. It avoids downloading content during
listing/stat by maintaining an in-memory metadata cache; content is only downloaded on read.

### Initialization lifecycle

The remote delta cursor has a single source of truth: the metadata store, stored **alongside
the file map and committed in the same transaction** (see
[ADR 0001](adr/0001-metadata-cache-is-subordinate-to-commit-last.md)). It is **not** kept in
settings, and it advances only on a fully-successful sync (see
[Crash recovery](sync-pipeline.md#crash-recovery)).

Initialization either restores a checkpoint (file map + cursor together, so an incremental
replay is warranted) or, when none exists (genuine first sync, empty/missing store, or after
a rescan/state clear), clears the cache, captures a fresh changes start token **before**
listing so changes during the scan are not missed, lists all files recursively, builds the
cache, and marks the filesystem initialized. A fresh full scan reports no delta — the token
is "now" — and persistence is deferred to the clean-cycle checkpoint commit, not eager. The
cache is scoped to the vault id so a plugin reinstall starts fresh.

### Cache invalidation

Remote change detection goes through the delta entry point, under the cache mutex, after
ensuring initialization. It returns no data when a fresh full scan just captured "now", and
otherwise applies incremental changes from the cursor, splitting collected paths into
modified/deleted by checking whether each still exists in the cache — except a path absent
because a **contended address** displaced it, which is neither: the object is still on
Drive, so it is reported as contended, never deleted. An expired changes token falls back to
a full scan diffed against the prior cache.

**Same-named folders.** Drive lets one folder hold two same-named children. When both are
**folders** and provider-resolved, they are **one vault folder**: a vault folder is only a
path, and Air Sync keeps no record for one. The cache holds both at that path — the smallest
ID is the representative every path-level reader sees and where new content is created — and
each folder's contents keep the addresses they derive through it. Nothing is displaced and
nothing is announced; only a *file* inside can collide. Deleting or moving one takes only
its own contents, told apart by parent ID rather than path prefix; renaming or deleting the
vault folder applies to every Drive folder it is made of. A request-echo folder (whose
parent chain does not reach the bound root) never merges.

**Contended addresses.** Otherwise a vault path cannot hold both. When two distinct file IDs
resolve to one cache path, the cache does **not** silently evict the occupant: it arbitrates
(provider-resolved spelling beats a bare-name request echo; among equals the lowest file ID
wins), removes the losing claimant's subtree, and **returns** the loss as a fact naming the
path, both IDs, the removed descendants, and the reason — one warn line per contended
address, never per descendant. Within a drain the losses accumulate and settle at every page
close, so a tombstone for the winning ID later in the same drain readmits the withheld
claimant and withdraws the contention before anything is published. Every producer of the
deleted set subtracts the addresses a contention explains. The condition is repaired
upstream by one rename of the non-keeper issued by stable id, and the cycle's checkpoint is
blocked until it lands. See
[Sync pipeline → Address-contention remediation](sync-pipeline.md#address-contention-remediation).

**Entered-folder re-listing.** The changes feed reports one change per changed *item*:
moving a folder into the vault root reports the folder alone, and its unchanged descendants
produce no change. So a folder whose ID had no cached path when its change applied (never
tracked, evicted by an earlier move-out, restored from Trash, or reached because its
ancestor chain entered scope) would land in the cache empty and its files would stay
invisible until a cold rescan. The delta apply records those IDs while applying (per-call,
never persisted) and, **after the whole drain**, resolves each to its current path, drops
ones that left scope or are nested under another target, and walks the rest sequentially
with no retry layer of its own. Each listing merges back through the same per-page apply so
a descendant already cached surfaces as a rename rather than a duplicate, and the merge only
upserts: absence from a listing never removes a cached entry. This is the **only** full-tree
listing on the incremental path; a rename or move of an already-cached folder issues no
request. A listing failure propagates, so the cursor is not advanced and the attempt aborts;
the next attempt re-lists from the same committed window. See
[ADR: Google Drive delta re-lists entered folders](adr/adr-20260916-gdrive-delta-relists-entered-folders.md).

The expired-token full-scan-with-delta route snapshots old paths by file ID, full-scans,
then diffs **by file ID only**: a new ID is added, a moved ID is a rename plus modify/delete,
and an ID present before but absent after is deleted **unless the scan's own arbitration
withheld it** — a withheld ID vanished because another claimant took its address, so it is
excluded from the deleted set and reported as contended. Because it keys on file ID, it
**cannot see in-place content edits** (same path + same ID); those surface on the next
incremental sync or via warm mode. A folder that moved out of or into a shared same-named
path is not a renamed folder pair — the vault folder there did not move — so its contents
are reported as their own moves.

The two routes can report one move in different shapes, and both converge.

### Mutex protection

All cache reads and writes are protected by the cache mutex. Writes resolve ids/paths under
the mutex into a stale-guard descriptor, execute network I/O outside it, and re-acquire it to
skip the cache update if the path was re-keyed during the I/O. This is the compare-and-swap
of an optimistic protocol: releasing the mutex so uploads run concurrently is what makes the
first view potentially stale. Under the current architecture the guard is **dormant** — no
two concurrent same-path ops exist — and is retained as defense-in-depth; see
[ADR 0001 → T7](adr/0001-metadata-cache-is-subordinate-to-commit-last.md).

### stat() and hash

`stat()` always returns no local hash; the sync engine uses the remote md5 checksum for
remote change detection, avoiding a download just to compute a hash. `stat()` and `read()`
deliberately do **not** apply incremental changes — the sync cycle calls `list()` first,
which refreshes the cache.

### Detached priority observation

File-open priority reads bypass the shared cache and delta cursor. They independently
resolve the admitted Drive file ID and the current path occupant, then download by the
stable ID. The read token is the remote checksum plus size, not Drive's metadata version:
live E2E showed version can settle after a write and produce a false change without a
content change. The checksum token makes the read guard content-scoped, while identity and
structural changes stay guarded by the separate ID and occupant observations. Folders and
files without complete checksum evidence fail closed.

### Identity-addressed rename

Google Drive is the only backend that implements the optional identity-rename capability,
because it is the only one whose namespace can hold two live objects at one derived address.
Renaming by stable id lets it move an object the cache is deliberately not holding — exactly
what a withheld claimant is. Only the final segment moves; the cache is updated from the
file Drive returns, never the requested spelling. Its sole caller is the address-contention
repair.

### Hiding `.airsync/metadata.json`

`.airsync/metadata.json` is a **legacy** internal file. New vaults never create it (the
remote vault is identified by folder name), but older vaults may have one and an older
plugin version could write one, so the guards are retained. Google Drive keeps it out of the
sync engine by never ingesting it into the metadata cache; because every read path is
cache-backed, that one exclusion covers list/stat/read/delete/listDir/change-detection
uniformly, and the one write path that bypasses the cache throws for it rather than
fabricating a baseline. The sync engine also reserves the same path symmetrically so it is
never pushed/pulled/deleted locally: remote-side hiding alone would be unsafe (a local copy
could be pushed and later deleted as a phantom remote deletion), so the orchestrator
exclusion is the authoritative guarantee and the cache-level skip is enumeration hygiene.

## GoogleDriveMetadataCache

The metadata cache holds path↔file mappings in memory. Its design judgements:

- It builds from a flat file list, resolving relative paths from parent chains, then runs one **claim-set assignment** over the whole resolved set before loading: every multiply-claimed path is arbitrated, and the loss cascades down the resolved parent-id chain — not by string prefix — so a loser's subtree is never bound under the winner in any listing order.
- A single incremental change resolves the path, handles renames/moves, and maintains the indexes. It arbitrates before writing when the resolved path is already held by a different live ID, so it may end up *withholding* the claim. A move takes the object's subtree out whole and re-seats each descendant at its new address, arbitrated there too — only a folder moving into a same-named folder can collide — and every loss beyond the one named is returned as its own fact.
- Loading returns whatever a write displaced. It still throws on a duplicate **stable ID** (one id maps to exactly one path), while duplicate *paths* are arbitrated, never thrown for, because a deterministic throw classifies as transient and would burn full enumerations.
- Cached metadata converts to a filesystem entity without downloading; Drive files surface their md5 as the remote checksum, which is what makes hash-enrichment and remote change detection work without a download.

## Incremental sync

The incremental apply fetches changes pages from the cursor, folders first (shallow before
deep) so parent paths resolve before children. A removed/trashed item removes its subtree; a
modified item resolves through move detection, and a detected move flags the old path
deleted and records the pair. A tracked item moving out of the root reports its old path
(and old descendants for a folder) as deleted; a folder move/rename additionally re-emits
its new descendant paths as modified. The apply mutates only the in-memory cache and
advances the cursor in memory; persistence is deferred to the checkpoint commit after a
fully-successful cycle, which writes the touched records and cursor in one atomic
transaction. The return carries the new token, changed/renamed paths, and the contentions
still standing at the last page close — without which every absence a contention caused
would read as a Drive deletion.

## GoogleDriveClient

The client wraps the Google Drive REST API v3 via Obsidian's `requestUrl` (CORS-free via
Electron's net module). It requests the file fields needed for change detection, including
trashed (so soft-deletes are detected as removals). Methods cover the recursive full
listing, multipart/resumable upload, download, changes start token and listing, soft or
permanent delete, child lookup by name (used to dedup folder creation against Drive's
same-name behavior), and metadata update for rename/move.

### Full-scan listing concurrency

The full listing is the cold/initial enumeration: it walks the folder tree one folder per
request (the app-scoped permission cannot flat-list the whole drive), reached on a first
sync, rescan, or expired-token full scan — plus the entered-folder exception above. A
steady-state delta with no entering folder issues no walk. It runs on an **adaptive pool**
(AIMD): it starts at the historical concurrency, ramps up on cleanly-listed folders, and
halves on a rate limit. Each page is wrapped in a bounded retry using the Drive classifier
and the shared policy: a rate limit or transient error is retried honoring `Retry-After`,
and on a rate limit the pool is signalled before the backoff sleep so its ceiling drops
immediately while the task holds its slot. Auth/permission/not-found propagate, failing the
scan. This lets a folder-heavy vault's initial enumeration discover the sustainable rate
instead of a fixed concurrency. The walk is a free function with an injectable sleep for
deterministic tests, and it accumulates into a map keyed by stable id (last occurrence wins)
while skipping an already-enqueued folder: both guard the downstream contract that metadata
loading rejects a duplicate stable id, which would otherwise fail the whole scan as corrupt
metadata and burn three enumerations. The per-folder guard also bounds a multi-parent
folder's re-walk, and a page cap bounds one folder's pages so a parent cycle cannot enqueue
forever.

### Transport-level 401 retry

The request path injects the bearer token and, on a 401 from the first attempt only, forces
a token refresh and retries exactly once. Every Drive error is re-thrown carrying status,
headers, and parsed body, so the Drive classifier can map it and expired-token handling can
read them.

## Authentication

Two OAuth implementations share a common base. The server side of the built-in flow lives in
the dedicated [obsidian-air-sync-auth](https://github.com/takezoh/obsidian-air-sync-auth)
repo.

- **Built-in (server-side)**: redirects to Google OAuth with a fixed callback and the built-in public client id, requesting offline access and consent. The auth server exchanges the code with a confidential client secret; the plugin receives tokens through the custom protocol handler. Refresh goes through the auth server. Scope is `drive.file` (app-created files only). Current versions use Google's top-level OAuth Picker on desktop and mobile, with the worker preserving picked file ids while exchanging the code; older versions keep their hosted Picker page. Custom OAuth has no Picker and takes an explicit folder ID. The chosen folder is validated through the shared binding seam before publishing; the custom typed id is validated at the connect boundary (after auth, before the filesystem is created).
- **Custom (PKCE)**: the user provides their own client id and secret; the flow uses an S256 challenge. The auth server relays the code back without exchanging it, and the plugin exchanges and refreshes directly with Google's token endpoint, defaulting to the `drive.file` scope and a callback distinct from the built-in flow.

Shared behavior: refresh deduplication (concurrent requests share one in-flight refresh),
proactive refresh shortly before expiry, CSRF protection via a verified state parameter, and
an auth-failure cooldown on a 400/401 refresh failure (which short-circuits token acquisition
without a network attempt and is reset by a successful token store; non-400/401 errors do not
arm it). Disconnect revokes the token.

### Token storage

Tokens are stored in Obsidian's SecretStorage, never in settings. Completion succeeds only
after an immediately exact readback of the required refresh credential; a rotated token uses
the same check before the refreshed response is installed. This is an API-level
postcondition, not a claim that the OS has physically flushed storage. Only non-secret data
lives in settings (folder id, access-token expiry, transient pending auth state/verifier,
and the custom-OAuth fields); the delta cursor lives in the metadata store, co-located with
the file map (ADR 0001).

## Resumable upload

Uploads above a threshold use a resumable session, but content is sent in a **single PUT** —
chunked upload is impossible because Obsidian's `requestUrl` (Electron net) cannot reliably
handle the `308 Resume Incomplete` responses chunking depends on. The init response's
Location header is read case-insensitively because desktop and mobile runtimes may expose
header keys with different casing. A 2xx without an upload URL is classified permanent with a
stable code, so in-cycle retry does not repeat a structurally invalid protocol response and
quarantine does not depend on human-readable diagnostics. A failed PUT is retried as a fresh
upload next cycle; the session is only an envelope, not a byte-range resume.

## Provider model

- **Built-in** (`googledrive`): uses the server-side auth; its resolver finds or creates `obsidian-air-sync/<Vault Name>`. It is invoked **explicitly** when the user binds the default folder, not automatically on connect.
- **Custom** (`googledrive-custom`): uses the PKCE auth with user-provided credentials and requires the remote vault folder id to be set manually; its resolver throws when unset. Because the hand-typed id never passes through the Picker, it is validated at the connect boundary: after auth and before filesystem creation, a rejection tears the session down to disconnected with no filesystem. Custom disconnect preserves its credential refs and folder id, so the id becomes editable again without a manual disconnect; because no token survives the teardown, a later init/sync cannot resurrect the rejected target. Validation fails closed only on a *definite* unusable verdict; a transport/auth/rate-limit failure fails open so a temporarily unreachable Drive does not reject a correct binding. A target trashed *after* a successful connect, or while the plugin is closed, is caught by the sync-time root liveness check, which re-observes every cycle and recovers automatically once restored.

Both extend a provider base handling filesystem creation, non-secret token-state persistence
(the cursor is committed atomically with the cache by the checkpoint, not here), checkpoint
forwarding, and disconnect (which also clears the per-target metadata store). The
checkpoint-existence query and reset live on the filesystem.

### Remote vault resolution

Layout: `<Google Drive root>/obsidian-air-sync/<Vault Name>` — the folder **name is the
vault name**; there is no `.airsync/metadata.json`. Binding is always explicit; nothing is
auto-bound on connect.

- If the remote folder id is cached, the resolver confirms bindability through the shared folder-usability seam. Drive's normal single-click delete moves a folder to Trash rather than erasing it, so a plain fetch would keep succeeding against a folder the user can no longer see — the trashed classification fails closed instead of binding to it forever. The settings display uses the same seam, showing a Trash warning. A 403 that is actually a rate limit is rethrown rather than classified inaccessible, keeping its retry classification.
- Otherwise it find-or-creates the root `obsidian-air-sync` folder, then the vault-named folder, and binds it.

Bound folders picked via either Picker flow are addressed purely by id, independent of this
layout. Every binding path — Picker, cached-id rebind, default folder, custom typed id, and
settings display — decides usability through one seam classifying not-found / inaccessible /
not-a-folder / trashed from the metadata already requested, leaving wording and throw-vs-null
to each caller. The Picker and rebind both fail closed on a trashed folder because an
arbitrary id can reach them. The built-in top-level flow completes authorization and binding
under one connecting gate so no filesystem is exposed between those steps.

### createFs() contract

Filesystem creation returns nothing unless both a refresh token (SecretStorage) and a remote
vault folder id exist. It instantiates a per-target metadata store and seeds the auth with
the stored tokens and expiry. It does **not** seed the cursor — the filesystem restores it
with the file map from the metadata store on first init.
