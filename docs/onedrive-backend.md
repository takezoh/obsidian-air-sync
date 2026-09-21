# OneDrive Backend

> **Backend module.** The canonical id is `onedrive`; the old `onedrive-custom` id is a
> settings alias folded into `authMode: custom` (a public client id + authority). The
> backend is implemented as `module.ts` + `adapter.ts` and runs over core
> `ManagedRemoteFs`; see
> [design-backend-module-api.md](design/design-backend-module-api.md). The former direct
> `OneDriveFs` class and its provider layer were removed.

The OneDrive backend (`fs/onedrive/`) syncs against a folder inside the app's **App
Folder**. It is worker-less: authentication is in-plugin Authorization Code + PKCE, and the
vault is addressed entirely by its **stable driveItem id** so a remote move/rename of the
folder needs no migration.

It is built on the same shared machinery as Google Drive, because OneDrive — like Google
Drive, and unlike Dropbox — references each item's parent by id, so the id-chain path
resolver in the shared caching base drives it unchanged. Core `ManagedRemoteFs` owns the
cache, checkpoint, and delta projection; only the wire protocol (Microsoft Graph v1.0) and
the PKCE auth (Dropbox-style, no relay) are OneDrive-specific.

> The **built-in** `onedrive` backend is personal Microsoft accounts only (the `consumers`
> authority). The **`onedrive-custom`** setting (`authMode: custom`) lets the user pick the
> authority (`common`/`organizations`/a tenant GUID), reaching work/school (Azure AD)
> accounts the built-in cannot.

## OneDriveAdapter

`OneDriveAdapter` (`adapter.ts`) implements the `RemoteBackendAdapter` over the Graph
`OneDriveClient`. Core `ManagedRemoteFs` supplies the crash-safe cache/checkpoint machinery
(ADR 0001) and the shared id-keyed delta apply; the adapter supplies the OneDrive-specific
seams and mutating operations — start cursor, full listing, change fetch, download, delete,
write (simple put plus a filesystem-info patch, or a resumable session), idempotent folder
create, and rename/move.

### Addressing: id, never a path

Every remote operation is addressed by the item's stable driveItem id, or path-relative under
a folder. The vault is bound by the folder's id, so a remote move/rename keeps syncing
because the id is unchanged — the remote path is never stored.

### Change detection

`stat()` returns no local hash; the sync engine compares the item's preserved last-modified
time plus the remote checksum. Personal OneDrive exposes only Microsoft's QuickXorHash
(base64; it does not return sha1/sha256, which are Business/SharePoint only), mapped to the
`quickxor` algorithm. It is locally reproducible (verified against the live API), so it
drives cross-side dedup just like Google Drive's md5. The sha256/sha1 shapes are kept as
fallbacks for the Business shape.

## Metadata cache

The metadata cache only reads Graph's driveItem shape (parent reference as a one-element
parent array, the folder facet) and projects a filesystem entity. All path/tree logic is
inherited from the shared abstract cache (id-to-parent-chain resolution, identical to Google
Drive).

### A delta feed may repeat the same item

Graph documents that the same driveItem can appear more than once in a delta feed and that
clients should **use the last occurrence**. The full listing therefore accumulates into a map
keyed by stable id across **all** drained pages — not per page, since a repeat typically
straddles a page boundary — and a deletion tombstone retires an earlier live occurrence
rather than being skipped.

That normalization belongs in the backend adapter, not the cache: metadata loading
deliberately rejects a duplicate stable id — one id maps to exactly one path, the bijection
the single mutation seam keeps. Without the adapter-side normalization a valid Graph response
reached the cache as corrupt metadata and failed the whole scan, and the failure classified
as transient, so it burned three full enumerations before giving up. The incremental path
never needed this: it applies a page at a time, so a repeat is naturally last-write-wins and
never reaches the bulk load.

## Incremental sync

