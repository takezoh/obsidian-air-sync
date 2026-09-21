/**
 * The backend-neutral error taxonomy every module translates to at its
 * boundary (Backend Module API v3). Core owns retry/backoff policy; a module
 * only classifies and may attach a bounded retry hint.
 *
 * This is a structural contract, not a class: a module may throw a plain
 * object `{ kind, message }`. Core must not require `instanceof` — a dynamically
 * loaded artifact can never share a class identity with core.
 */
export type BackendErrorKind =
	| "auth"
	| "permission"
	| "rate_limit"
	| "not_found"
	| "target_changed"
	| "cursor_invalid"
	| "transient"
	| "permanent"
	| "unverifiable";

const BACKEND_ERROR_KINDS: ReadonlySet<string> = new Set<BackendErrorKind>([
	"auth",
	"permission",
	"rate_limit",
	"not_found",
	"target_changed",
	"cursor_invalid",
	"transient",
	"permanent",
	"unverifiable",
]);

/** A module-thrown error, structurally recognized by core. */
export interface BackendErrorShape {
	readonly kind: BackendErrorKind;
	/** Safe, redacted message suitable for diagnostics. */
	readonly message: string;
	/** Bounded retry hint; core clamps it to its own backoff policy. */
	readonly retryAfterMs?: number;
	/**
	 * Stable machine-readable code for a `permanent` failure. Core uses it to
	 * quarantine a repeated identical failure instead of re-attempting it forever.
	 */
	readonly permanentCode?: string;
	/** Optional redacted cause (never a token, auth code, or raw URL query). */
	readonly cause?: string;
}

export interface BackendErrorOptions {
	retryAfterMs?: number;
	permanentCode?: string;
	cause?: string;
}

/** Construct a boundary error value (does not throw). */
export function backendError(
	kind: BackendErrorKind,
	message: string,
	options?: BackendErrorOptions,
): BackendErrorShape {
	const error: {
		kind: BackendErrorKind;
		message: string;
		retryAfterMs?: number;
		permanentCode?: string;
		cause?: string;
	} = { kind, message };
	if (options?.retryAfterMs !== undefined) error.retryAfterMs = options.retryAfterMs;
	if (options?.permanentCode !== undefined) error.permanentCode = options.permanentCode;
	if (options?.cause !== undefined) error.cause = options.cause;
	return error;
}

/** Whether `value` structurally satisfies the public error contract. */
export function isBackendErrorShape(value: unknown): value is BackendErrorShape {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.kind !== "string" || !BACKEND_ERROR_KINDS.has(record.kind)) {
		return false;
	}
	if (typeof record.message !== "string") return false;
	if (record.retryAfterMs !== undefined && typeof record.retryAfterMs !== "number") {
		return false;
	}
	if (record.permanentCode !== undefined && typeof record.permanentCode !== "string") {
		return false;
	}
	return record.cause === undefined || typeof record.cause === "string";
}
