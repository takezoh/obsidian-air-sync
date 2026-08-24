import type { IFileSystem } from "../fs/interface";
import type { ExecutionResult } from "./execution-result";
import {
	resolvedRenameDebts,
	unresolvedRenameEvidence,
} from "./rename-debt";
import type { RenameDebt, SyncStateStore } from "./state";
import type { IdentityEvidence, PathObservation, ScopeProjection } from "./types";

interface SyncCycleFinalizationInput {
	result: ExecutionResult;
	pendingEvidence: readonly IdentityEvidence[];
	persistedDebts: readonly RenameDebt[];
	localRenameDebts: readonly RenameDebt[];
	scopeProjection: ScopeProjection;
	observations: readonly PathObservation[];
	checkpoint: IFileSystem["checkpoint"];
	scopeFingerprint: string;
	stateStore: SyncStateStore;
}

/**
 * Owns the commit-last boundary: remote evidence may be forgotten and durable
 * local debt retired only when the corresponding cursor is safe to advance.
 */
export async function finalizeSyncCycle(input: SyncCycleFinalizationInput): Promise<IdentityEvidence[]> {
	const unresolved = unresolvedRenameEvidence(
		input.pendingEvidence, input.result, input.scopeProjection, input.observations,
	);
	const clean = input.result.failed.length === 0 && input.result.deferred.length === 0;
	// Remote edges are session-local, so holding the cursor is their restart replay.
	const checkpointSafe = clean && !unresolved.some((item) =>
		item.kind === "rename" && item.side === "remote");
	if (!checkpointSafe) return [...input.pendingEvidence];

	await input.checkpoint?.commitCheckpoint({ scopeFingerprint: input.scopeFingerprint });
	const resolvedDebts = resolvedRenameDebts(
		[...input.persistedDebts, ...input.localRenameDebts],
		input.result,
		input.scopeProjection,
		input.observations,
	);
	await input.stateStore.deleteRenameDebts(resolvedDebts);
	return unresolved;
}
