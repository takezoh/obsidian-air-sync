# End-to-end testing against real backends

The unit suite verifies each backend with the shared `runIFileSystemContract` over
**in-memory fakes** of the Google Drive / Dropbox / OneDrive clients (see
[ADR 0002](adr/0002-backends-verified-by-shared-behaviour-contracts.md)). That is fast and
runs in CI, but a fake can drift from the real API and every test stays green.

The **opt-in e2e** runs that *same* contract against the **live** APIs to catch such drift
([ADR 0003](adr/0003-opt-in-e2e-validates-fakes-against-real-backends.md)). It is
**local/manual only** — never part of `npm test`, the lint gate, or CI.

> **Use a throwaway test account, not a real vault.** The suite creates and then
> recursively deletes an `airsync-e2e-*` folder on each run.

## TL;DR

```bash
cp .env.e2e.example .env.e2e          # gitignored; fill the Google + OneDrive client ids first
npm run e2e:bootstrap -- google       # authorize in the browser → token auto-written to .env.e2e
npm run e2e:bootstrap -- dropbox      # authorize in the browser → token auto-written to .env.e2e
npm run e2e:bootstrap -- onedrive     # authorize in the browser → token auto-written to .env.e2e
npm run test:e2e                      # runs the contract against the live APIs
```

With **no** credentials, `npm run test:e2e` warns and skips every backend and exits 0 — so
it can never break anything if run by accident.

## Prerequisites

- Node 20 or 22 (the e2e transport uses the global `fetch`).
- A **test** Google, Dropbox, and/or (personal) Microsoft account. Each backend is
  independent: provide one token to test just that backend; the others warn and skip.

## One-time OAuth-app setup (loopback)

The bootstrap captures the OAuth redirect on a localhost loopback server (default
`http://localhost:53682/callback`; override with `AIRSYNC_E2E_OAUTH_PORT`). Register that
redirect URI once:

- **Google** — the built-in auth server returns tokens to `obsidian://`, which a loopback
  can't capture, so the e2e uses **your own** GCP OAuth client. In Google Cloud Console create
  an OAuth client (Desktop app, or Web app with redirect `http://localhost:53682/callback`),
  enable the Google Drive API, and put its id/secret in `.env.e2e`
  (`AIRSYNC_E2E_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET`). The Google e2e refreshes with this same
  client; with only a refresh token (no id/secret) it falls back to the built-in auth server.
- **Dropbox** — on the app at <https://www.dropbox.com/developers/apps> add
  `http://localhost:53682/callback` under **Redirect URIs**. It uses the public PKCE client id
  (no secret).
