import { Env } from './types';
import { handleCallback, handleTokenRefresh } from './oauth';
import { handlePCloudCallback } from './pcloud';

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

    if (path === '/pcloud/callback' && request.method === 'GET') {
      const res = await handlePCloudCallback(request, env);
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
