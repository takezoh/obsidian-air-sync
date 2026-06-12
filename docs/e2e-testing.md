# End-to-end testing against real backends

The unit suite verifies each backend with the shared `runIFileSystemContract` over
**in-memory fakes** of the Google Drive / Dropbox / OneDrive / pCloud clients (see
[ADR 0002](adr/0002-backends-verified-by-shared-behaviour-contracts.md)). That is fast and
runs in CI, but a fake can drift from the real API and every test stays green.

The **opt-in e2e** runs that *same* contract against the **live** APIs to catch such drift
([ADR 0003](adr/0003-opt-in-e2e-validates-fakes-against-real-backends.md)). It is
**local/manual only** — never part of `npm test`, the lint gate, or CI.

> **Use a throwaway test account, not a real vault.** The suite creates and then
> recursively deletes an `airsync-e2e-*` folder on each run.

## TL;DR

```bash
cp .env.e2e.example .env.e2e          # gitignored; fill the Google / OneDrive / pCloud client ids first
npm run e2e:bootstrap -- google       # authorize in the browser → token auto-written to .env.e2e
npm run e2e:bootstrap -- dropbox      # authorize in the browser → token auto-written to .env.e2e
npm run e2e:bootstrap -- onedrive     # authorize in the browser → token auto-written to .env.e2e
npm run e2e:bootstrap -- pcloud       # authorize in the browser → access token auto-written to .env.e2e
npm run test:e2e                      # runs the contract against the live APIs
```

With **no** credentials, `npm run test:e2e` warns and skips every backend and exits 0 — so
it can never break anything if run by accident.

## Prerequisites

- Node 20 or 22 (the e2e transport uses the global `fetch`).
- A **test** Google, Dropbox, (personal) Microsoft, and/or pCloud account. Each backend is
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
- **pCloud** — like Google/OneDrive, the production flow returns to `obsidian://` (via the auth
  worker, which holds the client secret), so the e2e uses **your own** dev OAuth client with the
  loopback redirect. Register an app at <https://docs.pcloud.com/> ("My Applications"), add
  `http://localhost:53682/callback` as a redirect URI, and put its client id **and secret** in
  `.env.e2e` (`AIRSYNC_E2E_PCLOUD_CLIENT_ID` / `_CLIENT_SECRET`). The bootstrap runs the
  `oauth2_token` exchange itself (the step the worker owns in production) and writes the
  long-lived access token (no refresh) plus the region host (`AIRSYNC_E2E_PCLOUD_API_HOST`,
  derived from the redirect's `hostname` / `locationid`) into `.env.e2e`. *Alternative:* because
  the token is long-lived, you can skip the bootstrap and client secret entirely and paste a
  token obtained any other way into `AIRSYNC_E2E_PCLOUD_ACCESS_TOKEN` by hand (set
  `AIRSYNC_E2E_PCLOUD_API_HOST=eapi.pcloud.com` for an EU account; US `api.pcloud.com` is the default).

## Obtaining tokens

`npm run e2e:bootstrap -- <google|dropbox|onedrive|pcloud>`:

1. Starts a localhost loopback server and prints an authorization URL.
2. You open it and approve — the browser is redirected back to the loopback, which captures the
   code automatically (no copy-paste).
3. The code is exchanged for tokens and the credential is written straight into `.env.e2e`.

Google/Dropbox/OneDrive reuse the shipped auth code (`GoogleAuthDirect` / `DropboxAuth` /
`OneDriveAuth`) and mint a **refresh token**. pCloud has no shipped exchange to reuse (the auth
worker owns it in production), so its bootstrap does the `oauth2_token` exchange inline and writes
a **long-lived access token** (no refresh) plus `AIRSYNC_E2E_PCLOUD_API_HOST`.

Tokens are long-lived; redo the bootstrap only if one is revoked. For pCloud you can also skip the
bootstrap and paste `AIRSYNC_E2E_PCLOUD_ACCESS_TOKEN` (and, for EU, `AIRSYNC_E2E_PCLOUD_API_HOST`)
into `.env.e2e` by hand — the token is long-lived, so a one-time paste works just as well.

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
| `AIRSYNC_E2E_PCLOUD_CLIENT_ID` | pCloud — your dev OAuth client id (for the loopback bootstrap) |
| `AIRSYNC_E2E_PCLOUD_CLIENT_SECRET` | pCloud — your dev OAuth client secret (bootstrap-only; the `oauth2_token` exchange) |
| `AIRSYNC_E2E_PCLOUD_ACCESS_TOKEN` | pCloud — long-lived access token, minted by the bootstrap (or pasted by hand) |
| `AIRSYNC_E2E_PCLOUD_API_HOST` | pCloud — region host, set by the bootstrap (default `api.pcloud.com`; EU `eapi.pcloud.com`) |
| `AIRSYNC_E2E_OAUTH_PORT` | Optional loopback port (default 53682) |

## Running

It is **never** part of `npm test`, the lint gate, or CI — run it explicitly, when needed:

```bash
npm run test:e2e           # all backends — the per-backend files run IN PARALLEL
npm run test:e2e:google    # Google Drive only
npm run test:e2e:dropbox   # Dropbox only
npm run test:e2e:onedrive  # OneDrive only
npm run test:e2e:pcloud    # pCloud only
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
- **pCloud mtime.** `PCloudClient.uploadFile` sends `mtime` at **whole-second** precision
  (`Math.floor(mtime/1000)`) and pCloud preserves the supplied value, so a written mtime
  round-trips floored to the second — the OneDrive shape, not Dropbox's server clock. The suite
  therefore runs with `mtimePrecisionMs: 1000` (value preserved, compared floored to the second),
  not `preservesWrittenMtime: false`. Second precision is not load-bearing for sync (change
  detection is the opaque content-hash `remoteChecksum`). Like OneDrive's, this knob is justified
  by the live run; confirm/adjust it the first time you run the pCloud e2e. pCloud addresses by
  numeric `folderid`, so the throwaway `airsync-e2e-*` tree is created under the account root
  (folder id `0`).
- **pCloud auth.** pCloud issues a **long-lived access token with no refresh token**. Its
  bootstrap therefore has no shipped exchange to reuse (the auth worker owns the `oauth2_token`
  exchange in production), so it talks to pCloud directly with a dev OAuth client and runs that
  exchange inline, writing `AIRSYNC_E2E_PCLOUD_ACCESS_TOKEN` (used verbatim — no refresh) and the
  region host `AIRSYNC_E2E_PCLOUD_API_HOST` (default `api.pcloud.com`). Because the token is
  long-lived, a hand-pasted token works just as well.
- **pCloud access mode.** If your pCloud app is **Specific folder only**, the account-wide `diff`
  feed returns result 2096, so `PCloudFs` runs delta-less (cold reconcile each cycle); a
  **Full-access** app exercises the incremental `diff` path instead. The contract passes under
  either mode (the only difference is whether `getStartCursor()` returns a real cursor or `""`).
- **Leftover folders.** Cleanup runs in `afterAll` but is **best-effort** — it warns instead
  of failing the run (Google Drive's `drive.file` scope can't hard-delete and may 403 on trash under
  load). Folders are uniquely named, so delete any stray `airsync-e2e-*` from the test account
  by hand when needed.
- **Why it is not in CI.** Real network, credentials, and quota make it unsuitable as a gate;
  it backstops — it does not replace — the fast fake-based contracts.
