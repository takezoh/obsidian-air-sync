import { classifyHttpError } from "../errors";
import type { ErrorClassification } from "../errors";

const RATE_LIMIT_REASONS = new Set([
	"rateLimitExceeded",
	"userRateLimitExceeded",
	"dailyLimitExceeded",
]);

/**
 * Google Drive returns **403** for both genuine permission failures AND rate limits;
 * only a rate-limit carries one of {@link RATE_LIMIT_REASONS} in `error.errors[].reason`.
 * This is the one Drive-specific wrinkle the backend-neutral classifier can't know.
 */
function isDriveRateLimit(err: unknown): boolean {
	if (!err || typeof err !== "object" || !("json" in err)) return false;
	try {
		const json = (err as Record<string, unknown>).json;
		if (!json || typeof json !== "object") return false;
		const errors = (json as Record<string, unknown>).error;
		if (!errors || typeof errors !== "object") return false;
		const errList = (errors as Record<string, unknown>).errors;
		if (!Array.isArray(errList)) return false;
		return errList.some(
			(e: unknown) =>
				e &&
				typeof e === "object" &&
				"reason" in e &&
				typeof (e as { reason: unknown }).reason === "string" &&
				RATE_LIMIT_REASONS.has((e as { reason: string }).reason)
		);
	} catch {
		return false;
	}
}

/**
 * Classify a Google Drive error: the neutral HTTP classification, but a 403 that
 * is actually a rate-limit is re-tagged `rateLimit` (retry) instead of `permission`
 * (abort). Everything else defers to {@link classifyHttpError}.
 */
export function classifyDriveError(err: unknown): ErrorClassification {
	const base = classifyHttpError(err);
	if (base.kind === "permission" && isDriveRateLimit(err)) {
		return { kind: "rateLimit", retryAfterMs: base.retryAfterMs };
	}
	return base;
}
