/**
 * `requestUrl` for the opt-in e2e (ADR 0003), with a switchable transport:
 *
 *   AIRSYNC_E2E_TRANSPORT=electron  (default) — delegate to the Electron `net` host
 *     (electron-net-host.cjs); the SAME engine Obsidian uses on desktop, so redirect-
 *     auth / Content-Length / empty-body behaviours match production.
 *   AIRSYNC_E2E_TRANSPORT=fetch              — Node `fetch` (undici). Fast, but DIVERGES
 *     from Electron net (strips auth across cross-origin redirects, drops a hand-set
 *     Content-Length) so it false-greens those bug classes. Kept for speed/fallback and
 *     for measuring the net-vs-fetch cost.
 *
 * AIRSYNC_E2E_TIMING=1 logs each request's wall time to stderr.
 *
 * This file lives OUTSIDE `src/` on purpose: it uses Node APIs (`http`, `fetch`) banned
 * repo-wide by the obsidianmd `no-restricted-globals` rule, and is never bundled.
 *
 * Either path returns Obsidian's `RequestUrlResponse` shape the clients read — `status`,
 * `headers`, `text`, `arrayBuffer`, a synchronous `json` getter — and honours `throw`
 * (default true → reject on a >=400 with a status-bearing Error).
 */
import http from "node:http";

interface RequestUrlParamLike {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer | Uint8Array;
	throw?: boolean;
	contentType?: string;
}

interface RequestUrlResponseLike {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	text: string;
	readonly json: unknown;
}

const TRANSPORT = process.env.AIRSYNC_E2E_TRANSPORT ?? "electron";
const TIMING = process.env.AIRSYNC_E2E_TIMING === "1";

export async function realRequestUrl(
	param: string | RequestUrlParamLike,
): Promise<RequestUrlResponseLike> {
	const opts: RequestUrlParamLike = typeof param === "string" ? { url: param } : param;
	const t0 = TIMING ? process.hrtime.bigint() : 0n;
	try {
		return TRANSPORT === "fetch" ? await viaFetch(opts) : await viaElectronNet(opts);
	} finally {
		if (TIMING) {
			const ms = Number(process.hrtime.bigint() - t0) / 1e6;
			process.stderr.write(`[e2e-timing ${TRANSPORT}] ${opts.method ?? "GET"} ${opts.url} ${ms.toFixed(0)}ms\n`);
		}
	}
}

// ── Shared response builder ──────────────────────────────────────────────────

function buildResponse(
	status: number,
	headers: Record<string, string>,
	arrayBuffer: ArrayBuffer,
	shouldThrow: boolean,
): RequestUrlResponseLike {
	const text = new TextDecoder().decode(arrayBuffer);
	let parsed: unknown;
	let parsedDone = false;
	const getJson = (): unknown => {
		if (!parsedDone) {
			try {
				parsed = text ? JSON.parse(text) : undefined;
			} catch {
				parsed = undefined;
			}
			parsedDone = true;
		}
		return parsed;
	};
	const response: RequestUrlResponseLike = {
		status,
		headers,
		arrayBuffer,
		text,
		get json(): unknown {
			return getJson();
		},
	};
	if (shouldThrow && status >= 400) {
		throw Object.assign(new Error(`request failed, status ${status}`), {
			status,
			headers,
			get json(): unknown {
				return getJson();
			},
		});
	}
	return response;
}

// ── Electron net transport (faithful to desktop) ─────────────────────────────

interface HostResult {
	ok: boolean;
	status?: number;
	headers?: Record<string, string>;
	bodyBase64?: string;
	error?: string;
}

const HOST_PORT = Number(process.env.AIRSYNC_E2E_ELECTRON_NET_PORT || 39271);
const HOST_URL = `http://127.0.0.1:${HOST_PORT}/`;
// Reuse one keep-alive connection to the local host so the control hop is ~free.
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });

function postToHost(cmd: unknown): Promise<HostResult> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(cmd);
		const req = http.request(
			HOST_URL,
			{
				method: "POST",
				agent: keepAliveAgent,
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
			},
			(res) => {
				let data = "";
				res.on("data", (c) => (data += c));
				res.on("end", () => {
					try {
						resolve(JSON.parse(data) as HostResult);
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				});
			},
		);
		req.on("error", (err) =>
			reject(
				new Error(`Electron net host unreachable at ${HOST_URL} (is the e2e globalSetup running?): ${err.message}`),
			),
		);
		req.write(payload);
		req.end();
	});
}

function toBase64(body: string | ArrayBuffer | Uint8Array): string {
	if (typeof body === "string") return Buffer.from(body, "utf8").toString("base64");
	const view = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
	return Buffer.from(view).toString("base64");
}

/** Build the outgoing header map identically for both transports (drift here would
 *  reintroduce the very net-vs-fetch divergence this file exists to avoid). */
function prepHeaders(opts: RequestUrlParamLike): Record<string, string> {
	const headers: Record<string, string> = { ...opts.headers };
	if (opts.contentType) headers["Content-Type"] = opts.contentType;
	return headers;
}

async function viaElectronNet(opts: RequestUrlParamLike): Promise<RequestUrlResponseLike> {
	const headers = prepHeaders(opts);
	const hasBody = opts.body !== undefined && opts.body !== null;
	const result = await postToHost({
		url: opts.url,
		method: opts.method ?? "GET",
		headers,
		hasBody,
		bodyBase64: hasBody ? toBase64(opts.body!) : "",
	});
	// Electron's err.message already carries the `net::` prefix — don't double it.
	if (!result.ok) throw new Error(result.error ?? "net request failed");
	const buf = Buffer.from(result.bodyBase64 ?? "", "base64");
	const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	return buildResponse(result.status ?? 0, result.headers ?? {}, arrayBuffer, opts.throw ?? true);
}

// ── fetch transport (fast, but diverges from desktop) ────────────────────────

async function viaFetch(opts: RequestUrlParamLike): Promise<RequestUrlResponseLike> {
	const res = await fetch(opts.url, {
		method: opts.method ?? "GET",
		headers: prepHeaders(opts),
		body: opts.body as BodyInit | undefined,
	});
	const arrayBuffer = await res.arrayBuffer();
	const responseHeaders: Record<string, string> = {};
	res.headers.forEach((value, key) => (responseHeaders[key] = value));
	return buildResponse(res.status, responseHeaders, arrayBuffer, opts.throw ?? true);
}