The incremental apply drains the delta pages, sorting folders shallow-first so child paths
resolve against already-applied parents. A deletion facet (or a move out of the tracked root)
removes the subtree; everything else goes through move detection, which surfaces
renames/moves. The final page's delta link carries the new cursor token. An expired cursor
returns a full-scan request, and the base full-scans and diffs by id to recover
adds/deletes/renames (the same fallback as Google Drive's expired token).

## OneDriveClient

The client wraps Microsoft Graph v1.0 via Obsidian's `requestUrl` (never `fetch`), with
non-throwing responses plus an explicit assertion helper; the resumable session is split into
its own module to stay under the line cap. Notes:

- A 401 triggers one forced token refresh-and-retry; a 429 is retried with backoff (honoring `Retry-After`, else exponential, always capped) up to a bound.
- Small files upload via a simple content put, then patch the filesystem-info last-modified time — a plain content put stamps the server's clock, so without the patch every upload would read back as "changed".
- Large files use a **resumable upload session**: create the session (carrying the conflict behaviour and preserved mtime), then send aligned range chunks with a content-range header. The chunk puts go to the pre-authenticated upload URL and deliberately **omit** the bearer — Graph rejects an unexpected authorization header there — while still flowing through the shared request path for 429 backoff.
- The assertion helper maps auth-class error codes to `AuthError` and everything else to a Graph error preserving status and code, so an expired-cursor / conflict / not-found response is branchable. A backend classifier then maps these to the retry kinds (a quota error to permission, throttling/service codes to transient, plus the shared 429/401/404 mapping).

## Authentication

In-plugin **Authorization Code + PKCE**, fully worker-less, on the `consumers` authority for
the built-in backend. The authority host segment is parameterized, so the custom backend can
target `common`/`organizations`/a tenant GUID. The client id is public and there is **no
client secret** — the ephemeral verifier is the proof. The authorization code returns
**directly** via the existing custom-protocol handler (no relay page, since Entra permits the
custom-scheme redirect for a desktop/mobile public client), and the plugin then exchanges the
code for tokens directly with Microsoft.

- **Scope**: `Files.ReadWrite.AppFolder offline_access` — access confined to the App Folder; `offline_access` enables the refresh token.
- **Token storage**: refresh + access tokens in SecretStorage (keyed per backend type); the access-token expiry lives in settings. A rotated refresh token is written and immediately read back before the refreshed response becomes reusable; cycle closeout is not a credential publication point. Microsoft's consumer endpoint has no programmatic token revoke, so disconnect just clears the SecretStorage tokens and drops the in-memory manager.
- The built-in client id is the real Entra application id, registered for personal accounts only with the custom-protocol redirect. Work/school accounts use the custom setting instead.

## Custom app (`onedrive-custom`)

With `authMode: custom` the module swaps the auth identity. The user supplies their own Entra
**Application (client) ID** and an **account type**, both stored as plain values (the client
id is a public PKCE identifier — no secret). The effective client id and authority are
snapshotted beside the pending state/verifier when authorization starts, so settings edited
before callback cannot change the token endpoint or client identity for that attempt. Tokens
live under separate SecretStorage keys. Disconnect clears the tokens but preserves the client
id and authority so a reconnect needs no re-entry.

The account-type dropdown maps to the authority host segment: Personal, Work+personal,
Work-only, or a specific tenant GUID — the lever that reaches **work/school (Azure AD)**
accounts.

> **OneDrive for Business / SharePoint checksums.** Business drives expose sha1/sha256
> rather than personal's QuickXorHash; the metadata cache already keeps those as fallbacks,
> so change detection works without a filesystem-layer change. This path is exercised only by
> the opt-in e2e — a real Business tenant is the remaining verification gap.

## Module composition & remote vault

`module.ts` declares the module: its settings (`authMode`, remote folder id, custom
client id/authority), the PKCE auth seams, and binding. The resolver binds the vault by
find-or-creating a folder directly under the App Folder root — the **default sync folder is
`App Folder/<vault>`** (the App Folder scope already namespaces the app, so there is no
wrapper folder). Folder creation is idempotent (a conflict returns the existing folder), so
a second device with the same name binds to the same folder. A LOCAL vault rename does not
move the remote folder (tracked by id).

### Choosing a different folder (in-app modal)

Because the App Folder scope confines access to the app root, there is **no web picker** (a
full-drive picker would only mislead). Instead, settings offers **Choose folder**, opening
the shared in-plugin `AppFolderPickerModal` (`ui/app-folder-picker.ts`): it lists the folders
directly under the app root and lets the user pick one or type a new name. Because the App
Folder scope only ever sees folders under the App Folder, an in-app list is honest. On
confirm it queues the chosen name and triggers the default-bind action, so the resolver
find-or-creates and binds its id. The bound folder's display path is resolved from its id
through a **detached** auth so the UI read cannot reset the live sync's tokens.

Core `BackendModuleProvider` wraps the module, owns the connection host, and builds the
single `ManagedRemoteFs` (the cursor + file-map checkpoint live in the per-target IndexedDB
store and commit in one transaction per [ADR 0001](adr/0001-metadata-cache-is-subordinate-to-commit-last.md);
`clearCheckpointStore` drops that store by its settings key when there is no live
filesystem). Live OneDrive verification is covered by the opt-in e2e
(`e2e/onedrive.e2e.ts`) — see [docs/e2e-testing.md](e2e-testing.md).
