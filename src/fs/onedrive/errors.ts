import { classifyHttpError } from "../errors";
import type { ErrorClassification } from "../errors";
import { GraphApiError } from "./types";

/**
 * Microsoft Graph statuses that mean "retry, this is not fatal":
 * - 423 Locked — the item is briefly locked (e.g. a concurrent edit).
 * - 503 Service Unavailable / 509 Bandwidth Limit Exceeded — transient throttling.
 */
const TRANSIENT_STATUSES = new Set([423, 503, 509]);

/**
 * Classify a OneDrive (Microsoft Graph) error into a backend-neutral kind.
 *
 * The neutral HTTP classifier already handles 401 (auth), 404 (notFound), and 429
 * (rateLimit, honouring Retry-After). On top of that, Graph uses a few statuses
 * the neutral classifier would misread:
 * - 423/503/509 → `transient` (retry with backoff) rather than the default.
 * - 507 Insufficient Storage → `permission` (abort; the user's drive is full and
 *   retrying won't help until they free space).
 */
export function classifyOneDriveError(err: unknown): ErrorClassification {
	const status = err instanceof GraphApiError ? err.status : undefined;
	if (status === 507) return { kind: "permission" };
	if (status !== undefined && TRANSIENT_STATUSES.has(status)) return { kind: "transient" };
	return classifyHttpError(err);
}
