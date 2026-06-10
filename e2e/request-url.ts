/**
 * A real `requestUrl` implementation over Node's global `fetch`, used ONLY by the
 * opt-in e2e harness (ADR 0003). The shipped `obsidian` test mock
 * (`src/__mocks__/obsidian.ts`) rejects every `requestUrl` call; the e2e vitest
 * config aliases `obsidian` to `obsidian.shim.ts`, which swaps in this function so
 * the real `DriveClient` / `DropboxClient` / auth code talks to the live APIs.
 *
 * This file lives OUTSIDE `src/` on purpose: it uses `fetch` (banned repo-wide by
 * the obsidianmd `no-restricted-globals` rule) and is never bundled into the
 * plugin. The `e2e/` dir is added to eslint's `globalIgnores`.
 *
 * The returned object mirrors Obsidian's `RequestUrlResponse` shape the clients
 * actually read — `status`, `headers`, `text`, `arrayBuffer`, and a synchronous
 * `json` getter — and honors the `throw` option (default true → reject on a >=400
 * with a status-bearing Error, matching how Obsidian rejects so DriveClient's
 * 401 refresh-and-retry works).
 */

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

export async function realRequestUrl(
	param: string | RequestUrlParamLike,
): Promise<RequestUrlResponseLike> {
	const opts: RequestUrlParamLike =
		typeof param === "string" ? { url: param } : param;
	const shouldThrow = opts.throw ?? true;

	const headers: Record<string, string> = { ...opts.headers };
	if (opts.contentType) headers["Content-Type"] = opts.contentType;

	const res = await fetch(opts.url, {
		method: opts.method ?? "GET",
		headers,
		body: opts.body as BodyInit | undefined,
	});

	// Pre-read the body once so `.text` / `.json` / `.arrayBuffer` are synchronous
	// afterward (the clients never await these properties).
	const arrayBuffer = await res.arrayBuffer();
	const text = new TextDecoder().decode(arrayBuffer);
	let parsed: unknown;
	let parsedOk = false;
	const getJson = (): unknown => {
		if (!parsedOk) {
			parsed = text ? JSON.parse(text) : undefined;
			parsedOk = true;
		}
		return parsed;
	};

	const responseHeaders: Record<string, string> = {};
	res.headers.forEach((value, key) => {
		responseHeaders[key] = value; // fetch lowercases keys → matches headers["retry-after"]
	});

	const response: RequestUrlResponseLike = {
		status: res.status,
		headers: responseHeaders,
		arrayBuffer,
		text,
		get json(): unknown {
			return getJson();
		},
	};

	if (shouldThrow && res.status >= 400) {
		// Mirror Obsidian: reject with an Error carrying status/headers/json so
		// DriveClient's 401-retry and error re-wrapping (which read err.status)
		// behave exactly as in production.
		throw Object.assign(new Error(`request failed, status ${res.status}`), {
			status: res.status,
			headers: responseHeaders,
			get json(): unknown {
				return getJson();
			},
		});
	}
	return response;
}
