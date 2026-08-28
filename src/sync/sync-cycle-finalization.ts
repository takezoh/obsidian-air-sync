import type { IFileSystem } from "../fs/interface";
import type { ExecutionResult, NoActionFreshnessWitness } from "./execution-result";
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
	validateNoActionFreshness?: (witness: NoActionFreshnessWitness) => Promise<boolean>;
}

/**
 * Owns the commit-last boundary: remote evidence may be forgotten and durable
 * local debt retired only when the corresponding cursor is safe to advance.
 */
export async function finalizeSyncCycle(input: SyncCycleFinalizationInput): Promise<IdentityEvidence[]> {
	const authorized = input.admission.dispositions.filter((disposition) =>
		disposition.kind === "authorized");
	const knownComponents = new Map(authorized.map((component) => [component.componentId, component]));
	let invalidCompletion = false;
	const completionCounts = new Map<string, number>();
	for (const completion of input.result.succeeded) {
		const component = knownComponents.get(completion.componentId);
		if (!component || completion.admissionEpoch !== component.admissionEpoch ||
			!component.memberObligationIds.includes(completion.memberObligationId)) {
			invalidCompletion = true;
			continue;
		}
		const key = `${completion.componentId}\0${completion.admissionEpoch}\0${completion.memberObligationId}`;
		completionCounts.set(key, (completionCounts.get(key) ?? 0) + 1);
	}
	const receiptCounts = new Map<string, number>();
	for (const receipt of input.result.componentReceipts) {
		const component = knownComponents.get(receipt.componentId);
		if (!component || receipt.admissionEpoch !== component.admissionEpoch ||
			receipt.memberObligationIds.length !== component.memberObligationIds.length ||
			receipt.memberObligationIds.some((id, index) => id !== component.memberObligationIds[index]) ||
			receipt.completions.length !== component.memberObligationIds.length) {
			invalidCompletion = true;
			continue;
		}
		const seen = new Set<string>();
		for (const completion of receipt.completions) {
			if (!component.memberObligationIds.includes(completion.memberObligationId) ||
				seen.has(completion.memberObligationId)) {
				invalidCompletion = true;
				continue;
			}
			seen.add(completion.memberObligationId);
			const applied = input.result.succeeded.find((entry) =>
				entry.componentId === component.componentId &&
				entry.admissionEpoch === component.admissionEpoch &&
				entry.memberObligationId === completion.memberObligationId);
			if (!applied || (applied.completionKind ?? "applied") !== completion.kind ||
				(completion.kind === "no_action" && applied.freshness !== completion.freshness)) {
				invalidCompletion = true;
			}
			if (completion.kind === "no_action") {
				const witness = completion.freshness;
				if (!witness || witness.componentId !== component.componentId ||
					witness.memberObligationId !== completion.memberObligationId ||
					witness.admissionEpoch !== component.admissionEpoch ||
					witness.frozenDeltaWitness !== input.admission.snapshot.frozenDeltaWitness ||
					!Number.isSafeInteger(witness.localGeneration) || !witness.localFingerprint ||
					!witness.recordFingerprint ||
					(witness.pathOccupant.kind === "current" &&
						(!witness.pathOccupant.token || witness.identityKey !== witness.pathOccupant.identityKey))) {
					invalidCompletion = true;
				}
			}
		}
		receiptCounts.set(receipt.componentId, (receiptCounts.get(receipt.componentId) ?? 0) + 1);
	}
	if (input.validateNoActionFreshness) {
		for (const receipt of input.result.componentReceipts) {
			for (const completion of receipt.completions) {
				if (completion.kind === "no_action" && completion.freshness &&
					!(await input.validateNoActionFreshness(completion.freshness))) {
					invalidCompletion = true;
				}
			}
		}
	}
	const componentComplete = (component: (typeof authorized)[number]): boolean =>
		component.memberObligationIds.every((memberId) =>
			completionCounts.get(`${component.componentId}\0${component.admissionEpoch}\0${memberId}`) === 1) &&
			input.result.succeeded.filter(({ componentId }) => componentId === component.componentId).length ===
				component.memberObligationIds.length && receiptCounts.get(component.componentId) === 1;
	const releasable = input.admission.dispositions.flatMap((disposition) => {
		if (disposition.kind === "deferred") return [];
		if (disposition.kind === "authorized" && !componentComplete(disposition)) return [];
		return disposition.evidence;
	});
	const checkpointSafe = input.result.failed.length === 0 && input.result.blocked.length === 0 &&
			!invalidCompletion && input.result.componentReceipts.length === authorized.length &&
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
