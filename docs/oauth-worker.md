# OAuth Worker

The **server side** of Google and pCloud authentication for Air Sync. Performs
server-side OAuth token exchange so the Client Secret stays off the client. For the
**plugin side** (`GoogleAuth` / `GoogleAuthDirect`, token storage, refresh), see
[google-drive-backend.md → Authentication](google-drive-backend.md#authentication).

The source lives in this repository:

| Path | What | Host |
|------|------|------|
| [`oauth-worker/`](../oauth-worker) | Cloudflare Worker — receives the https callback, exchanges the code for tokens, and relays the result to `obsidian://` | `auth-airsync.takezo.dev` (Cloudflare Workers) |
| [`pages/`](../pages) | Static site — landing page, privacy policy, terms of service, custom-OAuth callback | `airsync.takezo.dev` (GitHub Pages) |

## Overview

Google OAuth requires redirect URIs to use `https://` — custom schemes like
`obsidian://` are not allowed for Web application clients. The Worker receives the
OAuth callback, exchanges the authorization code for tokens using the server-held
Client Secret, and redirects to `obsidian://` with the tokens.

```
[Plugin] → [Google OAuth] → [Worker: /google/callback]
                                 ↓ code → token exchange
                            [obsidian://air-sync-auth?access_token=...&refresh_token=...]
```

## Endpoints (`oauth-worker/`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/google/callback` | Google OAuth redirect → token exchange → `obsidian://` redirect |
| POST | `/google/token/refresh` | Refresh token → new access token (JSON) |
| GET | `/pcloud/callback` | pCloud OAuth redirect → token exchange → `obsidian://` redirect |

### pCloud callback

pCloud redirects here with `code`, `state`, `hostname` (and `locationid`). The Worker
exchanges the code at `https://{hostname}/oauth2_token` (the `hostname` is region-pinned
— `api.pcloud.com` US / `eapi.pcloud.com` EU — and whitelisted to avoid SSRF) using the
server-held `PCLOUD_CLIENT_SECRET`, then redirects to
`obsidian://air-sync-auth?access_token=...&hostname=...&state=...`.

Unlike Google, pCloud issues a **long-lived access token with no refresh token and no
expiry**, so there is no `/pcloud/token/refresh` endpoint. The plugin stores only the
access token and re-pins the API host from `hostname`. The pCloud OAuth scope grants
access to the **whole account** (its `diff` feed is account-wide), which the plugin
filters to the vault subtree client-side — disclose this in the privacy policy.

Required worker config: `PCLOUD_CLIENT_ID` / `PCLOUD_REDIRECT_URI` as `[vars]` in
`wrangler.toml`, and `PCLOUD_CLIENT_SECRET` via `wrangler secret put`.

## `pages/callback/`

Custom OAuth redirect page for users who bring their own Google OAuth credentials.
Hosted on GitHub Pages at `airsync.takezo.dev/callback/`.

When a custom OAuth user completes Google sign-in, Google redirects to this page with
`?code=...&state=...`. The page then redirects to `obsidian://air-sync-auth?code=...&state=...`
so the plugin can exchange the code for tokens directly (with PKCE), without going
through the auth server.

Unlike the built-in flow (`/google/callback` on the Worker), no server-side token
exchange happens — the authorization code is passed through as-is.

## Infrastructure

| Domain | Host | Purpose |
|--------|------|---------|
| `airsync.takezo.dev` | GitHub Pages | Landing page, privacy policy, terms of service, custom-OAuth callback |
| `auth-airsync.takezo.dev` | Cloudflare Workers | OAuth token exchange relay |

## Local development

The relay has its own toolchain (Wrangler) and is **not** covered by the plugin gate
(`npm run lint && npm run build && npm test`) — it is excluded from the root ESLint,
TypeScript, and Vitest configs. Work on it from within `oauth-worker/`:

```bash
cd oauth-worker
npm install
npm run dev      # wrangler dev
npx tsc -noEmit  # type-check
```
