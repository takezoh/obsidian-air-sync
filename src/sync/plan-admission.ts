import { buildAdmissionComponents, type AdmissionComponent } from "./plan-admission-graph";
import type { CycleAdmissionSnapshot } from "./cycle-admission-snapshot";
export { captureCycleAdmissionSnapshot, type CycleAdmissionSnapshot } from "./cycle-admission-snapshot";
import {
	buildLocalRenameLifecycle,
	classifyNonBindingLocalRenames,
	type LocalRenameLifecycle,
} from "./local-rename-admission";
import { renameEvidenceKey, renameOptimizerView } from "./identity-evidence";
import {
	evaluateIdentityComponent,
	type AdmissionDeferralReason,
} from "./identity-component-decision";
import { coalesceLocalFolderRenames, optimizeLocalFileRenames } from "./optimize-local-renames";
import { coalesceRemoteFolderRenames, optimizeRemoteFileRenames } from "./optimize-remote-renames";
import { hasRemoteChanged } from "./change-compare";
import { sameContent } from "./content-identity";
import type { FileEntity } from "../fs/types";
import type {
	IdentityEvidence,
	LocalRenameEvidence,
	SyncRecord,
	SyncAction,
} from "./types";

const authorizedSyncPlanBrand: unique symbol = Symbol("AuthorizedSyncPlan");

/** The executor input that only Admission can construct. */
export interface AuthorizedSyncPlan {
	readonly actions: readonly SyncAction[];
	readonly [authorizedSyncPlanBrand]: CycleAdmissionSnapshot;
}

export type FreshRenameState =
	| "old_path_baseline"
	| "post_rename_old_content"
	| "converged"
	| "remote_changed"
	| "destination_conflict"
	| "unknown";

