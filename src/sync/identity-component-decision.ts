/* eslint max-lines: ["error", 600] -- the sole component decision deliberately keeps report arbitration, selected-family shaping, and final fail-closed predicates together; splitting those semantics would recreate multiple owners, while topology indexing is already isolated as a pure subordinate module. */
import { projectRenameScope, type RenameScopeConsequence } from "./scope-projection";
import type { AdmissionComponent } from "./plan-admission-graph";
import {
	classifyNonBindingLocalRenames,
	normalizeLocalMove,
	type DeterminateNormalizedRenameState,
	EvidenceContradictionReason,
	EvidenceUnknownReason,
	NormalizedRenameState,
} from "./local-rename-admission";
import { renameEvidenceKey, renameOptimizerView } from "./identity-evidence";
import {
	normalizeCaseAliasParentTransition,
	reconstructCaseAliasChildRenames,
} from "./plan-admission-case-alias";
import { coalesceLocalFolderRenames, optimizeLocalFileRenames } from "./optimize-local-renames";
import { coalesceRemoteFolderRenames, optimizeRemoteFileRenames } from "./optimize-remote-renames";
import {
	deriveTopologyCoverage,
	folderMappingComplete,
	hasAliasTargetMutation,
	hasUncoveredStableIdentity,
	type TopologyAuthority,
} from "./identity-component-topology";
import { selectReportFamily } from "./identity-component-report-family";
import type {
	CaseAliasCanonicalizationAction,
	FreshRenameAction,
} from "./plan-admission";
import type {
	IdentityEvidence,
	PathObservation,
	RenameEvidence,
	ScopeProjection,
	SyncAction,
} from "./types";

export type AdmissionFailureReason =
	| "alias_target_mutation"
	| "conflicting_identity"
	| "identity_postcondition_unproven"
	| "incomplete_folder_mapping"
	| "opposing_deletes"
	| "present_unresolved"
	| "rename_mismatch"
	| "unknown_observation"
	| "unknown_scope"
	| EvidenceUnknownReason
	| EvidenceContradictionReason;

export interface IdentityComponentDecision {
	readonly component: AdmissionComponent;
	readonly normalizedRenameState?: NormalizedRenameState;
	readonly reasons: readonly AdmissionFailureReason[];
}

/** Select, shape, and evaluate one identity component under one Admission owner. */
export function decideIdentityComponent(
	observed: AdmissionComponent,
	scope: ScopeProjection,
	baselinePaths: ReadonlySet<string>,
): IdentityComponentDecision {
	const nonBinding = classifyNonBindingLocalRenames([observed], baselinePaths, scope);
	const evidence = observed.evidence.filter((item) =>
		item.kind !== "rename" || item.side !== "local" ||
		!nonBinding.has(renameEvidenceKey(item)));
	const selection = selectReportFamily(
		evidence.filter((item): item is RenameEvidence => item.kind === "rename"),
	);
	if (selection.kind === "conflicting") {
		const evaluated = {
			...observed,
			evidence: evidence.filter((item) => item.kind !== "rename"),
		};
		const component = { ...observed, actions: [], evidence };
		return {
			component,
			reasons: evaluateIdentityComponent(
				evaluated, scope, [], { kind: "none" }, "rename_mismatch",
			),
		};
	}
	const reports = selection.kind === "reported" ? selection.reports : [];
	const governingReports = selection.kind === "reported" ? selection.governingReports : [];
	const selectedEvidence: IdentityEvidence[] = [
		...evidence.filter((item) => item.kind !== "rename"),
		...reports,
	];
	const materializationEvidence: IdentityEvidence[] = [
		...evidence.filter((item) => item.kind !== "rename"),
		...governingReports,
		...reports.filter((report) => !report.isFolder && !governingReports.includes(report)),
	];
	const hasLocalReport = reports.some((item) => item.side === "local");
	if (!hasLocalReport && reports.some((item) => item.side === "remote")) {
		const component = {
			...observed,
			actions: shapeIdentityComponentActions(observed.actions, materializationEvidence),
			evidence: selectedEvidence,
		};
		return {
			component,
			reasons: evaluateIdentityComponent(component, scope, [], {
				kind: "reported", reports: governingReports,
			}),
		};
	}

	const parentActions = reports.length === 0
		? normalizeCaseAliasParentTransition(observed, scope, (child) => {
			const state = normalizeLocalMove(child, scope);
			if (!state) return undefined;
			const decision = decideLocalMove(state);
			return decision.kind === "authorized" ? decision.action : undefined;
		})
		: undefined;
	const rawActions = hasLocalReport
		? reconstructCaseAliasChildRenames(
			observed.actions, observed.entries, selectedEvidence,
			observed.observations, scope,
		)
		: observed.actions;
	const candidate = {
		...observed,
		actions: parentActions ?? rawActions,
		evidence: selectedEvidence,
	};
	const normalizedRenameState = normalizeLocalMove(candidate, scope);
	let component: AdmissionComponent;
	let candidateReasons: AdmissionFailureReason[] = [];
	if (normalizedRenameState) {
		const decision = decideLocalMove(normalizedRenameState);
		if (decision.kind === "authorized") {
			component = { ...candidate, actions: [decision.action] };
		} else if (decision.kind === "resolved_no_action") {
			component = { ...candidate, actions: [] };
		} else if (decision.kind === normalizedRenameState.kind) {
			component = { ...candidate, actions: [] };
			candidateReasons = [decision.reason];
		} else {
			throw new Error("Fresh rename decision/state invariant violated");
		}
	} else {
		component = {
			...candidate,
			actions: shapeIdentityComponentActions(candidate.actions, materializationEvidence),
		};
	}
	return {
		component,
		...(normalizedRenameState ? { normalizedRenameState } : {}),
		reasons: evaluateIdentityComponent(
			component,
			scope,
			candidateReasons,
			reports.length > 0
				? { kind: "reported", reports: governingReports }
				: { kind: "current_fact", enabled: parentActions !== undefined || normalizedRenameState !== undefined },
		),
	};
}

