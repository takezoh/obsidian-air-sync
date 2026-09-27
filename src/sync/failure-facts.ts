import type { ErrorKind } from "../backend-api/error-classification";
import { classifyHttpError, getErrorInfo } from "../backend-api/error-classification";
import type { BlockedAction, FailedAction } from "./execution-result";
import type { AdmissionFailureComponent } from "./plan-admission";
import type { SyncActionType } from "./types";

/**
 * What a sync cycle reports about its failures to the user.
 *
 * One owner projects the cycle's in-memory failures into a bounded, ordered list of
 * failure facts — an operation label, the HTTP status when the provider supplied one,
 * and the neutral `ErrorKind` the applied retry policy used — and reduces them to one
 * representative failure plus the total error count. It reads no log file, holds no
 * durable state, and never carries a path, file name, provider code, or raw provider
 * message. The notice formatter (`failure-notice.ts`) is the only consumer.
 */

/** The closed operation vocabulary a failure clause may name. */
export type FailureOperation =
	| "push" | "pull" | "delete" | "rename" | "match" | "conflict" | "cleanup"
	| "admission" | "cycle abort";

export interface FailureFact {
	operation: FailureOperation;
	/** Finite HTTP status when the provider supplied one, else null. */
	status: number | null;
	/** The applied neutral classification, or null when none was recognized. */
	classification: ErrorKind | null;
}

export interface FailureProjection {
	/** The most severe failure of the cycle (ties keep first-observed), or null. */
	representative: FailureFact | null;
	/** The total number of cycle errors, matching the counts summary. */
	totalErrors: number;
}

/** The subset of a completed cycle the projection reads. */
export interface FailureSourceOutcome {
	execution: { failed: readonly FailedAction[]; blocked: readonly BlockedAction[] };
	admissionFailures: readonly AdmissionFailureComponent[];
}

/**
 * Severity order used to pick the representative: an aborting-category failure is the
 * most useful thing to name, a generic transient the least. A null classification ranks
 * below every named kind so a named cause always wins when both are present.
 */
const SEVERITY: Record<ErrorKind, number> = {
	auth: 0, permission: 1, rateLimit: 2, notFound: 3, permanent: 4, transient: 5,
};
const UNCLASSIFIED_RANK = 6;

/**
 * The closed neutral vocabulary, derived from {@link SEVERITY}'s keys so the two cannot
 * drift: adding an `ErrorKind` union member fails the `Record<ErrorKind, number>` type
 * and updates this set together. Consumed by the notice formatter's privacy rule.
 */
export const ERROR_KIND_SET: ReadonlySet<string> = new Set(Object.keys(SEVERITY));

/** Total over the sync action vocabulary, so a new {@link SyncActionType} is a compile
 * error here rather than a silent fallback at runtime. */
const OPERATION_BY_ACTION: Record<SyncActionType, FailureOperation> = {
	push: "push",
	pull: "pull",
	delete_local: "delete",
	delete_remote: "delete",
	rename_local: "rename",
	rename_remote: "rename",
	match: "match",
	conflict: "conflict",
	cleanup: "cleanup",
};

function operationOf(action: SyncActionType): FailureOperation {
	return OPERATION_BY_ACTION[action];
}

/** The finite HTTP status of a thrown value, or null. One reader shared by the projection
 * and the formatter so a malformed value never becomes a rendered number. */
export function validHttpStatus(status: unknown): number | null {
	return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
		? status
		: null;
}

function statusOf(error: unknown): number | null {
	try {
		return validHttpStatus(getErrorInfo(error).status);
	} catch {
		return null;
	}
}

/**
 * A carried classification is authoritative (it is what the retry policy applied). When
 * none was carried the neutral classifier supplies it; no second taxonomy is introduced.
 */
function classificationOf(failed: FailedAction): ErrorKind {
	if (failed.classification !== undefined) return failed.classification;
	return classifyHttpError(failed.error).kind;
}

function rank(fact: FailureFact): number {
	return fact.classification === null ? UNCLASSIFIED_RANK : SEVERITY[fact.classification];
}

export function projectFailureFacts(outcome: FailureSourceOutcome): FailureProjection {
	const facts: FailureFact[] = [];
	for (const failed of outcome.execution.failed) {
		facts.push({
			operation: operationOf(failed.action.action),
			status: statusOf(failed.error),
			classification: classificationOf(failed),
		});
	}
	// Admission failures are actionless: they name the phase and the unclassified marker
	// rather than guessing a cause that was never proven.
	for (let index = 0; index < outcome.admissionFailures.length; index++) {
		facts.push({ operation: "admission", status: null, classification: null });
	}
	let representative: FailureFact | null = null;
	for (const fact of facts) {
		if (representative === null || rank(fact) < rank(representative)) representative = fact;
	}
	return { representative, totalErrors: facts.length };
}

/** The failure fact for a cycle-level abort, from the classification the orchestrator
 * already applied to the aborting error. */
export function projectAbortFact(error: unknown, classification: ErrorKind): FailureFact {
	return { operation: "cycle abort", status: statusOf(error), classification };
}

/** The failure fact for an abort whose error carries no applied classification. */
export function projectUnclassifiedAbortFact(error: unknown): FailureFact {
	return { operation: "cycle abort", status: statusOf(error), classification: null };
}
