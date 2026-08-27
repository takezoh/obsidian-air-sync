import type { IFileSystem } from "../fs/interface";
import type { ExecutionResult } from "./execution-result";
import {
	renameDebtsBoundToEvidence,
	unreleasedIdentityEvidence,
} from "./rename-debt";
import type { AdmissionResult } from "./plan-admission";
import type { RenameDebt, SyncStateStore } from "./state";
import type { IdentityEvidence } from "./types";

interface SyncCycleFinalizationInput {
	admission: AdmissionResult;
	result: ExecutionResult;
	pendingEvidence: readonly IdentityEvidence[];
	persistedDebts: readonly RenameDebt[];
	localRenameDebts: readonly RenameDebt[];
	checkpoint: IFileSystem["checkpoint"];
	scopeFingerprint: string;
	stateStore: SyncStateStore;
}

/**
 * Owns the commit-last boundary: remote evidence may be forgotten and durable
 * local debt retired only when the corresponding cursor is safe to advance.
 */
export async function finalizeSyncCycle(input: SyncCycleFinalizationInput): Promise<IdentityEvidence[]> {
	const authorized = input.admission.dispositions.filter((disposition) =>
		disposition.kind === "authorized");
	const knownComponents = new Map(authorized.map((component) => [component.componentId, component]));
	const completionCounts = new Map<string, number>();
	let unknownCompletion = false;
	for (const completion of input.result.succeeded) {
		const component = knownComponents.get(completion.componentId);
		if (!component || completion.admissionEpoch !== component.admissionEpoch ||
			!component.memberObligationIds.includes(completion.memberObligationId)) {
			unknownCompletion = true;
			continue;
		}
		const key = `${completion.componentId}\0${completion.admissionEpoch}\0${completion.memberObligationId}`;
		completionCounts.set(key, (completionCounts.get(key) ?? 0) + 1);
	}
	const componentComplete = (component: (typeof authorized)[number]): boolean =>
		component.memberObligationIds.every((memberId) =>
			completionCounts.get(`${component.componentId}\0${component.admissionEpoch}\0${memberId}`) === 1) &&
		input.result.succeeded.filter(({ componentId }) => componentId === component.componentId).length ===
			component.memberObligationIds.length;
	const releasable = input.admission.dispositions.flatMap((disposition) => {
		if (disposition.kind === "deferred") return [];
		if (disposition.kind === "authorized" && !componentComplete(disposition)) return [];
		return disposition.evidence;
	});
	const checkpointSafe = input.result.failed.length === 0 && input.result.blocked.length === 0 &&
		!unknownCompletion &&
		input.admission.dispositions.every((disposition) =>
			disposition.kind !== "deferred" &&
			(disposition.kind !== "authorized" || componentComplete(disposition)));
	if (!checkpointSafe) return [...input.pendingEvidence];

	await input.checkpoint?.commitCheckpoint({ scopeFingerprint: input.scopeFingerprint });
	const resolvedDebts = renameDebtsBoundToEvidence(
		[...input.persistedDebts, ...input.localRenameDebts],
		releasable,
		input.admission.snapshot.namespace,
	);
	await input.stateStore.deleteRenameDebts(resolvedDebts);
	return unreleasedIdentityEvidence(input.pendingEvidence, releasable);
}
