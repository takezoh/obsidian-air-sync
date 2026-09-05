import type { FileEntity } from "../fs/types";
import type { ConflictRecord, ConflictStrategy, RenameAction, SyncAction, SyncRecord } from "./types";
import type { ConflictResolutionResult } from "./conflict-resolver";
import type { TerminalActionProof } from "./plan-executor";

export interface CompletedAction {
	action: SyncAction;
	localEntity?: FileEntity;
	remoteEntity?: FileEntity;
	terminalProof?: TerminalActionProof;
	/** Exact successful publication consumed by a following parent action. */
	terminalRecord?: SyncRecord;
}

export interface FailedAction {
	action: SyncAction;
	error: Error;
}

/** Successful priority publication replacing this exact admitted pull. */
export interface SupersededAction {
	readonly action: SyncAction;
	readonly terminalRecord: SyncRecord;
}

export interface BlockedAction {
	action: SyncAction;
	reason: string;
}

export interface ResolvedConflict {
	action: SyncAction;
	resolution: ConflictResolutionResult;
	localEntity?: FileEntity;
	remoteEntity?: FileEntity;
	terminalProof?: TerminalActionProof;
}

export interface ExecutionResult {
	succeeded: CompletedAction[];
	/** Admission-marked exact actions completed by a priority operation. */
	superseded: SupersededAction[];
	failed: FailedAction[];
	blocked: BlockedAction[];
	conflicts: ResolvedConflict[];
}

/** Join an admitted ordered child prefix to the existing success collection.
 * The iterator is call-local; no receipt cache or mutable baseline view exists. */
export function* orderedChildReceipts(action: RenameAction, completed: readonly CompletedAction[]) {
	let cursor = 0;
	for (const child of action.descendantRecords ?? []) {
		let receipt: CompletedAction | undefined;
		if (child.after) {
			while (cursor < completed.length) {
				const candidate = completed[cursor++]!;
				if (candidate.action === child.after) {
					receipt = candidate;
					break;
				}
			}
		}
		yield { child, receipt };
	}
}

export function toConflictRecords(
	conflicts: ResolvedConflict[],
	strategy: ConflictStrategy,
	sessionId: string,
	resolvedAt: string,
): ConflictRecord[] {
	return conflicts.map((c) => ({
		path: c.action.path,
		actionType: c.action.action,
		strategy,
		action: c.resolution.action,
		local: c.localEntity,
		remote: c.remoteEntity,
		duplicatePath: c.resolution.duplicatePath,
		hasConflictMarkers: c.resolution.hasConflictMarkers,
		resolvedAt,
		sessionId,
	}));
}
