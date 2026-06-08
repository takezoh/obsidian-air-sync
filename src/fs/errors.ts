export class AuthError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "AuthError";
		this.status = status;
	}
}

/**
 * Backend-neutral classification of a failed I/O, on which the sync engine's retry
 * policy acts without knowing any backend's error shape.
 *
 * - `auth` — credentials invalid/expired ⇒ abort and prompt to reconnect.
 * - `permission` — authenticated but forbidden ⇒ abort and prompt about permissions.
 * - `rateLimit` — throttled ⇒ retry, honouring `retryAfterMs` when the server set one.
 * - `notFound` — the target is gone (404) ⇒ stop retrying.
 * - `transient` — network blip / 5xx / unknown ⇒ retry with backoff.
 */
export type ErrorKind = "auth" | "permission" | "rateLimit" | "notFound" | "transient";

export interface ErrorClassification {
	kind: ErrorKind;
	/** Server-requested delay before retry, derived from a Retry-After header (ms). */
	retryAfterMs?: number;
}

export interface ErrorInfo {
	status: number | null;
	retryAfter: number | null;
}

/**
 * Extract the HTTP status and Retry-After (seconds) from an arbitrary thrown value.
 * Transport-level and backend-neutral — it understands `requestUrl`/Fetch error
 * shapes, not any one backend's body. Backends layer their own meaning on top via
 * {@link IBackendProvider.classifyError}.
 */
export function getErrorInfo(err: unknown): ErrorInfo {
	if (err && typeof err === "object") {
		const status =
			"status" in err ? (err as { status: number }).status : null;
		let retryAfter: number | null = null;
		if ("headers" in err) {
			const headers = (err as { headers: unknown }).headers;
			let ra: string | null | undefined;
			if (headers && typeof headers === "object" && "get" in headers && typeof (headers as { get: unknown }).get === "function") {
				// Fetch API Headers object
				ra = (headers as Headers).get("retry-after");
			} else if (headers && typeof headers === "object") {
				const h = headers as Record<string, string>;
				ra = h["retry-after"] ?? h["Retry-After"];
			}
			if (ra) {
				const parsed = Number(ra);
				if (!isNaN(parsed)) {
					// Clamp: a malformed negative Retry-After must not become a negative
					// (immediately-resolving) sleep that defeats throttling.
					retryAfter = Math.max(0, parsed);
				} else {
					// RFC 7231: Retry-After can be an HTTP-date
					const dateMs = Date.parse(ra);
					if (!isNaN(dateMs)) {
						retryAfter = Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
					}
				}
			}
		}
		return { status, retryAfter };
	}
	return { status: null, retryAfter: null };
}

/**
 * Default, backend-neutral classification by HTTP status. Backends with quirkier
 * conventions (e.g. Google's 403-means-rate-limit) wrap this in their own
 * `classifyError`; the sync engine uses this directly when a backend has none.
 *
 * `retryAfterMs` is surfaced only for the statuses where a server delay is
 * meaningful (403/429); `transient` falls through to the engine's backoff.
 */
export function classifyHttpError(err: unknown): ErrorClassification {
	if (err instanceof AuthError) return { kind: "auth" };
	const { status, retryAfter } = getErrorInfo(err);
	const retryAfterMs = retryAfter !== null ? retryAfter * 1000 : undefined;
	if (status === 401) return { kind: "auth" };
	if (status === 403) return { kind: "permission", retryAfterMs };
	if (status === 404) return { kind: "notFound" };
	if (status === 429) return { kind: "rateLimit", retryAfterMs };
	return { kind: "transient" };
}
