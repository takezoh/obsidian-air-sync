import type { BackendErrorKind } from "../../backend-api";
import { isBackendErrorShape } from "../../backend-api";
import type { ErrorClassification, ErrorKind } from "../errors";

/**
 * Translation from the public backend error taxonomy to the sync engine's
 * internal classification. This is the ONE place that knows the mapping, so
 * the sync core never parses a provider error or calls a module-specific
 * `classifyError()` after the fact.
 *
 * `target_changed` and `unverifiable` are non-retryable: a mutation/read that
 * could not prove its precondition must fail closed, not be retried into a
 * second attempt that might overwrite a version it never admitted.
 * `cursor_invalid` is normally an adapter RESULT (not a thrown error) that drives
 * a full scan; if it ever arrives as an error it is transient, because the next
 * observation can re-acquire a cursor.
 */
const KIND_MAP: Readonly<Record<BackendErrorKind, ErrorKind>> = {
	auth: "auth",
	permission: "permission",
	rate_limit: "rateLimit",
	not_found: "notFound",
	target_changed: "permanent",
	cursor_invalid: "transient",
	transient: "transient",
	permanent: "permanent",
	unverifiable: "permanent",
};

/**
 * Classify a module-thrown boundary error, or `null` when `err` is not a
 * {@link BackendErrorShape} (the caller then falls back to its existing
 * transport/HTTP classification).
 */
export function classifyBackendError(err: unknown): ErrorClassification | null {
	if (!isBackendErrorShape(err)) return null;
	const classification: ErrorClassification = { kind: KIND_MAP[err.kind] };
	if (err.retryAfterMs !== undefined) classification.retryAfterMs = err.retryAfterMs;
	if (err.permanentCode !== undefined) classification.permanentCode = err.permanentCode;
	return classification;
}
