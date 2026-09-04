/* eslint max-lines: ["error", 420] -- admission keeps proposal binding, authorization, and fresh rename classification inside its sole policy boundary. */
import { buildAdmissionComponents, type AdmissionComponent } from "./plan-admission-graph";
import { planSync } from "./decision-engine";
import {
	captureBatchObservation,
	immutableSnapshot,
	type BatchObservation,
} from "./sync-cycle-planning";
import {
	classifyNonBindingLocalRenames,
	normalizeLocalMove,
	type DeterminateNormalizedRenameState,
	type EvidenceContradictionReason,
	type EvidenceUnknownReason,
	type NormalizedRenameState,
} from "./local-rename-admission";
export type {
	DeterminateNormalizedRenameState,
	EvidenceContradictionReason,
	EvidenceUnknownReason,
	NormalizedRenameState,
} from "./local-rename-admission";
import { renameEvidenceKey, renameOptimizerView } from "./identity-evidence";
import {
	evaluateIdentityComponent,
	type AdmissionFailureReason as IdentityAdmissionFailureReason,
} from "./identity-component-decision";
import { coalesceLocalFolderRenames, optimizeLocalFileRenames } from "./optimize-local-renames";
import { coalesceRemoteFolderRenames, optimizeRemoteFileRenames } from "./optimize-remote-renames";
import { reconstructCaseAliasChildRenames } from "./case-alias-planning";
import type { FileEntity } from "../fs/types";
import type {
	IdentityEvidence,
	MixedEntity,
	PathObservation,
	RenameEvidence,
	ScopeProjection,
	SyncAction,
	SyncPlan,
} from "./types";

const authorizedSyncPlanBrand: unique symbol = Symbol("AuthorizedSyncPlan");

/** Admission's immutable decision snapshot: observed facts plus proposed actions. */
export interface AdmissionSnapshot extends BatchObservation {
	readonly plan: { readonly actions: readonly SyncAction[] };
}

/** Compatibility name for consumers of the immutable Admission snapshot. */
export type CycleEvidence = AdmissionSnapshot;

function bindAdmissionPlan(
	observation: BatchObservation,
	plan: SyncPlan,
): AdmissionSnapshot {
	return immutableSnapshot({
		...observation,
		plan: { actions: [...plan.actions] },
	});
}

/** Admission-owned test seam for evaluating an explicitly supplied proposal. */
export function captureCycleAdmissionSnapshot(
	plan: SyncPlan,
	identityEvidence: readonly IdentityEvidence[],
	observations: readonly PathObservation[],
	scope: ScopeProjection,
	namespace: string,
	baselinePaths: readonly string[] = plan.actions.flatMap((action) =>
		action.baseline ? [action.baseline.path] : []),
	entries: readonly MixedEntity[] = [],
): AdmissionSnapshot {
	const observation = captureBatchObservation(
		entries, identityEvidence, observations, scope, namespace,
		baselinePaths,
	);
	return bindAdmissionPlan(observation, plan);
}

/** The executor input that only Admission can construct. */
export interface AuthorizedSyncPlan {
	readonly actions: readonly SyncAction[];
	readonly [authorizedSyncPlanBrand]: CycleEvidence;
}

export type FreshRenameState =
	| "old_path_baseline"
	| "post_rename_old_content"
	| "converged"
	| "remote_changed"
	| "destination_conflict";

export type FreshRenameAction = SyncAction & {
	readonly freshRenameState: FreshRenameState;
	readonly oldPath: string;
	readonly remotePath?: string;
	/** Baseline identity source to rotate into the target after conflict resolution. */
	readonly remoteIdentitySource?: FileEntity;
	/** Foreign destination version preserved after the tracked primary version. */
	readonly additionalRemote?: FileEntity;
	readonly normalizedRenameState: DeterminateNormalizedRenameState;
};

export type CaseAliasCanonicalizationAction = SyncAction & {
	readonly action: "rename_remote";
	readonly protocol: "case_alias_canonicalization";
	readonly oldPath: string;
	readonly local: FileEntity;
	readonly remote: FileEntity;
};

