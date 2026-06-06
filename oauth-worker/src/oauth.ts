import { Env } from './types';
import { redirectPage, errorPage } from './html';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface AppConfig {
  redirectBase: string;
  displayName: string;
}

export const ALLOWED_APPS: Record<string, AppConfig> = {
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

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

export function parseState(raw: string): StatePayload | null {
  try {
    const json = JSON.parse(atob(raw));
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
    const errorBody = await tokenRes.text();
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
