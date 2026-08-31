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
import type {
	IdentityEvidence,
	LocalRenameEvidence,
	SyncAction,
} from "./types";

const authorizedSyncPlanBrand: unique symbol = Symbol("AuthorizedSyncPlan");

/** The executor input that only Admission can construct. */
export interface AuthorizedSyncPlan {
	readonly actions: readonly SyncAction[];
	readonly [authorizedSyncPlanBrand]: CycleAdmissionSnapshot;
}

interface AdmissionComponentDisposition {
	paths: string[];
	actions: SyncAction[];
	evidence: IdentityEvidence[];
}

export interface AuthorizedComponent extends AdmissionComponentDisposition {
	kind: "authorized";
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
			dispositions.push({ kind: "authorized", ...shared });
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