export function isFreshRenameAction(action: SyncAction): action is FreshRenameAction {
	return "freshRenameState" in action;
}

export function isCaseAliasCanonicalizationAction(
	action: SyncAction,
): action is CaseAliasCanonicalizationAction {
	return "protocol" in action && action.protocol === "case_alias_canonicalization";
}

interface AdmissionComponentDisposition {
	paths: string[];
	actions: SyncAction[];
	evidence: IdentityEvidence[];
}

export interface AuthorizedComponent extends AdmissionComponentDisposition {
	kind: "authorized";
	/** Exact action object that a detached priority pull may replace in this cycle. */
	priorityPullAction?: SyncAction;
}

export interface ResolvedNoActionComponent extends AdmissionComponentDisposition {
	kind: "resolved_no_action";
}

export type AdmissionFailureReason =
	| IdentityAdmissionFailureReason
	| EvidenceUnknownReason
	| EvidenceContradictionReason;

export interface AdmissionFailureComponent extends AdmissionComponentDisposition {
	kind: "failed";
	reasons: AdmissionFailureReason[];
	normalizedRenameState?:
		| Extract<NormalizedRenameState, { kind: "evidence_unknown" }>
		| Extract<NormalizedRenameState, { kind: "evidence_contradicted" }>;
}

export type AdmissionDisposition =
	| AuthorizedComponent
	| ResolvedNoActionComponent
	| AdmissionFailureComponent;

export interface AdmissionResult {
	snapshot: AdmissionSnapshot;
	executable: AuthorizedSyncPlan;
	dispositions: AdmissionDisposition[];
	failures: AdmissionFailureComponent[];
	/** A baseline-backed local rename input remains non-binding this cycle. */
	unsettledLocalRenameInput: boolean;
}

/** Sole production entry: construct, validate, and authorize actions from observed facts. */
export function admitBatchObservation(observation: BatchObservation): AdmissionResult {
	const identityEvidence = observation.evidence.map((item) => item.evidence);
	const proposed = planSync([...observation.entries]);
	const actions = reconstructCaseAliasChildRenames(
		proposed.actions,
		[...observation.entries] as MixedEntity[],
		identityEvidence,
		[...observation.observations] as PathObservation[],
		observation.scope,
	);
	return admitDestructivePlan(bindAdmissionPlan(observation, { actions }));
}

/**
 * Pure final policy boundary before execution. It leaves ordinary exact-path
 * actions alone and fails closed only for the evidence-connected component
 * whose cross-path identity cannot be reconciled safely.
 */
