/**
 * Electron `net` host for the opt-in e2e (ADR 0003).
 *
 * Obsidian's `requestUrl` runs on Electron's `net` module on desktop — NOT `fetch`.
 * The two diverge on exactly the dimensions real bugs live on: `net` forwards the
 * `Authorization` header across a cross-origin redirect (fetch strips it), `net`
 * throws `ERR_INVALID_ARGUMENT` on a hand-set `Content-Length` (fetch drops it). So a
 * fetch-backed e2e false-greens those. This long-lived Electron process exposes
 * `net.request` over a tiny local control server; `e2e/request-url.ts` delegates every
 * `requestUrl` to it, so the e2e exercises the SAME engine production does.
 *
 * Launched by `e2e/electron-net-setup.ts` (vitest globalSetup) via
 * `xvfb-run -a electron … --no-sandbox`. Binds a fixed local port (overridable) so the
 * Node-side shim needs no cross-process coordination.
 */
const { app, net } = require("electron");
const http = require("http");

const PORT = Number(process.env.AIRSYNC_E2E_ELECTRON_NET_PORT || 39271);

/** Run one request through Electron `net` and resolve a serialisable result. */
// Watchdog: a hung socket (accepted but no response/end) must fail fast with a clear
// error rather than dangle until vitest's per-test timeout. Kept below it.
const REQUEST_TIMEOUT_MS = 120_000;

/** Run one request through Electron `net` and resolve a serialisable result EXACTLY once. */
function runNet(cmd) {
	return new Promise((resolve) => {
		let settled = false;
		let timer;
		const done = (r) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(r);
		};
		let request;
		try {
			request = net.request({ method: cmd.method || "GET", url: cmd.url });
			// Pass headers through verbatim — this is the whole point: a forbidden header
			// (e.g. a hand-set Content-Length) must reach net so it throws like production.
			for (const [k, v] of Object.entries(cmd.headers || {})) request.setHeader(k, v);
		} catch (err) {
			return done({ ok: false, error: `setHeader: ${err.message}` });
		}
		timer = setTimeout(() => {
			try {
				request.abort();
			} catch {
				/* already torn down */
			}
			done({ ok: false, error: `net::ERR_TIMED_OUT (host watchdog ${REQUEST_TIMEOUT_MS}ms)` });
		}, REQUEST_TIMEOUT_MS);
		request.on("response", (response) => {
			const chunks = [];
			response.on("data", (c) => chunks.push(Buffer.from(c)));
			// A mid-body stream error would otherwise leave 'end' unfired forever (hang),
			// and an unhandled stream 'error' crashes the host process.
			response.on("error", (err) => done({ ok: false, error: `response stream: ${err.message}` }));
			response.on("end", () => {
				const headers = {};
				for (const [k, v] of Object.entries(response.headers || {})) {
					headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
				}
				done({
					ok: true,
					status: response.statusCode,
					headers,
					bodyBase64: Buffer.concat(chunks).toString("base64"),
				});
			});
		});
		request.on("error", (err) => done({ ok: false, error: err.message }));
		// hasBody distinguishes "no body" (GET) from "empty body" (a 0-byte PUT): the
		// latter must still write so net sends Content-Length: 0, matching production.
		if (cmd.hasBody) request.write(Buffer.from(cmd.bodyBase64 || "", "base64"));
		request.end();
	});
}

function startServer() {
	const server = http.createServer((req, res) => {
		if (req.url === "/health") {
			res.writeHead(200);
			res.end("ok");
			return;
		}
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("error", () => {
			try {
				res.writeHead(400);
				res.end(JSON.stringify({ ok: false, error: "control request aborted" }));
			} catch {
				/* response already gone */
			}
		});
		req.on("end", async () => {
			let result;
			try {
				result = await runNet(JSON.parse(body));
			} catch (err) {
				result = { ok: false, error: `host: ${err.message}` };
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(result));
		});
	});
	// A bare listen failure (port in use from a leftover host, etc.) would otherwise be an
	// unhandled 'error' that crashes Electron with no signal — the globalSetup would then
	// just time out at 30s with a misleading "not healthy". Exit loudly with the cause.
	server.on("error", (err) => {
		process.stderr.write(`ELECTRON_NET_HOST_ERROR ${err.code || err.message}\n`);
		process.exit(1);
	});
	server.listen(PORT, "127.0.0.1", () => process.stdout.write(`ELECTRON_NET_HOST_READY ${PORT}\n`));
}

app.whenReady().then(startServer);
// No windows — keep the process alive (don't quit on window-all-closed).
app.on("window-all-closed", () => {});
