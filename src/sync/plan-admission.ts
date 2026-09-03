/* eslint max-lines: ["error", 420] -- admission keeps proposal binding, authorization, and fresh rename classification inside its sole policy boundary. */
import { buildAdmissionComponents, type AdmissionComponent } from "./plan-admission-graph";
import { planSync } from "./decision-engine";
import {
	captureBatchObservation,
	immutableSnapshot,
	type BatchObservation,
} from "./sync-cycle-planning";
import {
	buildLocalRenameLifecycle,
	classifyNonBindingLocalRenames,
	normalizeFreshLocalRename,
	type DeterminateNormalizedRenameState,
	type EvidenceContradictionReason,
	type EvidenceUnknownReason,
	type LocalRenameLifecycle,
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
import { reconstructCaseAliasChildRenames } from "./case-alias-recovery";
import type { FileEntity } from "../fs/types";
import type {
	IdentityEvidence,
	LocalRenameEvidence,
	MixedEntity,
	PathObservation,
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
	replayedLocalRenameKeys: readonly string[] = [],
): AdmissionSnapshot {
	const observation = captureBatchObservation(
		[], identityEvidence, observations, scope, namespace,
		baselinePaths, replayedLocalRenameKeys,
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

export function isFreshRenameAction(action: SyncAction): action is FreshRenameAction {
	return "freshRenameState" in action;
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
	localRenameLifecycle: LocalRenameLifecycle;
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
	);
	const authorizedActions: SyncAction[] = [];
	const dispositions: AdmissionDisposition[] = [];
	const persistBeforeExecution: LocalRenameEvidence[] = [];
	const releaseAfterSafeCheckpoint: LocalRenameEvidence[] = [];
	for (const component of components) {
		const normalizedRenameState = normalizeFreshLocalRename(component, snapshot.scope);
		if (normalizedRenameState) {
			const decision = decideFreshRename(normalizedRenameState);
			const action = decision.kind === "authorized" ? decision.action : undefined;
			const localCandidates = [normalizedRenameState.candidate];
			const shared = {
				paths: [...component.paths].sort(), actions: action ? [action] : [],
				evidence: [...component.evidence].sort(compareEvidence),
				normalizedRenameState,
			};
			if (decision.persist) {
				persistBeforeExecution.push(...localCandidates.filter((candidate) =>
					!snapshot.replayedLocalRenameKeys.has(renameEvidenceKey(candidate))));
			}
			if (decision.release) releaseAfterSafeCheckpoint.push(...localCandidates);
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
		const localCandidates = component.evidence.filter((item): item is LocalRenameEvidence =>
			item.kind === "rename" && item.side === "local");
		if (reasons.length > 0) {
			persistBeforeExecution.push(...localCandidates);
			dispositions.push({
				kind: "failed",
				...shared,
				reasons,
			});
		} else if (decidedComponent.actions.length === 0) {
			releaseAfterSafeCheckpoint.push(...localCandidates.filter((candidate) =>
				snapshot.replayedLocalRenameKeys.has(renameEvidenceKey(candidate))));
			dispositions.push({ kind: "resolved_no_action", ...shared });
		} else {
			authorizedActions.push(...decidedComponent.actions);
			const bindingCandidates = localCandidates.filter((candidate) =>
				!nonBindingCandidates.has(renameEvidenceKey(candidate)));
			persistBeforeExecution.push(...bindingCandidates);
			releaseAfterSafeCheckpoint.push(...bindingCandidates);
			releaseAfterSafeCheckpoint.push(...localCandidates.filter((candidate) =>
				nonBindingCandidates.has(renameEvidenceKey(candidate)) &&
				snapshot.replayedLocalRenameKeys.has(renameEvidenceKey(candidate))));
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
	const localRenameLifecycle = buildLocalRenameLifecycle(
		persistBeforeExecution, releaseAfterSafeCheckpoint,
	);
	return {
		snapshot,
		executable,
		dispositions,
		failures: dispositions.filter((item): item is AdmissionFailureComponent => item.kind === "failed"),
		localRenameLifecycle,
	};
}

type FreshRenameDecision =
	| { readonly kind: "authorized"; readonly action: FreshRenameAction; readonly persist: true; readonly release: true }
	| { readonly kind: "resolved_no_action"; readonly persist: false; readonly release: true }
	| { readonly kind: "evidence_unknown"; readonly reason: EvidenceUnknownReason; readonly persist: true; readonly release: false }
	| { readonly kind: "evidence_contradicted"; readonly reason: EvidenceContradictionReason; readonly persist: true; readonly release: false };

function decideFreshRename(state: NormalizedRenameState): FreshRenameDecision {
	if (state.kind === "evidence_unknown") {
		return { kind: state.kind, reason: state.reason, persist: true, release: false };
	}
	if (state.kind === "evidence_contradicted") {
		return { kind: state.kind, reason: state.reason, persist: true, release: false };
	}
	return { kind: "authorized", action: freshRenameAction(state), persist: true, release: true };
}

function freshRenameAction(state: DeterminateNormalizedRenameState): FreshRenameAction {
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