export function admitDestructivePlan(
	snapshot: AdmissionSnapshot,
): AdmissionResult {
	const observedEvidence = snapshot.evidence.map((item) => item.evidence);
	const components = buildAdmissionComponents(
		snapshot.plan, observedEvidence, snapshot.observations, snapshot.scope,
		snapshot.entries,
	);
	const authorizedActions: SyncAction[] = [];
	const dispositions: AdmissionDisposition[] = [];
	for (const component of components) {
		const normalizedRenameState = normalizeLocalMove(component, snapshot.scope);
		if (normalizedRenameState) {
			const decision = decideLocalMove(normalizedRenameState);
			const action = decision.kind === "authorized" ? decision.action : undefined;
			const shared = {
				paths: [...component.paths].sort(), actions: action ? [action] : [],
				evidence: [...component.evidence].sort(compareEvidence),
				normalizedRenameState,
			};
			if (decision.kind === "authorized") {
				authorizedActions.push(decision.action);
				dispositions.push({ kind: "authorized", ...shared });
			} else if (decision.kind === "resolved_no_action") {
				dispositions.push({ kind: "resolved_no_action", ...shared });
			} else if (decision.kind === "evidence_unknown" &&
				normalizedRenameState.kind === "evidence_unknown") {
				dispositions.push({
					kind: "failed", ...shared, reasons: [decision.reason], normalizedRenameState,
				});
			} else if (decision.kind === "evidence_contradicted" &&
				normalizedRenameState.kind === "evidence_contradicted") {
				dispositions.push({
					kind: "failed", ...shared, reasons: [decision.reason], normalizedRenameState,
				});
			} else {
				throw new Error("Fresh rename decision/state invariant violated");
			}
			continue;
		}
		const nonBindingCandidates = classifyNonBindingLocalRenames(
			[component], snapshot.baselinePaths, snapshot.scope,
		);
		const effectiveEvidence = component.evidence.filter((item) =>
			item.kind !== "rename" || item.side !== "local" ||
			!nonBindingCandidates.has(renameEvidenceKey(item)));
		const decidedComponent: AdmissionComponent = {
			...component,
			actions: shapeIdentityComponentActions(component.actions, effectiveEvidence),
			evidence: effectiveEvidence,
		};
		const shared = {
			paths: [...component.paths].sort(),
			actions: [...decidedComponent.actions],
			evidence: [...component.evidence].sort(compareEvidence),
		};
		const reasons = evaluateIdentityComponent(decidedComponent, snapshot.scope);
		if (reasons.length > 0) {
			dispositions.push({
				kind: "failed",
				...shared,
				reasons,
			});
		} else if (decidedComponent.actions.length === 0) {
			dispositions.push({ kind: "resolved_no_action", ...shared });
		} else {
			authorizedActions.push(...decidedComponent.actions);
			dispositions.push({
				kind: "authorized",
				...shared,
				priorityPullAction: priorityPullAction(decidedComponent),
			});
		}
	}
	dispositions.sort((left, right) => left.paths.join("\0").localeCompare(right.paths.join("\0")));
	const executable = Object.freeze({
		actions: Object.freeze(authorizedActions),
		[authorizedSyncPlanBrand]: snapshot,
	});
	return {
		snapshot,
		executable,
		dispositions,
		failures: dispositions.filter((item): item is AdmissionFailureComponent => item.kind === "failed"),
		unsettledLocalRenameInput: snapshot.evidence.some(({ evidence }) =>
			evidence.kind === "rename" && evidence.side === "local" &&
			[...snapshot.baselinePaths].some((path) =>
				path === evidence.oldPath || path.startsWith(`${evidence.oldPath}/`)) &&
			!authorizedActions.some((action) => actionCoversRename(action, evidence))),
	};
}

function actionCoversRename(
	action: SyncAction,
	evidence: RenameEvidence,
): boolean {
	if (!("oldPath" in action)) return false;
	if (action.oldPath === evidence.oldPath && action.path === evidence.newPath) return true;
	if (!("isFolder" in action) || !action.isFolder) return false;
	const oldPrefix = `${action.oldPath}/`;
	const newPrefix = `${action.path}/`;
	return evidence.oldPath.startsWith(oldPrefix) &&
		evidence.newPath === `${newPrefix}${evidence.oldPath.slice(oldPrefix.length)}`;
}

type LocalMoveDecision =
	| { readonly kind: "authorized"; readonly action: FreshRenameAction | CaseAliasCanonicalizationAction }
	| { readonly kind: "resolved_no_action" }
	| { readonly kind: "evidence_unknown"; readonly reason: EvidenceUnknownReason }
	| { readonly kind: "evidence_contradicted"; readonly reason: EvidenceContradictionReason };

function decideLocalMove(state: NormalizedRenameState): LocalMoveDecision {
	if (state.kind === "evidence_unknown") {
		return { kind: state.kind, reason: state.reason };
	}
	if (state.kind === "evidence_contradicted") {
		return { kind: state.kind, reason: state.reason };
	}
	if (state.kind === "untracked_case_alias") {
		return {
			kind: "authorized",
			action: {
				action: "rename_remote", protocol: "case_alias_canonicalization",
				oldPath: state.candidate.oldPath, path: state.candidate.newPath,
				local: state.local, remote: state.remote,
			},
		};
	}
	return { kind: "authorized", action: freshRenameAction(state) };
}

