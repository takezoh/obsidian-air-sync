# Dropbox Backend

> **Backend module.** The canonical id is `dropbox`; the old `dropbox-custom` id is a
> settings alias folded into `authMode: custom` (a public app key). The backend is
> implemented as `module.ts` + `adapter.ts` and runs over core `ManagedRemoteFs`; see
> [design-backend-module-api.md](design/design-backend-module-api.md). The former direct
> `DropboxFs` class and its provider layer were removed.

The Dropbox backend (`backends/dropbox/`) syncs against a folder inside the app's **App
Folder** (`/Apps/<App>/`). It is worker-less: authentication is in-plugin Authorization
Code + PKCE, and the vault is addressed entirely by its **stable folder id** so a remote
move/rename of the folder needs no migration.

This document owns the Dropbox-specific design judgements. Wire protocols, cache internals,
and method-level algorithms live in `backends/dropbox/`.

## DropboxAdapter

`DropboxAdapter` (`adapter.ts`) implements the `RemoteBackendAdapter` over the HTTP v2
`DropboxClient`. Core `ManagedRemoteFs` owns the metadata cache, the checkpoint, and
path/address arbitration; the adapter reports provider facts and performs provider
mutations only.

### Addressing: id, never a stored path

Every remote operation is addressed by the vault's folder id, not a stored absolute
path. Dropbox accepts a path of the form `id:<folderid>/<subpath>`, so the adapter
composes each address from the bound `rootId` plus the vault-relative path. The remote
vault path is never persisted. A remote move/rename of the folder keeps syncing because
the id is unchanged.

### Change detection and delta rename shape

Change detection is **checksum-based**: `stat()` returns no local hash and the sync engine
compares Dropbox's block-based `content_hash` plus server mtime, so a metadata-only touch
(same content, bumped mtime) is correctly seen as unchanged.

A Dropbox rename arrives as `deleted(old)` + `file/folder(new)` sharing a stable id, and
Dropbox does not guarantee the add precedes the delete. The whole delta is drained, then
core applies **upserts before deletes** (folders shallow-first): the move coalesces into
one rename pair via the still-present id→path mapping, and the trailing delete of the old
path is a no-op. A delete is skipped when its path was reclaimed by an upsert in the same
delta (a rename target, or a same-path recreate with a different id), so a
delete-then-recreate is neither mistaken for nor destroyed by the reorder. Detection is
therefore order-independent
([ADR 0006](adr/0006-remote-rename-detection-is-order-independent.md)); without it, a
folder rename whose old-path delete was listed first degraded to a file-by-file
delete+pull of the whole subtree.

## DropboxClient

The client wraps Dropbox HTTP API v2 via Obsidian's `requestUrl` (never `fetch`), with
non-throwing responses plus an explicit assertion helper. RPC calls hit the JSON API; content
calls hit the content host with an argument header. Notes:

- A 401 triggers one forced token refresh-and-retry; a 429 is retried with backoff (honoring `Retry-After`, else exponential, always capped) up to a bound — transient write-lock contention during a bulk first sync does not fail the cycle.
- The argument header must be ASCII, so every code unit at or above 0x7F is escaped — this is what makes non-ASCII (e.g. Japanese) paths work.
- Folder-create, upload, and move responses are **bare** metadata with no type tag. The client stamps it for folder-create and upload; for move the adapter stamps it from the known prior type, so a moved folder stays classified as a folder.

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

With `authMode: custom` the module swaps the auth identity. The user supplies **their own
Dropbox app key** (a public PKCE identifier — no secret), stored as a plain value, and must
register the custom-protocol redirect URI in that app. The custom auth provider reads the
app key from settings when authorization starts, snapshots that public identity beside the
pending state/verifier, and keeps it as the callback exchange identity even if settings are
edited before return. Tokens live under separate SecretStorage keys. Disconnect clears the
tokens but preserves the custom client id so a reconnect needs no re-entry. (Dropbox has no
authority/account-type concept, so — unlike `onedrive-custom` — there is no account-type
selector.)

## Module composition & remote vault

`module.ts` declares the module: its settings (`authMode`, remote folder id, custom
fields), the PKCE auth seams, and binding. The resolver binds the vault on first connect by
find-or-creating a folder directly under the App Folder root — the **default sync folder is
`App Folder/<vault>`**; the App Folder scope already namespaces the app, so there is no
wrapper folder. Folder creation is idempotent, so a picked existing folder (or a second
device with the same vault name) binds to that folder. The remote vault path is never
persisted — the binding is the folder id — so a LOCAL vault rename does not rename the
remote folder; only the last-known vault name advances so the name-equality short-circuit
resumes.

When connected, settings offers **Choose folder**, opening the shared in-app
`AppFolderPickerModal` (`ui/app-folder-picker.ts`): it lists the folders directly under the
App Folder root and lets the user pick an existing one or type a new name. Because the App
Folder scope only ever sees folders under the App Folder, an in-app list is honest — the
old Chooser browsed the whole Dropbox and then had to reject picks outside the app folder —
and no web Chooser, relay page, CSRF nonce, or deep link is involved. On confirm the chosen
name is queued and the default-bind action runs, so the resolver find-or-creates and binds
its id. Changing the folder resets the cursor (and, via the identity change, clears
per-path sync state), so the next sync is a cold reconcile against the new folder. The
bound folder's display path is resolved from its id for the read-only settings display,
through a **detached** auth so the UI read cannot reset the live sync's in-memory tokens.

Core `BackendModuleProvider` wraps the module, owns the connection host, and builds the
single `ManagedRemoteFs` (the cursor + file-map checkpoint live in the per-target IndexedDB
store and commit in one transaction per [ADR 0001](adr/0001-metadata-cache-is-subordinate-to-commit-last.md);
a cold listing captures its baseline cursor before listing so changes during the scan are
not missed). `clearCheckpointStore` drops that store by its settings key when there is no
live filesystem, so a stale checkpoint cannot survive a disconnect. Live Dropbox
verification is covered by the opt-in e2e (`e2e/dropbox.e2e.ts`) — see
[docs/e2e-testing.md](e2e-testing.md).
