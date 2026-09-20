# Dropbox Backend

The Dropbox backend (`fs/dropbox/`) syncs against a folder inside the app's **App Folder**.
It is worker-less: authentication is in-plugin Authorization Code + PKCE, and the vault is
addressed entirely by its **stable folder id** so a remote move/rename of the folder needs
no migration.

This document owns the Dropbox-specific design judgements. Wire protocols, cache internals,
and method-level algorithms live in `fs/dropbox/`.

## DropboxFs

The Dropbox filesystem implements `IFileSystem`. Like Google Drive it keeps an in-memory
metadata cache (path, mtime, size, content hash) so listing/stat never download; content is
fetched only on read.

### Addressing: id, never a path

Every remote operation is addressed by the vault's folder id, not an absolute path (Dropbox
accepts an `id:<folderid>/<subpath>` form). Read/delete prefer each entry's own stable id;
write, rename, and folder creation use the composed address. Consequences:

- The remote vault path is **never stored**. The filesystem takes no root path — only the folder id — so a remote move/rename keeps syncing because the id is unchanged.
- Dropbox's listing still returns each entry's **absolute** display path, so to produce vault-relative cache keys the cache needs the folder's current absolute path. The backend resolves it from the id once per cycle and re-anchors the cache; this is its only use and it is never persisted.

### Initialization lifecycle

The remote delta cursor lives in the per-target metadata store, co-located with the file map
and committed in the same transaction (ADR 0001) — it is **not** kept in settings. The store
caches only the file map; cursor and root path are not persisted there.

On first operation, initialization runs under the cache mutex:

1. With a cursor present, it restores the file map from IndexedDB (relative keys only — it does **not** set the relativize anchor), then re-anchors from the id so a subsequent delta relativizes new entries correctly. If the cache is empty it falls back to a full scan but restores the seeded cursor so the next delta spans the gap.
2. With no cursor (first sync / after rescan / after a folder change), it clears the cache, re-anchors, captures a baseline cursor **before** listing so changes during the scan are not missed, drains the folder tree recursively, builds the cache, and persists the cache (files only).

Change detection re-anchors then applies the delta; listing reuses the anchor set earlier in
the same cycle. Both the cursor and the traversal are rooted at the folder **id**, so the
cursor survives a remote rename of the vault folder.

## DropboxMetadataCache

The metadata cache stores entries keyed by sync-relative path and answers list/stat/children.
It strips the root's case-folded absolute segments from each entry's display path, preserving
the user's casing for the returned key. The anchor is set per cycle, so a remote move of the
root only updates the anchor — no entry is rebuilt. The constructor takes no root up front
(it is unknown until resolved from the id).

## Incremental sync

After the initial recursive scan, changes are tracked from the committed cursor. A delta
yields modified/deleted/renamed paths consumed by warm change detection; a lost or expired
cursor falls back to a fresh full scan diffed against the prior cache by id.

Rename detection is **order-independent**
([ADR 0006](adr/0006-remote-rename-detection-is-order-independent.md)). A rename arrives as
`deleted(old)` + `file/folder(new)` sharing a stable id, but Dropbox does not guarantee the
add precedes the delete. The whole delta is drained, then **upserts are applied before
deletes** (folders shallow-first): the move coalesces into one rename pair via the
still-present id→path mapping, and the trailing delete of the old path is a no-op. A delete
is skipped when its path was reclaimed by an upsert in the same delta (a rename target, or a
same-path recreate with a different id), so a delete-then-recreate is not mistaken for — or
destroyed by — the reorder. Without this, a folder rename whose old-path delete was listed
first degraded to a file-by-file delete+pull of the whole subtree. See
[ADR 0006](adr/0006-remote-rename-detection-is-order-independent.md) for the full edge-case
matrix.

Change detection is **checksum-based**: stat returns no local hash and the sync engine
compares Dropbox's block-based `content_hash` plus server mtime, so a metadata-only touch
(same content, bumped mtime) is correctly seen as unchanged.

## DropboxClient

The client wraps Dropbox HTTP API v2 via Obsidian's `requestUrl` (never `fetch`), with
non-throwing responses plus an explicit assertion helper. RPC calls hit the JSON API; content
calls hit the content host with an argument header. Notes:

