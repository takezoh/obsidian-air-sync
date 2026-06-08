import type { ErrorClassification } from "../fs/errors";

/**
 * What the retry loop should do with a classified error. Pure data so the policy
 * can be unit-tested in isolation (with an injected rng for the jitter).
 *
 * - `abort` — give up now and surface a user-facing message (`auth` / `permission`).
 * - `stop`  — stop retrying without a backoff (e.g. 404: the target is gone).
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
 */
export function decideRetry(
	classification: ErrorClassification,
	attempt: number,
	maxRetries: number,
	rng: () => number,
): RetryDecision {
	if (classification.kind === "auth") return { action: "abort", kind: "auth" };
	if (classification.kind === "permission") return { action: "abort", kind: "permission" };
	if (classification.kind === "notFound") return { action: "stop" };
	if (attempt >= maxRetries) return { action: "exhausted" };

	const delayMs = classification.retryAfterMs != null
		? classification.retryAfterMs
		: Math.pow(2, attempt - 1) * 1000 * (0.5 + rng());
	return { action: "retry", delayMs };
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
