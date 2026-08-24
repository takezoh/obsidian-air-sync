# End-to-end testing against real backends

The unit suite verifies each backend with the shared `runIFileSystemContract` over
**in-memory fakes** of the Google Drive / Dropbox / OneDrive clients (see
[ADR 0002](adr/0002-backends-verified-by-shared-behaviour-contracts.md)). That is fast and
runs in CI, but a fake can drift from the real API and every test stays green.

The **opt-in e2e** runs that *same* contract against the **live** APIs to catch such drift
([ADR 0003](adr/0003-opt-in-e2e-validates-fakes-against-real-backends.md)). It is
**local/manual only** — never part of `npm test`, the lint gate, or CI.

Every backend suite also runs the Issue #45 composed rename-safety scenario: establish a
persisted metadata checkpoint, perform a local-origin case-only rename, perform a
remote-origin case-only rename through the real delta API, reset the checkpoint for a
later COLD cycle, then assert one correctly-cased copy, preserved content, and no opposing
delete. The shared CRUD contracts additionally verify that native identity survives rename
and changes on same-path replacement. Supplying the real `MetadataStore` in this scenario
is load-bearing: without it the scope fingerprint cannot commit, every cycle is COLD, and
the fixture bypasses the WARM delta-evidence path used by the plugin.

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
it can never break anything if run by accident. A skipped run proves only that the harness
is credential-gated; it is not live semantic evidence and must be reported as blocked.

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
- **OneDrive** — the shipped app is registered only with the `obsidian://air-sync-auth` redirect
  (and you don't own it), but the headless e2e needs a `http://localhost:53682/callback` loopback,
  so it uses **your own** Entra app, exactly like Google. At <https://entra.microsoft.com> register an app with
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
| `AIRSYNC_E2E_EXTRA_CA` | Optional PEM bundle of extra trust anchors for the Electron `net` host (see [Running behind a TLS-intercepting proxy](#running-behind-a-tls-intercepting-proxy)) |

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

### Run it OUTSIDE an agent/CLI sandbox

The e2e needs two things a command sandbox typically denies, and **both fail in ways that
do not look like a sandbox problem**:

- **Read access to `.env.e2e`.** A sandbox that masks the file (e.g. bind-mounting it to
  `/dev/null`) leaves `readCreds` empty, so every backend takes the *skip* path and the run
  exits **0 with a warning** — a green-looking run that never touched a live API. Check with
  `ls -l .env.e2e`: a character device (`crw-rw-rw- … 1, 3`) instead of a regular file means
  it is masked.
- **Local sockets for the Electron net host.** `e2e/electron-net-setup.ts` starts an Electron
  process so `requestUrl` runs on its real transport. Blocked loopback/dbus sockets surface as
  `The platform failed to initialize` followed by
  `Electron net host did not become healthy at http://127.0.0.1:<port>/health within 30000ms`,
  and vitest then reports `No test files found` — the global-setup failure, not a missing test.

So run the e2e from a plain shell. Under Claude Code that means
`dangerouslyDisableSandbox: true` (or `/sandbox` to relax the policy); the sandboxed run is
worse than useless because it is **green while proving nothing**.

> Running Google individually needs `AIRSYNC_E2E_GOOGLE_CLIENT_ID`/`_CLIENT_SECRET` in
> `.env.e2e` (the refresh token alone falls back to the built-in auth server, which can't
> refresh a token minted by your own OAuth client). OneDrive likewise needs
> `AIRSYNC_E2E_ONEDRIVE_CLIENT_ID` (the refresh token is bound to your own client; the shipped app has no localhost redirect).

## Running behind a TLS-intercepting proxy

Some environments (hosted CI runners, corporate networks) route all egress through a
proxy that terminates TLS and re-signs every certificate with its own CA. The e2e runs on
**Electron's `net`** (the desktop engine — that's the whole point, see
[ADR 0003](adr/0003-opt-in-e2e-validates-fakes-against-real-backends.md)), and Chromium's
network stack on Linux ships its **own** root store — it ignores the system CA bundle and
`NODE_EXTRA_CA_CERTS`. So even when `curl` works, every request fails with
`net::ERR_CERT_AUTHORITY_INVALID`. (`--use-system-ca` does **not** help on Linux.)

Point `AIRSYNC_E2E_EXTRA_CA` at a PEM bundle that includes the proxy's CA:

```bash
AIRSYNC_E2E_EXTRA_CA=/etc/ssl/certs/ca-certificates.crt npm run test:e2e
```

The Electron `net` host then installs a `setCertificateVerifyProc` that does **real**
validation against that bundle — it walks the presented chain, checks each link's
signature, requires the leaf to match the requested host, and requires the chain to anchor
in a CA from the bundle. It is **not** a blanket "trust everything": an unrelated or forged
cert still fails. Leave the variable **unset** (the default) and Chromium's normal strict
validation is used unchanged — so ordinary local runs are unaffected.

> Use the **fetch** transport instead (`AIRSYNC_E2E_TRANSPORT=fetch`, which honours
> `NODE_EXTRA_CA_CERTS`) only as a last resort: it diverges from desktop on the
> redirect-auth / `Content-Length` bug classes this e2e exists to catch, so it false-greens
> them (see `e2e/request-url.ts`).

If the proxy also enforces a host **allowlist**, a backend can authenticate yet still 403 on
the host its content up/downloads redirect to (e.g. OneDrive's `*.microsoftpersonalcontent.com`,
returned as `403 Host not in allowlist: …`). That is an egress-policy limit, not a test or
credential failure — add the host to the environment's egress settings to let those tests run.

## Built-in Google folder Picker probe

The built-in Google folder-selection flow has a separate, headed, interactive T3 probe. It
starts with the shipped `GoogleAuth.getFolderPickerAuthorizationUrl()`, traverses Google's
top-level folder selection and the deployed production auth Worker, and observes Chrome's
actual attempt to navigate to `obsidian://air-sync-auth`. It then uses the access token and
single selected id from that observed attempt with `GoogleDriveClient.getFile`, requiring the
same id and the Google Drive folder MIME type. Reading or reconstructing a link from the Worker
page is not accepted as success.

This probe is intentionally excluded from `npm test`, `npm run test:e2e`,
`npm run test:e2e:google`, and CI. Its deterministic oracle, preflight, redaction, and isolation
checks run without Google or a browser:

```bash
npm run test:e2e:google-picker:oracle
```

For a live run, use a dedicated persistent Chrome profile outside this repository. Sign that
profile into a throwaway Google account beforehand, close every Chrome process using it, and
provide an explicit system-Chrome executable. Consent may change grants on that throwaway
account. The default human-completion deadline is 300 seconds; an override must be 1–600
seconds.

```bash
export AIRSYNC_E2E_GOOGLE_PICKER_CHROME=/absolute/path/to/google-chrome
export AIRSYNC_E2E_GOOGLE_PICKER_USER_DATA_DIR=/absolute/path/outside/the/repo/airsync-picker-profile
npm run test:e2e:google-picker
```

The command hard-fails rather than skipping when Node is not 20 or 22, global `WebSocket` is
unavailable, a native Linux Chrome has neither `DISPLAY` nor `WAYLAND_DISPLAY`, Chrome is
missing, the external profile is unwritable or locked, or the user does not finish in time. Set
`AIRSYNC_E2E_GOOGLE_PICKER_TIMEOUT_SECONDS` only when a different bounded deadline is needed.
On WSL with Windows Chrome, both paths must be WSL-visible absolute paths and `wslpath` must be
available. The harness launches the executable through its WSL path and converts the profile
argument for Windows Chrome; WSLg display variables are not required. Node 20 installations without a global
`WebSocket` are unsupported for this probe even though the other backend E2Es can run.

Chrome is launched headful. The harness does not click Google UI, use selectors, retry, or
sleep through failures: a human completes consent and selects exactly one folder. `SIGINT`,
`SIGTERM`, timeout, assertion failure, and normal completion all close the owned CDP connection
and Chrome process. Progress and errors contain only fixed stage/error-class labels. The OAuth
URL, Worker callback, Obsidian deep link, tokens, cookies, selected id, CDP payloads, browser
stdio, screenshots, and profile contents are neither printed nor persisted.

A green oracle command proves only the deterministic implementation. A live proof is verified
only when the dedicated command reaches the production Worker, observes its later same-session
external-protocol navigation attempt, and passes the real Drive folder lookup. If no suitable
display/profile/human is available, report the live criterion as unverified—do not treat it as
skipped or green.

## Notes

- **Dropbox mtime.** `DropboxFs` reports `server_modified` (the upload wall-clock) as `mtime`,
  so a written mtime does not round-trip — the fake echoes it back, the live backend does not.
  The Dropbox suite therefore runs the contract with `preservesWrittenMtime: false` (Google Drive
  keeps the default `true`), relaxing only the mtime-equality checks to "a plausible
  timestamp." mtime is not Dropbox's change-detection signal (that is the content-hash
  `remoteChecksum`), so nothing load-bearing is dropped. This is the documented divergence
  from ADR 0002, surfaced by this e2e.
- **Dropbox case-only rename.** Dropbox documents that `move_v2` does not support
  case-only renaming, and casing-only changes are not returned by `list_folder/continue`.
  `DropboxFs.rename()` therefore uses a deterministic intermediate sibling path, resumes
  the second leg when that path already contains the same stable id, rejects a foreign
  occupant before mutation, and rolls the first leg back when the final move fails. The
  live composed scenario performs the remote-origin rename through two raw client moves,
  modelling another Dropbox client without pre-updating Air Sync's cache. See
  [Issue #47](https://github.com/takezoh/obsidian-air-sync/issues/47) and the
  [official Dropbox SDK route contract](https://dropbox.github.io/dropbox-sdk-js/Dropbox.html#filesMoveV2__anchor).
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