- A 401 triggers one forced token refresh-and-retry; a 429 is retried with backoff (honoring `Retry-After`, else exponential, always capped) up to a bound — transient write-lock contention during a bulk first sync does not fail the cycle.
- The argument header must be ASCII, so every code unit at or above 0x7F is escaped — this is what makes non-ASCII (e.g. Japanese) paths work.
- Folder-create, upload, and move responses are **bare** metadata with no type tag. The client stamps it for folder-create and upload; for move the filesystem layer stamps it from the known prior type, so a moved folder stays classified as a folder.

## Authentication

In-plugin **Authorization Code + PKCE**, fully worker-less. The app key is public and there
is **no client secret** — the ephemeral verifier is the proof. The authorization code
returns directly to the in-plugin custom-protocol handler — Dropbox permits a custom-scheme
redirect for PKCE apps, so no relay page is involved (matching OneDrive) — and the plugin
then exchanges the code for tokens directly. Refreshing an access token needs only the
client id.

- **Scope**: App Folder permission with metadata read and content read/write — access confined to the app folder.
- **Token storage**: refresh + access tokens in SecretStorage (keyed per backend type); the access-token expiry lives in settings. Rotated tokens are written and immediately read back before the refreshed response becomes reusable; cycle closeout is not a credential publication point.
- The built-in app key is committed as a public PKCE identifier (no secret), so it ships embedded and connects with no per-user setup.

## Custom app (`dropbox-custom`)

The custom provider is a thin subclass of the shared base — identical client/filesystem/
folder behaviour and the same App Folder scope — that swaps the auth identity. The user
supplies **their own Dropbox app key** (a public PKCE identifier — no secret), stored as a
plain value; they must register the custom-protocol redirect URI in that app. The custom auth
provider reads the app key from settings when authorization starts, snapshots that public
identity beside the pending state/verifier, and keeps it as the callback exchange identity
even if settings are edited before return. Tokens live under separate SecretStorage keys.
Disconnect clears the tokens but preserves the custom client id so a reconnect needs no
re-entry. (Dropbox has no authority/account-type concept, so there is no account-type
selector.)

## Provider model

The Dropbox provider:

- `isConnected` = a token is present **and** a remote vault folder id is bound; identity is derived from the folder id (drives identity-change handling).
- The incremental checkpoint (delta cursor + file-map cache) is owned by the filesystem's checkpoint capability, inherited from the shared caching base: both live in the per-target IndexedDB store and commit in **one transaction** (ADR 0001) — the cursor is not kept in settings.
- `readBackendState` writes back refreshed tokens only and never touches the cursor; the remote path is never persisted (resolved from the folder id on demand).
- `clearCheckpointStore` drops the per-target store by its settings key when there is no live filesystem (e.g. an expired backend), so a stale checkpoint cannot survive a disconnect.

### Remote vault resolution & default

The resolver binds the vault on first connect by find-or-creating a folder directly under
the App Folder root, where the name is the folder name queued by the in-app modal or, by
default, the vault name — so the **default sync folder is `App Folder/<vault>`** (the App
Folder scope already namespaces the app, so there is no wrapper folder). Folder creation is
idempotent, so a picked existing folder (or a second device with the same vault name) binds
to that same folder. A LOCAL vault rename does not rename the remote folder (tracked by id);
only the last-known vault name advances so the name-equality short-circuit resumes.

### Choosing a different folder

When connected, settings offers **Choose folder**, opening an **in-app modal** (the shared
picker modal, the same pattern as OneDrive, no web Chooser or relay page). The modal lists
the folders directly under the App Folder root and lets the user pick or type a name.
Because the App Folder scope only ever sees folders under the App Folder, an in-app list is
honest — the old Chooser browsed the whole Dropbox and then had to reject picks outside the
app folder. On confirm the chosen name is queued and the default-bind action runs, so the
resolver find-or-creates and binds its id. No CSRF nonce or deep link is involved. Changing
the folder resets the cursor (and, via the identity change, clears per-path sync state), so
the next sync is a cold reconcile against the new folder.

The display-path resolver resolves the bound folder's current path from its id for the
read-only settings display — through a **detached** auth so the UI read cannot reset the live
sync's in-memory tokens.

### createFs() contract

Filesystem creation returns nothing unless a token and a remote vault folder id are both
present; otherwise it builds the filesystem from the id (no path) and seeds the committed
cursor.
