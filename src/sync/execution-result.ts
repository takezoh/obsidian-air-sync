import type { FileEntity } from "../fs/types";
import type { ConflictRecord, ConflictStrategy, SyncAction } from "./types";
import type { ConflictResolutionResult } from "./conflict-resolver";
import type { DeferredComponent } from "./plan-admission";
import type { AuthorizedSyncPlan } from "./plan-authority";

export interface NoActionFreshnessWitness {
	localGeneration: number;
	localFingerprint: string;
	recordFingerprint: string;
	identityKey: string | null;
	pathOccupant: { kind: "absent" } | { kind: "current"; identityKey: string; token: string };
	frozenDeltaWitness: string;
	componentId: string;
	memberObligationId: string;
	admissionEpoch: number;
}

export interface ComponentReceipt {
	componentId: string;
	admissionEpoch: number;
	memberObligationIds: string[];
	completions: Array<{
		memberObligationId: string;
		kind: "applied" | "no_action";
		freshness?: NoActionFreshnessWitness;
	}>;
}

export interface CompletedAction {
	/** Admission member whose exact completion authorizes cycle finalization. */
	action: SyncAction;
	componentId: string;
	memberObligationId: string;
	admissionEpoch: number;
	completionKind?: "applied" | "no_action";
	freshness?: NoActionFreshnessWitness;
	/** Current-state action actually selected at execution time, when it differs. */
	executedAction?: SyncAction;
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
	deferred: DeferredComponent[];
	componentReceipts: ComponentReceipt[];
}

export function copyExecutionResultForResume(result: ExecutionResult): ExecutionResult {
	return {
		succeeded: [...result.succeeded], failed: [...result.failed],
		blocked: [...result.blocked], conflicts: [...result.conflicts],
		deferred: [...result.deferred], componentReceipts: [],
	};
}

export function buildComponentReceipts(plan: AuthorizedSyncPlan, result: ExecutionResult): ComponentReceipt[] {
	return plan.components.flatMap((component) => {
		const completions = result.succeeded.filter((entry) =>
			entry.componentId === component.id && entry.admissionEpoch === component.admissionEpoch);
		if (completions.length !== component.memberObligations.length) return [];
		if (component.memberObligations.some((member) =>
			completions.filter((entry) => entry.memberObligationId === member.id).length !== 1)) return [];
		return [{
			componentId: component.id,
			admissionEpoch: component.admissionEpoch,
			memberObligationIds: component.memberObligations.map(({ id }) => id),
			completions: completions.map((entry) => ({
				memberObligationId: entry.memberObligationId,
				kind: entry.completionKind ?? "applied",
				freshness: entry.freshness,
			})),
		}];
	});
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
