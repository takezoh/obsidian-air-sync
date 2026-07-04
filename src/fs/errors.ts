import { getHeader } from "./headers";

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
 * - `permanent` — 構造的に不正な backend/protocol 応答 ⇒ retry しない。
 */
export type ErrorKind = "auth" | "permission" | "rateLimit" | "notFound" | "transient" | "permanent";

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
			const ra = getHeader(headers as Headers | Record<string, string>, "retry-after");
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
	if (err && typeof err === "object" && (err as { permanent?: unknown }).permanent === true) {
		return { kind: "permanent" };
	}
	const { status, retryAfter } = getErrorInfo(err);
	const retryAfterMs = retryAfter !== null ? retryAfter * 1000 : undefined;
	if (status === 401) return { kind: "auth" };
	if (status === 403) return { kind: "permission", retryAfterMs };
	if (status === 404) return { kind: "notFound" };
	if (status === 429) return { kind: "rateLimit", retryAfterMs };
	return { kind: "transient" };
}

/**
 * Upper bound on any single retry backoff (ms). A server (or a clock skewed
 * backwards) can emit a huge `Retry-After`; without a cap one retry could sleep for
 * hours and hang the sync. Matches the per-backend client cap (`MAX_RATE_LIMIT_DELAY_MS`).
 */
const MAX_RETRY_DELAY_MS = 64_000;

/**
 * What the retry loop should do with a classified error. Pure data so the policy
 * can be unit-tested in isolation (with an injected rng for the jitter).
 *
 * - `abort` — give up now and surface a user-facing message (`auth` / `permission`).
 * - `stop`  — stop retrying without a backoff (e.g. 404: the target is gone,
 *             または恒久的な backend/protocol failure）。
 * - `retry` — wait `delayMs`, then try again.
 * - `exhausted` — out of attempts; the caller falls through to its generic failure.
 */
export type RetryDecision =
	| { action: "abort"; kind: "auth" | "permission" }
	| { action: "stop" }
	| { action: "retry"; delayMs: number }
	| { action: "exhausted" };

/**
 * Decide what to do with a classified error on attempt `attempt` of `maxRetries`.
 * Pure and deterministic given `rng` (inject `Math.random` in production, a fixed
 * value in tests). Honours a server-set `retryAfterMs`; otherwise full-jitter
 * exponential backoff: base 2^(attempt-1) s, scaled by (0.5 + rng()).
 *
 * Lives here, with the error classification it acts on, so both the sync engine
 * and fs-layer backends (e.g. the Google Drive full-scan listing) reuse it.
 */
export function decideRetry(
	classification: ErrorClassification,
	attempt: number,
	maxRetries: number,
	rng: () => number,
): RetryDecision {
	if (classification.kind === "auth") return { action: "abort", kind: "auth" };
	if (classification.kind === "permission") return { action: "abort", kind: "permission" };
	if (classification.kind === "notFound" || classification.kind === "permanent") return { action: "stop" };
	if (attempt >= maxRetries) return { action: "exhausted" };

	const rawDelay = classification.retryAfterMs != null
		? classification.retryAfterMs
		: Math.pow(2, attempt - 1) * 1000 * (0.5 + rng());
	return { action: "retry", delayMs: Math.min(rawDelay, MAX_RETRY_DELAY_MS) };
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
