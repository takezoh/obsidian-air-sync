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
const { app, net, session } = require("electron");
const http = require("http");
const fs = require("fs");
const { X509Certificate } = require("crypto");

const PORT = Number(process.env.AIRSYNC_E2E_ELECTRON_NET_PORT || 39271);

// Extra trust anchor for environments behind a TLS-intercepting egress proxy (e.g. the
// hosted runner): Chromium's net stack on Linux ignores the system CA bundle and rejects
// the proxy's re-signed certs with ERR_CERT_AUTHORITY_INVALID. When AIRSYNC_E2E_EXTRA_CA
// points at a PEM bundle we install a verify proc that does REAL validation against it —
// it walks the presented chain, checks each link's signature, requires the leaf to match
// the host, and requires the chain to anchor in a CA from that bundle. It is NOT a blanket
// "trust everything": an unrelated/forged cert still fails. Unset (the default) → no proc,
// so Chromium's normal strict validation is unchanged for ordinary local runs.
function installExtraCaTrust() {
	const caFile = process.env.AIRSYNC_E2E_EXTRA_CA;
	if (!caFile) return;
	const pem = fs.readFileSync(caFile, "utf8");
	const bundle = (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [])
		.map((b) => {
			try {
				return new X509Certificate(b);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	process.stdout.write(`ELECTRON_NET_HOST_EXTRA_CA ${caFile} (${bundle.length} CAs)\n`);

	// Electron hands us a linked leaf→issuer chain; rebuild detached X509Certificate copies.
	const chainOf = (cert) => {
		const out = [];
		let c = cert;
		let depth = 0;
		while (c && depth < 10) {
			out.push(new X509Certificate(c.data));
			if (!c.issuerCert || c.issuerCert === c) break;
			c = c.issuerCert;
			depth++;
		}
		return out;
	};
	const chainTrusted = (presented, hostname) => {
		if (!presented.length) return false;
		if (hostname && presented[0].checkHost(hostname) === undefined) return false;
		for (let i = 0; i < presented.length - 1; i++) {
			if (!presented[i].verify(presented[i + 1].publicKey)) return false;
		}
		const top = presented[presented.length - 1];
		return bundle.some((ca) => {
			try {
				return top.verify(ca.publicKey);
			} catch {
				return false;
			}
		});
	};

	session.defaultSession.setCertificateVerifyProc((request, callback) => {
		if (request.errorCode === 0) return callback(0); // Chromium already trusts it.
		try {
			callback(chainTrusted(chainOf(request.certificate), request.hostname) ? 0 : -2);
		} catch {
			callback(-2);
		}
	});
}

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

app.whenReady().then(() => {
	installExtraCaTrust();
	startServer();
});
// No windows — keep the process alive (don't quit on window-all-closed).
app.on("window-all-closed", () => {});
