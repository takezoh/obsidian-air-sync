import type {
	IdentityEvidence,
	LocalRenameEvidence,
	PathObservation,
	ScopeProjection,
	SyncAction,
	SyncPlan,
} from "./types";

export interface CycleAdmissionSnapshot {
	readonly plan: { readonly actions: readonly SyncAction[] };
	readonly identityEvidence: readonly IdentityEvidence[];
	/** Local tracker reports and replayed v6 rows are candidates, not pre-authorized constraints. */
	readonly localRenameCandidates: readonly LocalRenameEvidence[];
	readonly replayedLocalRenameKeys: ReadonlySet<string>;
	/** Immutable baseline membership used by Admission's positive additive proof. */
	readonly baselinePaths: ReadonlySet<string>;
	readonly observations: readonly PathObservation[];
	readonly scope: ScopeProjection;
	readonly namespace: string;
}

export function captureCycleAdmissionSnapshot(
	plan: SyncPlan,
	identityEvidence: readonly IdentityEvidence[],
	observations: readonly PathObservation[],
	scope: ScopeProjection,
	namespace: string,
	baselinePaths: readonly string[] = plan.actions.flatMap((action) =>
		action.baseline ? [action.baseline.path] : []),
	replayedLocalRenameKeys: readonly string[] = [],
): CycleAdmissionSnapshot {
	const capturedEvidence = Object.freeze([...identityEvidence]);
	return Object.freeze({
		plan: Object.freeze({ actions: Object.freeze([...plan.actions]) }),
		identityEvidence: capturedEvidence,
		localRenameCandidates: Object.freeze(capturedEvidence.filter((item): item is LocalRenameEvidence =>
			item.kind === "rename" && item.side === "local")),
		replayedLocalRenameKeys: new Set(replayedLocalRenameKeys),
		baselinePaths: new Set(baselinePaths),
		observations: Object.freeze([...observations]),
		scope: Object.freeze({ byEndpoint: new Map(scope.byEndpoint) }),
		namespace,
	});
}