function evaluateIdentityComponent(
	component: AdmissionComponent,
	scope: ScopeProjection,
	additionalReasons: readonly AdmissionFailureReason[] = [],
	authority: TopologyAuthority = { kind: "none" },
	selectionReason?: AdmissionFailureReason,
): AdmissionFailureReason[] {
	const reasons = new Set<AdmissionFailureReason>(additionalReasons);
	if (reasons.size > 0) return [...reasons].sort();
	const coverage = deriveTopologyCoverage(component, scope, authority);
	if (component.observations.some((item) => item.kind === "present_unresolved")) {
		reasons.add("present_unresolved");
	}
	if (component.observations.some((item) => item.kind === "unknown")) {
		reasons.add("unknown_observation");
	}
	if (hasConflictingIdentity(component)) reasons.add("conflicting_identity");
	if (hasOpposingDeletes(component.actions)) reasons.add("opposing_deletes");
	if (reasons.size === 0 && selectionReason) reasons.add(selectionReason);
	const renames = authority.kind === "reported"
		? [...authority.reports]
		: component.evidence.filter((item): item is RenameEvidence => item.kind === "rename");
	const resolvedNoAction = component.actions.length === 0 && renames.length > 0 &&
		renames.every((rename) => resolvedAtBothSides(rename, component.observations));
	if (renames.length > 0 && reasons.size === 0) {
		const renameReason = matchesNormalizedLocalMove(component, renames)
			? undefined : evaluateRenames(component, renames, scope, resolvedNoAction);
		if (renameReason) reasons.add(renameReason);
	}
	if (reasons.size === 0 && hasAliasTargetMutation(component, coverage)) {
		reasons.add("alias_target_mutation");
	}
	if (renames.length === 0 && reasons.size === 0 &&
			hasUncoveredStableIdentity(component, coverage)) {
		reasons.add("identity_postcondition_unproven");
	}
	if (reasons.size === 0 && hasUnprovenStandaloneDelete(component)) {
		reasons.add("unknown_observation");
	}
	if (component.actions.length === 0 && reasons.size === 0 && !resolvedNoAction) {
		reasons.add("identity_postcondition_unproven");
	}
	return [...reasons].sort();
}
function evaluateRenames(
	component: AdmissionComponent,
	renames: RenameEvidence[],
	scope: ScopeProjection,
	resolvedNoAction: boolean,
): AdmissionFailureReason | undefined {
	const rules = renames.map((rename) => ({ rename, rule: projectRenameScope(rename, scope) }));
	if (resolvedNoAction) return undefined;
	if (hasInvalidNativeFolderBinding(component, renames)) return "rename_mismatch";
	if (rules.some(({ rename, rule }) => rename.isFolder && rule.consequence === "defer")) {
		return "incomplete_folder_mapping";
	}
	if (rules.some(({ rule }) => rule.consequence === "defer")) return "unknown_scope";
	const consequences = rules.map(({ rename, rule }) => ({ rename, consequence: rule.consequence }));
	if (hasIncompleteNativeFolderMapping(component, consequences, scope)) {
		return "incomplete_folder_mapping";
	}
	if (matchesNativeRenames(component, consequences, scope)) return undefined;
	if (rules.length === 1 && preservesRecreatedRemoteSource(component, rules[0]!.rename)) {
		return undefined;
	}
	return "rename_mismatch";
}

