import type { BackendHttpClient, BackendHttpRequest, BackendHttpResponse, JsonValue } from "../../backend-api";
import { requestUrl } from "../../platform/obsidian";

type PlatformResponse = Awaited<ReturnType<typeof requestUrl>>;

/** Append query parameters without the module hand-building a URL string. */
function withQuery(request: BackendHttpRequest): string {
	const query = request.query;
	if (!query || Object.keys(query).length === 0) return request.url;
	const pairs = Object.entries(query).map(
		([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
	);
	const separator = request.url.includes("?") ? "&" : "?";
	return `${request.url}${separator}${pairs.join("&")}`;
}

function wrapResponse(response: PlatformResponse): BackendHttpResponse {
	return {
		status: response.status,
		headers: response.headers,
		text: () => Promise.resolve(response.text),
		arrayBuffer: () => Promise.resolve(response.arrayBuffer),
		json: () => Promise.resolve(response.json as JsonValue),
	};
}

/**
 * The only HTTP surface a module may use. It routes through Obsidian's
 * `requestUrl` (mobile-compatible, no `fetch`) and exposes binary/text/headers/
 * status so provider-specific response handling stays inside the module.
 */
export function createHttpClient(): BackendHttpClient {
	return {
		request: async (request) => {
			// Always resolve the response so a module can inspect a non-2xx status
			// itself; `createContextTransport` reconstructs the `throw` rejection when
			// the caller asked for it.
			const response = await requestUrl({
				url: withQuery(request),
				method: request.method,
				headers: request.headers,
				body: request.body,
				throw: false,
			});
			return wrapResponse(response);
		},
	};
}
