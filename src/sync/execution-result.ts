import type { FileEntity } from "../fs/types";
import type { ConflictRecord, ConflictStrategy, SyncAction } from "./types";
import type { ConflictResolutionResult } from "./conflict-resolver";
import type { DeferredComponent, FreshEvidenceIssue } from "./plan-admission";
import type { TerminalFreshProof } from "./plan-executor";

export interface CompletedAction {
	action: SyncAction;
	localEntity?: FileEntity;
	remoteEntity?: FileEntity;
	terminalFreshProof?: TerminalFreshProof;
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
	terminalFreshProof?: TerminalFreshProof;
}

export interface ExecutionResult {
	succeeded: CompletedAction[];
	/** Admission-marked exact actions completed by a priority operation. */
	superseded: SyncAction[];
	failed: FailedAction[];
	blocked: BlockedAction[];
	conflicts: ResolvedConflict[];
	/** Invocation-local unknowns surfaced as retryable errors; never durable replay state. */
	deferred: DeferredComponent[];
	/** Fresh evidence states with zero action; observable but never retry authority. */
	evidenceIssues: FreshEvidenceIssue[];
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
