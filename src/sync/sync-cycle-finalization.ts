import type { IFileSystem } from "../fs/interface";
import type { ExecutionResult } from "./execution-result";
import type { AdmissionResult } from "./plan-admission";
import type { SyncAction } from "./types";

interface SyncCycleFinalizationInput {
	admission: AdmissionResult;
	result: ExecutionResult;
	checkpoint: IFileSystem["checkpoint"];
	scopeFingerprint: string;
	checkpointBlocked?: boolean;
}

export type SyncCycleCompletion = { readonly kind: "clean" } | { readonly kind: "incomplete" };

/** Abort failure escapes classification/retry without attempting another abort. */
export class WorkingViewAbortError extends Error {
	constructor(readonly original: unknown) {
		super(original instanceof Error ? original.message : String(original));
		this.name = "WorkingViewAbortError";
	}
}

async function abortWorkingView(checkpoint: IFileSystem["checkpoint"]): Promise<void> {
	try {
		await checkpoint?.abortWorkingView();
	} catch (err) {
		throw new WorkingViewAbortError(err);
	}
}

function isComplete(input: Omit<SyncCycleFinalizationInput, "checkpoint">): boolean {
	const succeeded = new Map(input.result.succeeded.map((item) => [item.action, item]));
	const superseded = new Map(input.result.superseded.map((item) => [item.action, item.terminalRecord]));
	const terminal = (disposition: AdmissionResult["dispositions"][number], action: SyncAction) => {
		const replacement = superseded.get(action);
		const needsProof =
			(action.publication?.source !== undefined && action.publication.source.path !== action.path) ||
			((action.action === "rename_local" || action.action === "rename_remote") &&
				(action.content !== undefined || action.descendantRecords !== undefined));
		return (succeeded.has(action) && (!needsProof ||
			succeeded.get(action)?.terminalProof?.action === action)) ||
			(disposition.kind === "authorized" && disposition.priorityPullAction === action &&
				replacement?.path === action.path && !!replacement.remoteIdentityKey &&
				replacement.remoteIdentityKey === action.remote?.identityKey);
	};
	return !input.checkpointBlocked && input.result.failed.length === 0 && input.result.blocked.length === 0 &&
		input.admission.dispositions.every((disposition) => disposition.kind !== "failed" &&
			(disposition.kind !== "authorized" || disposition.actions.every((action) => terminal(disposition, action))));
}

/**
 * One attempt boundary, from observation through checkpoint publication. The
 * existing scheduler drains siblings before closeout. Abort is outside the
 * operation catch: an abort failure cannot recursively trigger another abort.
 */
export async function runSyncCycleAttempt<T>(
	checkpoint: IFileSystem["checkpoint"],
	work: () => Promise<T>,
	settle: <R>(close: () => Promise<R>) => Promise<R>,
	finalization: (value: T) => Omit<SyncCycleFinalizationInput, "checkpoint">,
): Promise<{ value: T; completion: SyncCycleCompletion }> {
	const attempt = await Promise.resolve().then(work).then(
		(value) => ({ kind: "returned" as const, value }),
		(error: unknown) => ({ kind: "threw" as const, error }),
	);
	return settle(async () => {
		// Catch all operation failures in one place, but never catch abort itself.
		const closeout = await (async () => {
			try {
				if (attempt.kind === "threw") throw attempt.error;
				const input = finalization(attempt.value);
				const clean = isComplete(input);
				if (clean) await checkpoint?.commitCheckpoint({ scopeFingerprint: input.scopeFingerprint });
				return { kind: "returned" as const, value: attempt.value, clean };
			} catch (error) {
				return { kind: "threw" as const, error };
			}
		})();
		if (closeout.kind === "threw") {
			await abortWorkingView(checkpoint);
			throw closeout.error;
		}
		if (!closeout.clean) await abortWorkingView(checkpoint);
		return { value: closeout.value, completion: { kind: closeout.clean ? "clean" : "incomplete" } };
	});
}

/** Standalone finalization uses exactly the same closeout contract as a full attempt. */
export async function finalizeSyncCycle(input: SyncCycleFinalizationInput): Promise<SyncCycleCompletion> {
	const closed = await runSyncCycleAttempt(input.checkpoint, () => Promise.resolve(input),
		(close) => close(), (value) => value);
	return closed.completion;
}
