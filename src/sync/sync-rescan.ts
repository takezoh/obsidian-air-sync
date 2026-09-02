import type { IncrementalCheckpoint } from "../fs/interface";
import type { Logger } from "../logging/logger";
import { withoutClearedLocalRenameEvidence } from "./rename-debt";
import type { SyncStateStore } from "./state";
import type { IdentityEvidence } from "./types";

interface ResetRescanStateInput {
	checkpoint: IncrementalCheckpoint | undefined;
	namespace: string;
	pendingEvidence: readonly IdentityEvidence[];
	stateStore: SyncStateStore;
	logger?: Logger;
}

/** Reset recoverable scan state without discarding baselines or remote evidence. */
export async function resetRescanState(input: ResetRescanStateInput): Promise<IdentityEvidence[]> {
	const clearedDebts = await input.stateStore.getRenameDebts(input.namespace);
	await input.checkpoint?.resetCheckpoint();
	await input.stateStore.clearRenameDebts(input.namespace);
	input.logger?.info("Rescan recovery state reset", {
		clearedLocalRenameDebts: clearedDebts.length,
	});
	return withoutClearedLocalRenameEvidence(input.pendingEvidence, clearedDebts);
}