function freshRenameAction(
	state: Exclude<DeterminateNormalizedRenameState, { kind: "untracked_case_alias" }>,
): FreshRenameAction {
	const shared = {
		path: state.candidate.newPath,
		oldPath: state.candidate.oldPath,
		local: state.local,
		baseline: state.baseline,
		normalizedRenameState: state,
	};
	switch (state.kind) {
		case "baseline_at_old_vacant_target":
			return state.relation === "unchanged"
				? {
					...shared, action: "rename_remote", freshRenameState: "old_path_baseline",
					remote: state.source.entity, remotePath: state.source.path,
				}
				: {
					...shared, action: "conflict", freshRenameState: "remote_changed",
					remote: state.source.entity, remotePath: state.source.path,
					remoteIdentitySource: state.source.entity,
				};
		case "baseline_at_new":
			if (state.localRelation === "same") {
				return {
					...shared, action: "match", freshRenameState: "converged",
					remote: state.target.entity, remotePath: state.target.path,
				};
			}
			return state.relation === "changed"
				? {
					...shared, action: "conflict", freshRenameState: "remote_changed",
					remote: state.target.entity, remotePath: state.target.path,
					remoteIdentitySource: state.target.entity,
				}
				: {
					...shared, action: "push", freshRenameState: "post_rename_old_content",
					remote: state.target.entity, remotePath: state.target.path,
				};
		case "baseline_at_third_vacant_target":
			return {
				...shared, action: "conflict", freshRenameState: "remote_changed",
				remote: state.source.entity, remotePath: state.source.path,
				remoteIdentitySource: state.source.entity,
			};
		case "baseline_at_third_foreign_target":
			return {
				...shared, action: "conflict", freshRenameState: "remote_changed",
				remote: state.primary.entity, remotePath: state.primary.path,
				remoteIdentitySource: state.primary.entity,
				additionalRemote: state.additional.entity,
			};
		case "baseline_absent_foreign_target":
			return {
				...shared, action: "conflict", freshRenameState: "destination_conflict",
				remote: state.additional.entity, remotePath: state.additional.path,
			};
		case "baseline_absent_vacant_target":
			return { ...shared, action: "conflict", freshRenameState: "remote_changed" };
	}
}

function priorityPullAction(component: AdmissionComponent): SyncAction | undefined {
	if (component.paths.size !== 1 || component.actions.length !== 1 ||
		component.evidence.length > 0) return undefined;
	const action = component.actions[0]!;
	if (action.action !== "pull" || action.path !== [...component.paths][0] ||
		!action.baseline || !action.local || action.local.isDirectory ||
		!action.remote || action.remote.isDirectory ||
		!action.baseline.remoteIdentityKey ||
		action.remote.identityKey !== action.baseline.remoteIdentityKey) return undefined;
	if (component.observations.some((observation) =>
		observation.kind !== "exact" || observation.requestedPath !== action.path ||
		observation.entity.isDirectory)) return undefined;
	return action;
}

function compareEvidence(left: IdentityEvidence, right: IdentityEvidence): number {
	return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function shapeIdentityComponentActions(
	baseActions: readonly SyncAction[],
	evidence: readonly IdentityEvidence[],
): SyncAction[] {
	const { localFiles, localFolders, remote } = renameOptimizerView(evidence);
	let actions = [...baseActions];
	if (localFolders.size > 0) {
		const folderResult = coalesceLocalFolderRenames(actions, localFolders, localFiles);
		actions = folderResult.actions;
		if (folderResult.remainingFileRenames.size > 0) {
			actions = optimizeLocalFileRenames(actions, folderResult.remainingFileRenames).actions;
		}
	} else if (localFiles.size > 0) {
		actions = optimizeLocalFileRenames(actions, localFiles).actions;
	}
	if (remote.length > 0) {
		const folderResult = coalesceRemoteFolderRenames(actions, remote);
		actions = folderResult.actions;
		if (folderResult.remainingPairs.length > 0) {
			actions = optimizeRemoteFileRenames(actions, folderResult.remainingPairs).actions;
		}
	}
	return actions;
}
