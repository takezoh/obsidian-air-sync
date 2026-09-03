import type { IFileSystem } from "../fs/interface";
import type { ExecutionResult } from "./execution-result";
import { isFreshRenameAction, type AdmissionResult } from "./plan-admission";
import type { SyncAction } from "./types";

interface SyncCycleFinalizationInput {
	admission: AdmissionResult;
	result: ExecutionResult;
	checkpoint: IFileSystem["checkpoint"];
	scopeFingerprint: string;
	/** Detached evidence/CAS contradicted the frozen cycle even without an action member. */
	checkpointBlocked?: boolean;
}

/**
 * Owns the commit-last boundary. Incomplete cycles persist no operation intent;
 * their next run re-observes current state against the last committed checkpoint.
 */
export async function finalizeSyncCycle(input: SyncCycleFinalizationInput): Promise<void> {
	const succeeded = new Map(input.result.succeeded.map((item) => [item.action, item]));
	const superseded = new Set(input.result.superseded);
	const terminal = (disposition: AdmissionResult["dispositions"][number], action: SyncAction) =>
		(succeeded.has(action) && (!isFreshRenameAction(action) ||
			succeeded.get(action)?.terminalFreshProof?.action === action)) ||
		(disposition.kind === "authorized" &&
			disposition.priorityPullAction === action && superseded.has(action));
	const checkpointSafe = !input.checkpointBlocked && input.result.failed.length === 0 &&
		input.result.blocked.length === 0 &&
		input.admission.dispositions.every((disposition) =>
			disposition.kind !== "failed" &&
			(disposition.kind !== "authorized" ||
				disposition.actions.every((action) => terminal(disposition, action))));
	if (!checkpointSafe) return;

	await input.checkpoint?.commitCheckpoint({ scopeFingerprint: input.scopeFingerprint });
}
