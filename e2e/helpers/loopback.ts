import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { stdout } from "node:process";

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
	/** Resolves with the first callback whose state matches this authorization run. */
	waitForCallback: (expectedState: string) => Promise<Record<string, string>>;
	/** Stop the server (call in a finally). */
	close: () => void;
}

/**
 * Start the loopback server on `/callback`. Resolves once the server is actually
 * listening (so a bind failure like EADDRINUSE rejects HERE, where the caller
 * awaits it, instead of surfacing as an unhandled rejection while the user is
 * told to open a URL for a server that never came up).
 */
export function startLoopback(port: number): Promise<LoopbackCapture> {
	let resolveParams: (params: Record<string, string>) => void;
	let rejectParams: (err: Error) => void;
	let expectedState: string | null = null;
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
		if (!expectedState || params.state !== expectedState) {
			// A state mismatch is NOT an expiry: the provider echoes `state` back
			// untouched, so a wrong value means the authorize URL that was opened is not
			// the one this run printed (a stale tab, or a hand-copied URL). Say that —
			// and log it, because otherwise the terminal just sits on "Waiting for the
			// redirect..." while the browser shows an error, with no way to connect the two.
			const detail = !expectedState
				? "no authorization is in progress"
				: `state mismatch (expected ${expectedState.slice(0, 12)}…, got ${(params.state ?? "(absent)").slice(0, 12)}…)`;
			process.stderr.write(`\n[loopback] rejected callback: ${detail}\n`);
			response.statusCode = 409;
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(
				"<!doctype html><meta charset=\"utf-8\"><body style=\"font-family:sans-serif\">" +
					"<h2>⚠ Callback rejected</h2>" +
					"<p>The callback did not match the current authorization run.</p>" +
					"<p>Open the authorize URL printed by this bootstrap run — copying it by hand " +
					"corrupts <code>state</code>. Still waiting for a matching callback.</p></body>",
			);
			return;
		}
		const ok = params.code; // we only ever run the authorization-code flow
		response.statusCode = 200;
		response.setHeader("Content-Type", "text/html; charset=utf-8");
		response.end(
			`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif">` +
				(ok
					? `<h2>✓ Authorized</h2><p>You can close this tab and return to the terminal.</p>`
					: `<h2>⚠ No authorization code in callback</h2><p>See the terminal for details.</p>`) +
				`</body>`,
		);
		if (ok) resolveParams(params);
		else rejectParams(new Error(`Callback had no code: ${JSON.stringify(params)}`));
	});

	return new Promise<LoopbackCapture>((resolveStart, rejectStart) => {
		server.once("error", rejectStart); // bind failure (EADDRINUSE) → reject the start
		server.listen(port, () => {
			server.off("error", rejectStart);
			server.on("error", (err) => rejectParams(err)); // later errors fail the wait
			resolveStart({
				redirectUri: `http://localhost:${port}/callback`,
				waitForCallback: (state) => {
					expectedState = state;
					return captured;
				},
				close: () => server.close(),
			});
		});
	});
}

/**
 * Where {@link announceAuthorizeUrl} parks the authorize URL. A fixed path in the
 * repo root (gitignored alongside `.env.e2e`) so the URL can be opened WITHOUT being
 * retyped: printing it to stdout is not enough when the terminal is driven by a tool
 * or an agent, and hand-copying an `authorize` URL silently corrupts the opaque
 * `state`/`code_challenge` — which the loopback then rejects as a mismatch.
 */
const AUTHORIZE_URL_FILE = ".env.e2e.authorize-url";

/**
 * Print the authorize URL AND write it to {@link AUTHORIZE_URL_FILE}, then try to
 * open it in the default browser. Best-effort: a missing opener is not an error, the
 * file and the printed URL remain.
 */
export function announceAuthorizeUrl(backend: string, url: string): void {
	const path = resolve(process.cwd(), AUTHORIZE_URL_FILE);
	writeFileSync(path, `${url}\n`);
	stdout.write(
		`\nAuthorize ${backend}:\n${url}\n\n` +
			`(also written to ${AUTHORIZE_URL_FILE} — open THAT rather than copying the URL by hand)\n\n` +
			"Waiting for the redirect...\n",
	);
	// Detached + unref'd, never spawnSync: an opener that does not exit (a WSL helper
	// handing off to a Windows browser does not) would otherwise block Node's event loop,
	// and the loopback server could not answer the very redirect it is waiting for — the
	// browser would just spin on the callback URL.
	//
	// A missing opener surfaces as an ASYNC 'error' (ENOENT), never a throw, so the
	// fallback chain has to advance from that handler — a synchronous loop would always
	// stop at the first candidate whether or not it exists.
	const tryOpen = (candidates: string[]): void => {
		const [opener, ...rest] = candidates;
		if (!opener) return;
		const child = spawn(opener, [url], { stdio: "ignore", detached: true });
		child.on("error", () => tryOpen(rest));
		child.unref();
	};
	tryOpen(["wslview", "xdg-open", "open"]);
}

/**
 * Upsert a `KEY=value` line in `.env.e2e` (repo root), creating the file if
 * needed — so a captured refresh token lands where `test:e2e` reads it.
 */
export function writeEnvE2e(key: string, value: string): string {
	// Resolve from the working dir (npm/vitest run from the repo root) — NOT from
	// import.meta.dirname, which points at the bundle location (e2e/) once esbuild
	// inlines this helper, breaking a dirname-relative path.
	const path = resolve(process.cwd(), ".env.e2e");
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
