import type { FileEntity } from "../fs/types";
import type { ErrorKind } from "../backend-api/error-classification";
import type { ConflictAction, ConflictRecord, RenameAction, SyncAction, SyncRecord } from "./types";
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
	/**
	 * The neutral classification the applied retry policy used for this failure, carried
	 * from the site that classified it (so a provider re-tag such as a Google Drive
	 * 403-rate-limit is preserved). Absent when the failure was recorded without an
	 * applied classification; the notice projection then falls back to the neutral HTTP
	 * classifier. This is an observational field only — it never feeds retry/abort policy.
	 */
	classification?: ErrorKind;
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
	action: ConflictAction;
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
	sessionId: string,
	resolvedAt: string,
): ConflictRecord[] {
	return conflicts.map((c) => ({
		path: c.action.path,
		actionType: c.action.action,
		strategy: c.action.conflictPolicy.strategy,
		action: c.resolution.action,
		local: c.localEntity,
		remote: c.remoteEntity,
		duplicatePath: c.resolution.duplicatePath,
		duplicatePaths: c.resolution.duplicatePaths,
		hasConflictMarkers: c.resolution.hasConflictMarkers,
		resolvedAt,
		sessionId,
	}));
}
