/*
 * Cloudflare Worker source — NOT part of the Obsidian plugin bundle (main.js).
 * The Obsidian community submission bot lints the whole repository with its own
 * ruleset, but without this sub-project's tsconfig and @cloudflare/workers-types,
 * so every Workers runtime global (Request/Response/URL/fetch) resolves as an
 * `error` type and trips @typescript-eslint's no-unsafe-* rules; `fetch` (the
 * correct API here — Obsidian's requestUrl does not exist in Workers) also trips
 * no-restricted-globals. This file is type-checked separately by its own
 * tsc (oauth-worker/tsconfig.json) + wrangler, so the plugin ruleset does not
 * apply to it. Our own gate already ignores oauth-worker/** — this directive is
 * only for the submission bot, which does not honor that ignore.
 */
/* eslint-disable */
import { Env } from './types';
import { redirectPage, errorPage } from './html';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface AppConfig {
  redirectBase: string;
  displayName: string;
}

const ALLOWED_APPS: Record<string, AppConfig> = {
  'obsidian-plugin': {
    redirectBase: 'obsidian://air-sync-auth',
    displayName: 'Obsidian',
  },
};

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface StatePayload {
  app: string;
  nonce: string;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

/** Decode a base64url or legacy standard-base64 state into its JSON payload. */
function decodeState(raw: string): { app?: unknown; nonce?: unknown } {
  // Accept both encodings: the plugin now emits base64url (URL-safe), but older
  // released versions emit standard base64. Normalize url-safe chars back to
  // standard and re-pad before atob so either form decodes.
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(atob(padded));
}

function parseState(raw: string): StatePayload | null {
  try {
    const json = decodeState(raw);
    if (typeof json.app === 'string' && typeof json.nonce === 'string') {
      return json as StatePayload;
    }
  } catch {
    // invalid base64 or JSON
  }
  return null;
}

export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');

  if (!code || !stateRaw) {
    return htmlResponse(errorPage('Missing authentication parameters.'), 400);
  }

  const state = parseState(stateRaw);
  if (!state) {
    return htmlResponse(errorPage('Invalid state parameter.'), 400);
  }

  const appConfig = ALLOWED_APPS[state.app];
  if (!appConfig) {
    return htmlResponse(errorPage('Unknown app.'), 400);
  }

  const tokenParams = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  });

  if (!tokenRes.ok) {
    // The callback path returns a user-facing HTML error page, so Google's raw
    // error body is intentionally not surfaced — only the status drives the copy.
    const detail = tokenRes.status >= 500
      ? `Google server error (${tokenRes.status})`
      : `Token exchange failed (${tokenRes.status})`;
    return htmlResponse(errorPage(detail), tokenRes.status >= 500 ? 502 : 400);
  }

  const tokens: TokenResponse = await tokenRes.json();

  const callbackParams = new URLSearchParams({
    access_token: tokens.access_token,
    expires_in: String(tokens.expires_in),
    state: stateRaw,
  });
  if (tokens.refresh_token) {
    callbackParams.set('refresh_token', tokens.refresh_token);
  }

  const callbackUri = `${appConfig.redirectBase}?${callbackParams.toString()}`;

  return htmlResponse(redirectPage(callbackUri, appConfig.displayName));
}

export async function handleTokenRefresh(request: Request, env: Env): Promise<Response> {
  let body: { refresh_token?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.refresh_token) {
    return Response.json({ error: 'Missing refresh_token' }, { status: 400 });
  }

  const tokenParams = new URLSearchParams({
    refresh_token: body.refresh_token,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  });

  if (!tokenRes.ok) {
    const errorBody = await tokenRes.text();
    const status = tokenRes.status >= 500 ? 502 : tokenRes.status;
    return new Response(errorBody, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const tokens: TokenResponse = await tokenRes.json();

  const result: Record<string, unknown> = {
    access_token: tokens.access_token,
    expires_in: tokens.expires_in,
  };
  if (tokens.refresh_token) {
    result.refresh_token = tokens.refresh_token;
  }
  return Response.json(result);
}