function hasInvalidNativeFolderBinding(
	component: AdmissionComponent,
	renames: readonly RenameEvidence[],
): boolean {
	return renames.some((rename) => {
		if (!rename.isFolder) return false;
		const expected = rename.side === "local" ? "rename_remote" : "rename_local";
		return component.actions.filter((candidate) =>
			candidate.action === expected && candidate.oldPath === rename.oldPath &&
			candidate.path === rename.newPath && candidate.isFolder === true).length !== 1;
	});
}
function resolvedAtBothSides(
	rename: RenameEvidence,
	observations: readonly PathObservation[],
): boolean {
	return (["local", "remote"] as const).every((side) => {
		const oldObservation = observations.find((item) =>
			item.side === side && item.requestedPath === rename.oldPath);
		const newObservation = observations.find((item) =>
			item.side === side && item.requestedPath === rename.newPath);
		const oldResolved = oldObservation?.kind === "absent" ||
			(oldObservation?.kind === "alias" && oldObservation.resolvedPath === rename.newPath);
		const newResolved = newObservation?.kind === "exact" ||
			(newObservation?.kind === "alias" && newObservation.resolvedPath === rename.newPath);
		return oldResolved && newResolved;
	});
}

function hasUnprovenStandaloneDelete(component: AdmissionComponent): boolean {
	if (component.evidence.some((item) => item.kind === "rename")) return false;
	return component.actions.some((action) => {
		if (action.action !== "delete_local" && action.action !== "delete_remote") return false;
		const authoritySide = action.action === "delete_local" ? "remote" : "local";
		return !component.observations.some((observation) =>
			observation.kind === "absent" && observation.side === authoritySide &&
			observation.requestedPath === action.path &&
			(authoritySide === "remote"
				? observation.authority === "checkpoint_deleted"
				: observation.authority === "stat"));
	});
}

function matchesNativeRenames(
	component: AdmissionComponent,
	rules: readonly { rename: RenameEvidence; consequence: RenameScopeConsequence }[],
	scope: ScopeProjection,
): boolean {
	return rules.every(({ rename, consequence }) => {
		const expected = consequence === "rename_local" || consequence === "rename_remote"
			? consequence : undefined;
		if (!expected) return false;
		const exactActions = component.actions.filter((candidate) =>
			candidate.action === expected && candidate.oldPath === rename.oldPath &&
			candidate.path === rename.newPath);
		if (exactActions.length > 1) return false;
		const exactAction = exactActions[0];
		if (exactAction?.action === expected) {
			if (nativeDestinationOccupied(component, rename, expected)) return false;
			return !rename.isFolder || folderMappingComplete(
				exactAction, rename, scope, component.evidence,
			);
		}
		if (rename.isFolder) return false;
		return component.actions.some((candidate) =>
			candidate.action === expected && candidate.isFolder === true &&
			candidate.descendants?.some((pair) => pair.oldPath === rename.oldPath &&
				pair.newPath === rename.newPath));
	});
}

function hasIncompleteNativeFolderMapping(
	component: AdmissionComponent,
	rules: readonly { rename: RenameEvidence; consequence: RenameScopeConsequence }[],
	scope: ScopeProjection,
): boolean {
	return rules.some(({ rename, consequence }) => {
		if (!rename.isFolder || (consequence !== "rename_local" && consequence !== "rename_remote")) {
			return false;
		}
		const action = component.actions.find((candidate) =>
			candidate.action === consequence && candidate.oldPath === rename.oldPath &&
			candidate.path === rename.newPath);
		return action?.action === consequence &&
			!folderMappingComplete(action, rename, scope, component.evidence);
	});
}

function nativeDestinationOccupied(
	component: AdmissionComponent,
	rename: RenameEvidence,
	action: "rename_local" | "rename_remote",
): boolean {
	const targetSide = action === "rename_local" ? "local" : "remote";
	return component.observations.some((observation) => {
		if (observation.side !== targetSide) return false;
		if (observation.kind === "exact") return observation.requestedPath === rename.newPath;
		if (observation.kind === "alias") return observation.resolvedPath === rename.newPath;
		return observation.kind === "present_unresolved" && observation.returnedPath === rename.newPath;
	});
}

