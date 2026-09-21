import type { BackendHttpClient, BackendHttpMethod } from "../backend-api";

/**
 * The narrow HTTP seam a backend client/auth region accepts.
 *
 * A backend module implementation does not import Obsidian: core constructs this
 * transport from `BackendRuntimeContext.http` at the module boundary and injects
 * it. The live E2E (and the legacy core-side providers/tests) construct the same
 * seam over `platform/obsidian`'s `requestUrl` instead, so both paths share one
 * request/response contract rather than reaching into a client's internals.
 *
 * The request/response shapes deliberately mirror Obsidian's `RequestUrlParam`/
 * `RequestUrlResponse` (including the `throw` default and the synchronous body
 * accessors) so the migration is behaviour-preserving: binary/text/JSON bodies,
 * headers, status, and provider error bodies survive unchanged.
 */
export interface HttpTransportRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	/** Reject on a `>=400` status. Defaults to `true`, matching `requestUrl`. */
	throw?: boolean;
}

export interface HttpTransportResponse {
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly arrayBuffer: ArrayBuffer;
	readonly text: string;
	readonly json: unknown;
}

export interface HttpTransport {
	request(request: HttpTransportRequest): Promise<HttpTransportResponse>;
}

/** Parse a response body; an empty or non-JSON body is `undefined`, never a throw. */
function parseJson(text: string): unknown {
	if (text.length === 0) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Adapt the public `BackendRuntimeContext.http` (async body accessors) to the
 * synchronous seam the clients read. Core's `createHttpClient` never rejects on a
 * status, so this is where `requestUrl`'s `throw !== false` rejection semantics are
 * reconstructed — including the rejected error's `status`/`headers`/`json`/`text`
 * that each backend's error wrapping reads.
 *
 * On the success path `text`/`json` are lazy getters over the resolved bytes (as
 * `requestUrl`'s own getters are), so a binary download never pays to decode a body
 * no client reads. The error path does NOT get that benefit: `Object.assign`
 * evaluates those getters to copy their values onto the thrown error, so every
 * `>=400` response decodes its body up front.
 */
export function createContextTransport(client: BackendHttpClient): HttpTransport {
	return {
		request: async (request) => {
			const response = await client.request({
				url: request.url,
				method: request.method as BackendHttpMethod | undefined,
				headers: request.headers,
				body: request.body,
			});
			const arrayBuffer = await response.arrayBuffer();
			const transportResponse: HttpTransportResponse = {
				status: response.status,
				headers: { ...response.headers },
				arrayBuffer,
				get text(): string {
					return new TextDecoder().decode(arrayBuffer);
				},
				get json(): unknown {
					return parseJson(transportResponse.text);
				},
			};
			if (request.throw !== false && response.status >= 400) {
				throw Object.assign(new Error(`request failed, status ${response.status}`), {
					status: response.status,
					headers: transportResponse.headers,
					text: transportResponse.text,
					get json(): unknown {
						return transportResponse.json;
					},
				});
			}
			return transportResponse;
		},
	};
}
