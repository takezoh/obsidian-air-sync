import { requestUrl } from "../platform/obsidian";
import type { HttpTransport, HttpTransportResponse } from "../backend-api/http-transport";

/**
 * The shipped/core-side transport: Obsidian's `requestUrl` (mobile-compatible,
 * never `fetch`). A backend module never imports this — core injects
 * `createContextTransport(context.http)` at the module boundary. The legacy
 * core-side providers, the unit-test obsidian mock, and the live E2E (whose
 * `obsidian` alias routes `requestUrl` to real HTTP) all construct the same seam
 * through this function.
 */
export function createPlatformTransport(): HttpTransport {
	return {
		request: async (request): Promise<HttpTransportResponse> => {
			return requestUrl({
				url: request.url,
				method: request.method,
				headers: request.headers,
				body: request.body,
				throw: request.throw,
			});
		},
	};
}
