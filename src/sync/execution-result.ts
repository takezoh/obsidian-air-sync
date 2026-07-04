import type { FileEntity } from "../fs/types";
import type { ConflictRecord, ConflictStrategy, SyncAction } from "./types";
import type { ConflictResolutionResult } from "./conflict-resolver";

export interface CompletedAction {
	action: SyncAction;
	localEntity?: FileEntity;
	remoteEntity?: FileEntity;
}

export interface FailedAction {
	action: SyncAction;
	error: Error;
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
}

export interface ExecutionResult {
	succeeded: CompletedAction[];
	failed: FailedAction[];
	blocked: BlockedAction[];
	conflicts: ResolvedConflict[];
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
