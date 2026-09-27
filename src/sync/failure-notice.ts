import type { ErrorClassification, ErrorKind } from "../backend-api/error-classification";
import { classifyHttpError } from "../backend-api/error-classification";
import type { FailureFact, FailureOperation } from "./failure-facts";
import { ERROR_KIND_SET, projectAbortFact, validHttpStatus } from "./failure-facts";

/**
 * The single user-facing wording and privacy rule for a sync failure clause.
 *
 * The formatter is pure (no I/O, no settings, no clock, no randomness). It emits only
 * members of the closed operation vocabulary, members of the closed `ErrorKind`
 * vocabulary, and a numeric HTTP status — nothing else. Any value that could carry a
 * provider message, a path, or credential material is dropped, never rendered or
 * sanitized into the clause. It never claims retryability or a generic next step; the
 * one exception is an authentication failure, which names the reconnect action.
 */

/** Rendered when no HTTP status exists or the classification is unrecognized. */
export const UNCLASSIFIED = "unclassified";

/** The recovery action named only for an authentication failure. */
export const AUTH_RECONNECT = "Please reconnect in settings.";

const OPERATION_LABEL: Record<FailureOperation, string> = {
	push: "Push",
	pull: "Pull",
	delete: "Delete",
	rename: "Rename",
	match: "Match",
	conflict: "Conflict",
	cleanup: "Cleanup",
	admission: "Admission",
	"cycle abort": "Cycle abort",
};

function operationLabel(operation: FailureOperation): string {
	return OPERATION_LABEL[operation] ?? "Sync";
}

/**
 * Render one bounded sentence-case failure clause, e.g. `Push failed (429, rateLimit)`.
 * The operation label and the classification are drawn only from their closed
 * vocabularies; an unrecognized classification becomes the explicit unclassified marker.
 *
 * An authentication failure is the one notice that names a recovery action: the cycle
 * cannot recover credentials by retrying, so the same clause is followed by
 * `Please reconnect in settings.`. Every other failure reports the fact only.
 */
export function formatFailureClause(fact: FailureFact): string {
	const status = validHttpStatus(fact.status);
	const label = operationLabel(fact.operation);
	// A category is named only when the provider supplied an HTTP status AND the
	// classification is a recognized member; otherwise the explicit unclassified marker
	// stands in rather than a guessed category.
	const clause = status !== null && typeof fact.classification === "string" && ERROR_KIND_SET.has(fact.classification)
		? `${label} failed (${status}, ${fact.classification})`
		: status !== null
			? `${label} failed (${status}, ${UNCLASSIFIED})`
			: `${label} failed (${UNCLASSIFIED})`;
	return fact.classification === "auth" ? `${clause}. ${AUTH_RECONNECT}` : clause;
}

/**
 * The abort notice for a cycle-level failure: classify the error (the backend's own
 * classifier when supplied, else the neutral one), project the abort fact, and render
 * the clause. The unhandled-error catch routes through this so the emitted string is
 * produced entirely by tested pure code. A classifier that throws falls back to the
 * total neutral classifier, so a buggy backend classifier cannot swallow the notice.
 */
export function formatSyncAbortNotice(
	error: unknown,
	classify?: (err: unknown) => ErrorClassification,
): string {
	let kind: ErrorKind;
	try {
		kind = (classify ?? classifyHttpError)(error).kind;
	} catch {
		kind = classifyHttpError(error).kind;
	}
	return formatFailureClause(projectAbortFact(error, kind));
}
