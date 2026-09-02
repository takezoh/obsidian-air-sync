import type { IFileSystem } from "../fs/interface";
import type { ExecutionResult } from "./execution-result";
import {
	renameDebtsBoundToEvidence,
	unreleasedIdentityEvidence,
} from "./rename-debt";
import type { AdmissionResult } from "./plan-admission";
import type { RenameDebt, SyncStateStore } from "./state";
import type { IdentityEvidence, SyncAction } from "./types";

interface SyncCycleFinalizationInput {
	admission: AdmissionResult;
	result: ExecutionResult;
	carriedEvidence: readonly IdentityEvidence[];
	persistedDebts: readonly RenameDebt[];
	localRenameDebts: readonly RenameDebt[];
	checkpoint: IFileSystem["checkpoint"];
	scopeFingerprint: string;
	stateStore: SyncStateStore;
	/** Detached evidence/CAS contradicted the frozen cycle even without an action member. */
	checkpointBlocked?: boolean;
}

/**
 * Owns the commit-last boundary: invocation-local evidence may be forgotten and an
 * exact legacy candidate row retired only when the corresponding cursor is safe.
 */
export async function finalizeSyncCycle(input: SyncCycleFinalizationInput): Promise<IdentityEvidence[]> {
	const succeeded = new Set(input.result.succeeded.map(({ action }) => action));
	const superseded = new Set(input.result.superseded);
	const terminal = (disposition: AdmissionResult["dispositions"][number], action: SyncAction) =>
		succeeded.has(action) || (disposition.kind === "authorized" &&
			disposition.priorityPullAction === action && superseded.has(action));
	const dispositionEvidence = input.admission.dispositions.flatMap((disposition) => {
		if (disposition.kind === "deferred" || disposition.kind === "evidence_unknown" ||
			disposition.kind === "evidence_contradicted") return [];
		if (disposition.kind === "authorized" &&
			!disposition.actions.every((action) => terminal(disposition, action))) return [];
		return disposition.evidence;
	});
	const releasable = [
		...dispositionEvidence,
		...input.admission.localRenameLifecycle.releaseAfterSafeCheckpoint,
	];
	const checkpointSafe = !input.checkpointBlocked && input.result.failed.length === 0 &&
		input.result.blocked.length === 0 && input.result.evidenceIssues.length === 0 &&
		input.admission.dispositions.every((disposition) =>
			disposition.kind !== "deferred" && disposition.kind !== "evidence_unknown" &&
			disposition.kind !== "evidence_contradicted" &&
			(disposition.kind !== "authorized" ||
				disposition.actions.every((action) => terminal(disposition, action))));
	if (!checkpointSafe) return [...input.carriedEvidence];

	await input.checkpoint?.commitCheckpoint({ scopeFingerprint: input.scopeFingerprint });
	const resolvedDebts = renameDebtsBoundToEvidence(
		[...input.persistedDebts, ...input.localRenameDebts],
		input.admission.localRenameLifecycle.releaseAfterSafeCheckpoint,
		input.admission.snapshot.namespace,
	);
	await input.stateStore.deleteRenameDebts(resolvedDebts);
	return unreleasedIdentityEvidence(input.carriedEvidence, releasable);
}
