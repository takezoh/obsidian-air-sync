import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loopback OAuth capture for the e2e token bootstrap (ADR 0003). Starts a local
 * HTTP server, hands its `redirect_uri` to the caller, and resolves with the
 * query params the browser is redirected to after consent — so a headless CLI
 * needs no copy-paste.
 */

/** Default loopback port; override with AIRSYNC_E2E_OAUTH_PORT. Must match the registered redirect URI. */
export function loopbackPort(): number {
	const fromEnv = Number(process.env.AIRSYNC_E2E_OAUTH_PORT);
	return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 53682;
}

export interface LoopbackCapture {
	/** The redirect URI to send in the authorize request (matches the listening server). */
	redirectUri: string;
	/** Resolves with the callback query params once the browser hits the loopback. */
	waitForCallback: () => Promise<Record<string, string>>;
	/** Stop the server (call in a finally). */
	close: () => void;
}

/** Start the loopback server on `/callback` and return handles to drive the flow. */
export function startLoopback(port: number): LoopbackCapture {
	let resolveParams: (params: Record<string, string>) => void;
	let rejectParams: (err: Error) => void;
	const captured = new Promise<Record<string, string>>((res, rej) => {
		resolveParams = res;
		rejectParams = rej;
	});

	const server = createServer((req, response) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		if (url.pathname !== "/callback") {
			response.statusCode = 404;
			response.end("Not found");
			return;
		}
		const params = Object.fromEntries(url.searchParams.entries());
		response.statusCode = 200;
		response.setHeader("Content-Type", "text/html; charset=utf-8");
		const ok = params.code || params.access_token;
		response.end(
			`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif">` +
				(ok
					? `<h2>✓ Authorized</h2><p>You can close this tab and return to the terminal.</p>`
					: `<h2>⚠ No code in callback</h2><pre>${JSON.stringify(params)}</pre>`) +
				`</body>`,
		);
		if (ok) resolveParams(params);
		else rejectParams(new Error(`Callback had no code/token: ${JSON.stringify(params)}`));
	});

	server.on("error", (err) => rejectParams(err));
	server.listen(port);

	return {
		redirectUri: `http://localhost:${port}/callback`,
		waitForCallback: () => captured,
		close: () => server.close(),
	};
}

/**
 * Upsert a `KEY=value` line in `.env.e2e` (repo root), creating the file if
 * needed — so a captured refresh token lands where `test:e2e` reads it.
 */
export function writeEnvE2e(key: string, value: string): string {
	const path = resolve(import.meta.dirname, "../../.env.e2e");
	let lines: string[] = [];
	try {
		lines = readFileSync(path, "utf8").split("\n");
	} catch {
		// No file yet — start fresh.
	}
	const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
	if (idx >= 0) lines[idx] = `${key}=${value}`;
	else lines.push(`${key}=${value}`);
	writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"));
	return path;
}
