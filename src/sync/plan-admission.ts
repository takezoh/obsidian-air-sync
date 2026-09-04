/* eslint max-lines: ["error", 450] -- admission keeps proposal binding, authorization, fresh rename classification, and case-alias component normalization inside its sole policy boundary. */
import { buildAdmissionComponents, type AdmissionComponent } from "./plan-admission-graph";
import { planSync } from "./decision-engine";
import {
	captureBatchObservation,
	immutableSnapshot,
	type BatchObservation,
} from "./sync-cycle-planning";
import {
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
import {
	decideIdentityComponent,
	type AdmissionFailureReason as IdentityAdmissionFailureReason,
} from "./identity-component-decision";
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
	normalizedRenameState?: NormalizedRenameState;
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
	const proposed = planSync([...observation.entries]);
	return admitDestructivePlan(bindAdmissionPlan(observation, proposed));
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
	for (const observedComponent of components) {
		const decision = decideIdentityComponent(
			observedComponent, snapshot.scope, snapshot.baselinePaths,
		);
		const decidedComponent = decision.component;
		const shared = {
			paths: [...observedComponent.paths].sort(),
			actions: [...decidedComponent.actions],
			evidence: [...observedComponent.evidence].sort(compareEvidence),
			...(decision.normalizedRenameState
				? { normalizedRenameState: decision.normalizedRenameState }
				: {}),
		};
		const reasons = [...decision.reasons];
		if (reasons.length > 0) {
			const failure: AdmissionFailureComponent = {
				kind: "failed",
				...shared,
				reasons,
			};
			dispositions.push(failure);
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
