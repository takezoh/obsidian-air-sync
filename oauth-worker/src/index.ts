/*
 * Cloudflare Worker source — NOT part of the Obsidian plugin bundle (main.js).
 * The Obsidian community submission bot lints the whole repository with its own
 * ruleset, but without this sub-project's tsconfig and @cloudflare/workers-types,
 * so every Workers runtime global (Request/Response/URL) resolves as an `error`
 * type and trips @typescript-eslint's no-unsafe-* rules. This file is type-checked
 * separately by its own tsc (oauth-worker/tsconfig.json) + wrangler, so the plugin
 * ruleset does not apply to it. Our own gate already ignores oauth-worker/** —
 * this directive is only for the submission bot, which does not honor that ignore.
 */
/* eslint-disable */
import { Env } from './types';
import { handleCallback, handleTokenRefresh } from './oauth';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, no-cache',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function withHeaders(response: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/google/callback' && request.method === 'GET') {
      const res = await handleCallback(request, env);
      return withHeaders(res);
    }

    if (path === '/google/token/refresh') {
      if (request.method === 'OPTIONS') {
        return withHeaders(new Response(null, { status: 204 }), CORS_HEADERS);
      }
      if (request.method === 'POST') {
        const res = await handleTokenRefresh(request, env);
        return withHeaders(res, CORS_HEADERS);
      }
    }

    return withHeaders(new Response('Not Found', { status: 404 }));
  },
};
