import type { BackendErrorKind, BackendErrorShape } from "../../backend-api";
import { backendError } from "../../backend-api";
import { AuthError, getErrorInfo } from "../../backend-api/error-classification";

/**
 * Turn a public error shape into an actual `Error` before it is thrown.
 *
 * The Backend Module API is deliberately a structural contract (a dynamically
 * loaded module can never share a class identity with core), so a module signals a
 * classified failure by throwing a value that *carries* the shape. Core continues to
 * recognize it with `isBackendErrorShape`, while the code stays honest to the
 * engine's "throw an Error" convention.
 *
 * An `auth` shape additionally becomes a real {@link AuthError} so the core bundle
 * keeps an Error identity, but the cycle-abort decision is structural: core checks
 * `isAuthFailure` (a shape carrying `kind: "auth"`), so a separately bundled module
 * whose `AuthError` class identity differs from core's still aborts the cycle and
 * prompts reconnect. The structural shape is attached for that check.
 */
export function toBackendError(shape: BackendErrorShape): Error {
	const error = shape.kind === "auth"
		? new AuthError(shape.message, 401)
		: new Error(shape.message);
	return Object.assign(error, shape);
}

/** Build and throw a classified backend failure. */
export function failBackend(kind: BackendErrorKind, message: string): never {
	throw toBackendError(backendError(kind, message));
}

/**
 * Translate a raw client error carrying the legacy `permanent` flag (with an
 * optional stable `permanentCode`) into the public taxonomy BEFORE any
 * status-based mapping can drop the code.
 *
 * The resumable-upload / upload-session protocol failures are thrown with this
 * shape (a 2xx init that omits the session URL). Without this, an adapter's
 * status-based translate step would re-derive `permanent` from the init status
 * alone and silently lose the stable `permanentCode` the retry/quarantine
 * consumer keys on — the module path and the HTTP-derived path would diverge.
 * Returns `null` when `err` is not flagged permanent.
 */
export function permanentErrorShape(err: unknown, message: string): BackendErrorShape | null {
	if (!err || typeof err !== "object" || (err as { permanent?: unknown }).permanent !== true) return null;
	const code = (err as { permanentCode?: unknown }).permanentCode;
	return typeof code === "string" && code.length > 0
		? backendError("permanent", message, { permanentCode: code })
		: backendError("permanent", message);
}

/**
 * Extract the server-requested retry delay (ms) from a transport error's
 * `Retry-After` header, for a rate-limit/transient error shape. Core's retry
 * policy (`decideRetry`) honors `retryAfterMs` instead of its fixed jitter, so a
 * backend that returns 429/503 with `Retry-After` is not retried too early.
 */
export function retryAfterMsOf(err: unknown): number | undefined {
	const { retryAfter } = getErrorInfo(err);
	return retryAfter !== null ? retryAfter * 1000 : undefined;
}

/**
 * Shared HTTP-status → public error-taxonomy mapping. A backend supplies only its
 * provider-specific overrides (e.g. Google 410, OneDrive/Dropbox 409); the default
 * is the backend-neutral convention. `retryAfterMs` is attached only where a retry
 * is actually made (rate limit / transient), never to an aborting failure.
 */
export function backendErrorFromStatus(
	status: number,
	message: string,
	overrides?: Readonly<Record<number, BackendErrorKind>>,
	retryAfterMs?: number,
): BackendErrorShape {
	const overridden = overrides?.[status];
	if (overridden !== undefined) return withRetryHint(overridden, message, retryAfterMs);
	switch (status) {
		case 401:
			return backendError("auth", message);
		case 403:
			return backendError("permission", message);
		case 404:
			return backendError("not_found", message);
		case 429:
			return withRetryHint("rate_limit", message, retryAfterMs);
		default:
			return status >= 500 || status === 0
				? withRetryHint("transient", message, retryAfterMs)
				: backendError("permanent", message);
	}
}

function withRetryHint(kind: BackendErrorKind, message: string, retryAfterMs: number | undefined): BackendErrorShape {
	return kind === "rate_limit" || kind === "transient"
		? backendError(kind, message, { retryAfterMs })
		: backendError(kind, message);
}