export type FreshRenameAction = SyncAction & {
	readonly freshRenameState: Exclude<FreshRenameState, "unknown">;
	readonly oldPath: string;
	readonly remotePath?: string;
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

export interface DeferredComponent extends AdmissionComponentDisposition {
	kind: "deferred";
	reasons: AdmissionDeferralReason[];
}

export type AdmissionDisposition =
	| AuthorizedComponent
	| ResolvedNoActionComponent
	| DeferredComponent;

export interface AdmissionResult {
	snapshot: CycleAdmissionSnapshot;
	executable: AuthorizedSyncPlan;
	dispositions: AdmissionDisposition[];
	deferred: DeferredComponent[];
	localRenameLifecycle: LocalRenameLifecycle;
}

/**
 * Pure final policy boundary before execution. It leaves ordinary exact-path
 * actions alone and fails closed only for the evidence-connected component
 * whose cross-path identity cannot be reconciled safely.
 */
export function admitDestructivePlan(
	snapshot: CycleAdmissionSnapshot,
): AdmissionResult {
	const components = buildAdmissionComponents(
		snapshot.plan, snapshot.identityEvidence, snapshot.observations, snapshot.scope,
	);
	const authorizedActions: SyncAction[] = [];
	const dispositions: AdmissionDisposition[] = [];
	const persistBeforeExecution: LocalRenameEvidence[] = [];
	const releaseAfterSafeCheckpoint: LocalRenameEvidence[] = [];
	for (const component of components) {
		const freshRename = classifyFreshLocalRename(component, snapshot.scope);
		if (freshRename) {
			const action = buildFreshRenameAction(freshRename);
			const localCandidates = component.evidence.filter((item): item is LocalRenameEvidence =>
				item.kind === "rename" && item.side === "local");
			const shared = {
				paths: [...component.paths].sort(), actions: action ? [action] : [],
				evidence: [...component.evidence].sort(compareEvidence),
			};
			if (!action) {
				persistBeforeExecution.push(...localCandidates.filter((candidate) =>
					!snapshot.replayedLocalRenameKeys.has(renameEvidenceKey(candidate))));
				dispositions.push({ kind: "deferred", ...shared, reasons: ["unknown_observation"] });
			} else {
					authorizedActions.push(action);
				persistBeforeExecution.push(...localCandidates.filter((candidate) =>
					!snapshot.replayedLocalRenameKeys.has(renameEvidenceKey(candidate))));
				releaseAfterSafeCheckpoint.push(...localCandidates);
				dispositions.push({ kind: "authorized", ...shared });
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
				kind: "deferred",
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
		deferred: dispositions.filter((item): item is DeferredComponent => item.kind === "deferred"),
		localRenameLifecycle,
	};
}

interface FreshRenameClassification {
	state: FreshRenameState;
	candidate: LocalRenameEvidence;
	baseline: SyncRecord;
	local?: FileEntity;
	remote?: FileEntity;
	remotePath?: string;
}

function classifyFreshLocalRename(
	component: AdmissionComponent,
	scope: CycleAdmissionSnapshot["scope"],
): FreshRenameClassification | undefined {
	const candidates = component.evidence.filter((item): item is LocalRenameEvidence =>
		item.kind === "rename" && item.side === "local" && !item.isFolder);
	if (candidates.length !== 1) return undefined;
	const candidate = candidates[0]!;
	const baseline = component.actions.find((action) => action.baseline?.path === candidate.oldPath)?.baseline;
	if (!baseline) return undefined;
	const localOld = observation(component, "local", candidate.oldPath);
	const localNew = observation(component, "local", candidate.newPath);
	// Admission snapshots produced by the current orchestrator contain all four
	// endpoint observations. Keep older direct callers on the legacy path when
	// no fresh destination observation was captured at all.
	if (!localNew) return undefined;
	const local = localNew.kind === "exact"
		? actionEntity(component, "local", candidate.newPath) ?? localNew.entity
		: undefined;
	if (!baseline.hash || !local?.hash) {
		return unknown(candidate, baseline, local);
	}
	if (local.hash === baseline.hash) return undefined;
	if (localOld?.kind !== "absent" || scope.byEndpoint.get(candidate.oldPath) !== "included" ||
		scope.byEndpoint.get(candidate.newPath) !== "included" || !baseline.remoteIdentityKey) {
		return unknown(candidate, baseline, local);
	}
	const remoteOld = observation(component, "remote", candidate.oldPath);
	const remoteNew = observation(component, "remote", candidate.newPath);
	if (!isExactOrAbsent(remoteOld) || !isExactOrAbsent(remoteNew)) {
		return unknown(candidate, baseline, local);
	}
	const oldEntity = remoteOld.kind === "exact"
		? actionEntity(component, "remote", candidate.oldPath) ?? remoteOld.entity : undefined;
	const newEntity = remoteNew.kind === "exact"
		? actionEntity(component, "remote", candidate.newPath) ?? remoteNew.entity : undefined;
	const baselineId = baseline.remoteIdentityKey;
	const oldIsBaseline = oldEntity?.identityKey === baselineId && !hasRemoteChanged(oldEntity, baseline);
	const newIsBaseline = newEntity?.identityKey === baselineId;
	if (oldEntity?.identityKey === baselineId && newIsBaseline) {
		return unknown(candidate, baseline, local);
	}
	if (oldIsBaseline && !newEntity) {
		return { state: "old_path_baseline", candidate, baseline, local, remote: oldEntity, remotePath: candidate.oldPath };
	}
	if (!oldEntity && newIsBaseline && newEntity) {
		if (sameContent(local, newEntity)) {
			return { state: "converged", candidate, baseline, local, remote: newEntity, remotePath: candidate.newPath };
		}
		return {
			state: hasRemoteChanged(newEntity, baseline) ? "remote_changed" : "post_rename_old_content",
			candidate, baseline, local, remote: newEntity, remotePath: candidate.newPath,
		};
	}
	if ((oldEntity?.identityKey === baselineId && hasRemoteChanged(oldEntity, baseline)) ||
		(newIsBaseline && newEntity)) {
		return { state: "remote_changed", candidate, baseline, local, remote: newEntity ?? oldEntity, remotePath: newEntity ? candidate.newPath : candidate.oldPath };
	}
	if (newEntity?.identityKey && newEntity.identityKey !== baselineId && oldIsBaseline) {
		return { state: "destination_conflict", candidate, baseline, local, remote: newEntity, remotePath: candidate.newPath };
	}
	return unknown(candidate, baseline, local);
}

function observation(component: AdmissionComponent, side: "local" | "remote", path: string) {
	return component.observations.find((item) => item.side === side && item.requestedPath === path);
}

function actionEntity(component: AdmissionComponent, side: "local" | "remote", path: string) {
	return component.actions.map((action) => action[side]).find((entity) => entity?.path === path);
}

function isExactOrAbsent(value: ReturnType<typeof observation>): value is Exclude<NonNullable<typeof value>,
	{ kind: "alias" | "present_unresolved" | "unknown" }> {
	return value?.kind === "exact" || value?.kind === "absent";
}

function unknown(candidate: LocalRenameEvidence, baseline: SyncRecord, local?: FileEntity): FreshRenameClassification {
	return { state: "unknown", candidate, baseline, local };
}

function buildFreshRenameAction(classification: FreshRenameClassification): FreshRenameAction | undefined {
	const { state, candidate, baseline, local, remote, remotePath } = classification;
	if (state === "unknown" || !local) return undefined;
	const shared = { path: candidate.newPath, oldPath: candidate.oldPath, local, remote, baseline, freshRenameState: state, remotePath };
	if (state === "old_path_baseline") return { ...shared, action: "rename_remote" };
	if (state === "post_rename_old_content") return { ...shared, action: "push" };
	if (state === "converged") return { ...shared, action: "match" };
	return { ...shared, action: "conflict" };
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