function preservesRecreatedRemoteSource(component: AdmissionComponent, rename: RenameEvidence): boolean {
	if (rename.side !== "remote" || !rename.identityKey || rename.isFolder) return false;
	const currentKeys = currentRemoteIdentityByPath(component);
	const sourceKey = currentKeys.get(rename.oldPath);
	if (!sourceKey || sourceKey === rename.identityKey || currentKeys.get(rename.newPath) !== rename.identityKey) {
		return false;
	}
	const byPath = new Map(component.actions.map((action) => [action.path, action]));
	if (byPath.size !== component.actions.length || byPath.size > 2 ||
		component.actions.some((action) => action.path !== rename.oldPath && action.path !== rename.newPath)) {
		return false;
	}
	const atDestination = byPath.get(rename.newPath);
	if (!atDestination || !["pull", "match"].includes(atDestination.action)) return false;
	const atSource = byPath.get(rename.oldPath);
	return !atSource || ["pull", "match", "delete_local"].includes(atSource.action);
}

function hasOpposingDeletes(actions: readonly SyncAction[]): boolean {
	return actions.some((action) => action.action === "delete_local") &&
		actions.some((action) => action.action === "delete_remote");
}

function matchesNormalizedLocalMove(
	component: AdmissionComponent,
	renames: readonly RenameEvidence[],
): boolean {
	if (component.actions.length !== 1) return false;
	const action = component.actions[0]!;
	if (!("normalizedRenameState" in action) || !("oldPath" in action) ||
		!renames.some((rename) => rename.side === "local" && !rename.isFolder &&
			rename.oldPath === action.oldPath && rename.newPath === action.path)) return false;
	const normalizedAction = action as FreshRenameAction;
	return renames.filter((rename) => rename.side === "remote").every((rename) => {
		const identitySource = normalizedAction.remoteIdentitySource;
		const observed = identitySource?.path === rename.newPath
			? identitySource
			: normalizedAction.remote?.path === rename.newPath ? normalizedAction.remote : undefined;
		return observed !== undefined &&
			(rename.identityKey === undefined || observed.identityKey === rename.identityKey);
	});
}

function hasConflictingIdentity(component: AdmissionComponent): boolean {
	const keys = new Map<string, Set<string>>();
	for (const evidence of component.evidence) {
		if (evidence.kind === "stable_identity") {
			for (const occurrence of evidence.occurrences) {
				addIdentity(keys, occurrence.side, occurrence.phase, occurrence.path, evidence.identityKey);
			}
		} else if (evidence.kind === "rename" && evidence.side === "remote" && evidence.identityKey) {
			addIdentity(keys, "remote", "baseline", evidence.oldPath, evidence.identityKey);
			addIdentity(keys, "remote", "current", evidence.newPath, evidence.identityKey);
		}
	}
	for (const observation of component.observations) {
		if (observation.side !== "remote" ||
			(observation.kind !== "exact" && observation.kind !== "alias")) continue;
		const path = observation.kind === "alias" ? observation.resolvedPath : observation.requestedPath;
		if (observation.entity.identityKey) {
			addIdentity(keys, "remote", "current", path, observation.entity.identityKey);
		}
	}
	for (const action of component.actions) {
		if (action.remote?.identityKey) {
			addIdentity(keys, "remote", "current", action.remote.path, action.remote.identityKey);
		}
		if (action.baseline?.remoteIdentityKey) {
			addIdentity(keys, "remote", "baseline", action.baseline.path, action.baseline.remoteIdentityKey);
		}
	}
	return [...keys.values()].some((values) => values.size > 1);
}

function addIdentity(
	keys: Map<string, Set<string>>,
	side: "local" | "remote",
	phase: "baseline" | "current",
	path: string,
	identityKey: string,
): void {
	const slot = `${side}\0${phase}\0${path}`;
	const values = keys.get(slot) ?? new Set<string>();
	values.add(identityKey);
	keys.set(slot, values);
}

function currentRemoteIdentityByPath(component: AdmissionComponent): Map<string, string> {
	const result = new Map<string, string>();
	for (const observation of component.observations) {
		if (observation.side !== "remote" ||
			(observation.kind !== "exact" && observation.kind !== "alias")) continue;
		const path = observation.kind === "alias" ? observation.resolvedPath : observation.requestedPath;
		if (observation.entity.identityKey) result.set(path, observation.entity.identityKey);
	}
	for (const action of component.actions) {
		if (action.remote?.identityKey) result.set(action.remote.path, action.remote.identityKey);
	}
	return result;
}

type LocalMoveDecision =
	| { readonly kind: "authorized"; readonly action: FreshRenameAction | CaseAliasCanonicalizationAction }
	| { readonly kind: "resolved_no_action" }
	| { readonly kind: "evidence_unknown"; readonly reason: EvidenceUnknownReason }
	| { readonly kind: "evidence_contradicted"; readonly reason: EvidenceContradictionReason };

function decideLocalMove(state: NormalizedRenameState): LocalMoveDecision {
	if (state.kind === "evidence_unknown") return { kind: state.kind, reason: state.reason };
	if (state.kind === "evidence_contradicted") return { kind: state.kind, reason: state.reason };
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
