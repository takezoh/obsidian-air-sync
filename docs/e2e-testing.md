# End-to-end testing against real backends

The unit suite verifies each backend with the shared `runIFileSystemContract` over
**in-memory fakes** of the Google Drive / Dropbox clients (see
[ADR 0002](adr/0002-backends-verified-by-shared-behaviour-contracts.md)). That is fast and
runs in CI, but a fake can drift from the real API and every test stays green.

The **opt-in e2e** runs that *same* contract against the **live** APIs to catch such drift
([ADR 0003](adr/0003-opt-in-e2e-validates-fakes-against-real-backends.md)). It is
**local/manual only** — never part of `npm test`, the lint gate, or CI.

> **Use a throwaway test account, not a real vault.** The suite creates and then
> recursively deletes an `airsync-e2e-*` folder on each run.

## TL;DR

```bash
cp .env.e2e.example .env.e2e          # gitignored
npm run e2e:bootstrap -- google       # paste the printed token into .env.e2e
npm run e2e:bootstrap -- dropbox      # paste the printed token into .env.e2e
npm run test:e2e                      # runs the contract against the live APIs
```

With **no** credentials, `npm run test:e2e` warns and skips every backend and exits 0 — so
it can never break anything if run by accident.

## Prerequisites

- Node 20 or 22 (the e2e transport uses the global `fetch`).
- A **test** Google and/or Dropbox account. Each backend is independent: provide one token to
  test just that backend; the other warns and skips.

## Obtaining refresh tokens

`npm run e2e:bootstrap -- <google|dropbox>` reuses the shipped auth code to mint a refresh
token through the normal OAuth flow:

1. It prints an authorization URL — open it and approve access.
2. You are redirected to a callback URL. Copy the **full** URL (or the token/code fragment)
   and paste it back at the prompt.
3. It prints a line like `AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN=…` — add it to `.env.e2e`.

Google uses the built-in auth server (refresh needs only the refresh token); Dropbox uses
PKCE with the public client id (no secret). Tokens are long-lived; redo the bootstrap only if
one is revoked.

## Environment variables

Read from the real environment or a gitignored `.env.e2e` at the repo root (real env wins):

| Variable | Backend |
|---|---|
| `AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN` | Google Drive |
| `AIRSYNC_E2E_DROPBOX_REFRESH_TOKEN` | Dropbox |

## Running

```bash
npm run test:e2e
```

- **Both tokens present** → the full `runIFileSystemContract` runs against each live API. A
  fresh child folder is created per test (the contract assumes an empty start) under one
  per-run parent folder, which is deleted recursively in `afterAll`. A green run is the proof
  that the fakes still match reality.
- **One token missing** → that backend warns and skips; the other runs.
- **No tokens** → both warn and skip; exit 0.

## Notes

- **Dropbox mtime precision.** Dropbox truncates `client_modified` to whole seconds, so the
  Dropbox suite runs the contract with `mtimePrecisionMs: 1000` (Drive keeps the default `1`).
  This is the documented divergence from ADR 0002, exercised end-to-end without weakening the
  unit contract.
- **Leftover folders.** Cleanup runs in `afterAll`; if a run is killed mid-way, delete any
  stray `airsync-e2e-*` folder from the test account by hand.
- **Why it is not in CI.** Real network, credentials, and quota make it unsuitable as a gate;
  it backstops — it does not replace — the fast fake-based contracts.