- **OneDrive** — the shipped client id is a placeholder (`REPLACE_ME`), so the e2e uses **your
  own** Entra app, exactly like Google. At <https://entra.microsoft.com> register an app with
  **"Personal Microsoft accounts only"**, the **Files.ReadWrite.AppFolder** delegated
  permission, and a `http://localhost:53682/callback` redirect URI (platform "Mobile and
  desktop"); put its application (client) id in `.env.e2e` (`AIRSYNC_E2E_ONEDRIVE_CLIENT_ID`).
  PKCE means no secret. The OneDrive e2e refreshes with this same client (the refresh token is
  bound to it), so — unlike Dropbox — the client id is required even when a token is present.

## Obtaining refresh tokens

`npm run e2e:bootstrap -- <google|dropbox|onedrive>` reuses the shipped auth code
(`GoogleAuthDirect` / `DropboxAuth` / `OneDriveAuth`) and:

1. Starts a localhost loopback server and prints an authorization URL.
2. You open it and approve — the browser is redirected back to the loopback, which captures the
   code automatically (no copy-paste).
3. The code is exchanged for tokens and the refresh token is written straight into `.env.e2e`.

Tokens are long-lived; redo the bootstrap only if one is revoked.

## Environment variables

Read from the real environment or a gitignored `.env.e2e` at the repo root (real env wins):

| Variable | Backend / purpose |
|---|---|
| `AIRSYNC_E2E_GOOGLE_CLIENT_ID` | Google Drive — your GCP OAuth client id (for loopback) |
| `AIRSYNC_E2E_GOOGLE_CLIENT_SECRET` | Google Drive — your GCP OAuth client secret |
| `AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN` | Google Drive — minted by the bootstrap |
| `AIRSYNC_E2E_DROPBOX_REFRESH_TOKEN` | Dropbox — minted by the bootstrap |
| `AIRSYNC_E2E_ONEDRIVE_CLIENT_ID` | OneDrive — your Entra app client id (for loopback + refresh) |
| `AIRSYNC_E2E_ONEDRIVE_REFRESH_TOKEN` | OneDrive — minted by the bootstrap |
| `AIRSYNC_E2E_OAUTH_PORT` | Optional loopback port (default 53682) |

## Running

It is **never** part of `npm test`, the lint gate, or CI — run it explicitly, when needed:

```bash
npm run test:e2e           # all backends — the per-backend files run IN PARALLEL
npm run test:e2e:google    # Google Drive only
npm run test:e2e:dropbox   # Dropbox only
npm run test:e2e:onedrive  # OneDrive only
```

- `npm run test:e2e` runs the per-backend files **concurrently** (different services =
  different rate-limit buckets); tests **within** a backend stay sequential, so a single
  backend is never hammered.
- The full `runIFileSystemContract` runs against each live API. A fresh child folder is created
  per test (the contract assumes an empty start) under one per-run parent folder, removed in
  `afterAll`. A green run is the proof that the fakes still match reality.
- **One token missing** → that backend warns and skips; the other runs.
- **No tokens** → both warn and skip; exit 0.

> Running Google individually needs `AIRSYNC_E2E_GOOGLE_CLIENT_ID`/`_CLIENT_SECRET` in
> `.env.e2e` (the refresh token alone falls back to the built-in auth server, which can't
> refresh a token minted by your own OAuth client). OneDrive likewise needs
> `AIRSYNC_E2E_ONEDRIVE_CLIENT_ID` (the shipped placeholder client id can't refresh your token).

## Notes

- **Dropbox mtime.** `DropboxFs` reports `server_modified` (the upload wall-clock) as `mtime`,
  so a written mtime does not round-trip — the fake echoes it back, the live backend does not.
  The Dropbox suite therefore runs the contract with `preservesWrittenMtime: false` (Google Drive
  keeps the default `true`), relaxing only the mtime-equality checks to "a plausible
  timestamp." mtime is not Dropbox's change-detection signal (that is the content-hash
  `remoteChecksum`), so nothing load-bearing is dropped. This is the documented divergence
  from ADR 0002, surfaced by this e2e.
- **OneDrive mtime.** Unlike Dropbox, `OneDriveFs` PATCHes `fileSystemInfo.lastModifiedDateTime`
  right after the content PUT, so the written mtime *is* preserved (not a server clock) — but
  this e2e proved Microsoft Graph stores it at **whole-second** precision (`12345 → 12000`,
  `99999 → 99000`). So the suite runs with `mtimePrecisionMs: 1000` (the written value must
  round-trip, floored to the second) rather than the exact default or Dropbox's
  `preservesWrittenMtime: false`. mtime is not OneDrive's change-detection signal (that is the
  content hash `remoteChecksum`), so the second-precision floor is not load-bearing for sync —
  though it does mean two edits within the same second are mtime-indistinguishable, falling to
  the duplicate path in conflict resolution. OneDrive runs under the App Folder scope, so the
  throwaway `airsync-e2e-*` tree is created inside `special/approot`.
- **Leftover folders.** Cleanup runs in `afterAll` but is **best-effort** — it warns instead
  of failing the run (Google Drive's `drive.file` scope can't hard-delete and may 403 on trash under
  load). Folders are uniquely named, so delete any stray `airsync-e2e-*` from the test account
  by hand when needed.
- **Why it is not in CI.** Real network, credentials, and quota make it unsuitable as a gate;
  it backstops — it does not replace — the fast fake-based contracts.
