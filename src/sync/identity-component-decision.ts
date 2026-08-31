import { projectRenameScope, type RenameScopeConsequence } from "./scope-projection";
import type { AdmissionComponent } from "./plan-admission-graph";
import type {
	IdentityEvidence,
	PathObservation,
	RenameEvidence,
	ScopeProjection,
	SyncAction,
} from "./types";

export type AdmissionDeferralReason =
	| "alias_target_mutation"
	| "conflicting_identity"
	| "identity_postcondition_unproven"
	| "incomplete_folder_mapping"
	| "opposing_deletes"
	| "present_unresolved"
	| "rename_mismatch"
	| "unknown_observation"
	| "unknown_scope";

export function evaluateIdentityComponent(
	component: AdmissionComponent,
	scope: ScopeProjection,
): AdmissionDeferralReason[] {
	const reasons = new Set<AdmissionDeferralReason>();
	if (component.observations.some((item) => item.kind === "present_unresolved")) {
		reasons.add("present_unresolved");
	}
	if (component.observations.some((item) => item.kind === "unknown")) {
		reasons.add("unknown_observation");
	}
	if (hasConflictingIdentity(component)) reasons.add("conflicting_identity");
	if (hasOpposingDeletes(component.actions)) reasons.add("opposing_deletes");
	if (hasAliasTargetMutation(component)) reasons.add("alias_target_mutation");

	const renames = component.evidence.filter((item): item is RenameEvidence => item.kind === "rename");
	const resolvedNoAction = component.actions.length === 0 && renames.length > 0 &&
		renames.every((rename) => projectRenameScope(rename, scope).consequence === "none" ||
			resolvedAtBothSides(rename, component.observations));
	if (renames.length > 0 && reasons.size === 0) {
		const renameReason = evaluateRenames(component, renames, scope, resolvedNoAction);
		if (renameReason) reasons.add(renameReason);
	} else if (renames.length === 0 && reasons.size === 0 &&
			component.evidence.some((item) => item.kind === "stable_identity" &&
				new Set(item.occurrences.map((occurrence) => occurrence.path)).size > 1)) {
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
): AdmissionDeferralReason | undefined {
	const rules = renames.map((rename) => ({ rename, rule: projectRenameScope(rename, scope) }));
	if (rules.some(({ rename, rule }) => rename.isFolder && rule.consequence === "defer")) {
		return "incomplete_folder_mapping";
	}
	if (rules.some(({ rule }) => rule.consequence === "defer")) return "unknown_scope";
	const consequences = rules.map(({ rename, rule }) => ({ rename, consequence: rule.consequence }));
	if (hasIncompleteNativeFolderMapping(component, consequences, scope)) {
		return "incomplete_folder_mapping";
	}
	if (resolvedNoAction) return undefined;
	if (matchesNativeRenames(component, consequences, scope)) return undefined;
	if (rules.length === 1 && matchesScopeTransition(
		component, rules[0]!.rename, rules[0]!.rule.consequence,
	)) return undefined;
	if (rules.length === 1 && preservesRecreatedRemoteSource(component, rules[0]!.rename)) {
		return undefined;
	}
	return "rename_mismatch";
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
	if (component.actions.length !== rules.length) return false;
	return rules.every(({ rename, consequence }) => {
		const expected = consequence === "rename_local" || consequence === "rename_remote"
			? consequence : undefined;
		if (!expected) return false;
		const action = component.actions.find((candidate) =>
			candidate.action === expected && candidate.oldPath === rename.oldPath &&
			candidate.path === rename.newPath);
		if (!action || action.action !== expected || nativeDestinationOccupied(component, rename, expected)) {
			return false;
		}
		return !rename.isFolder || folderMappingComplete(action, rename, scope);
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
		return action?.action === consequence && !folderMappingComplete(action, rename, scope);
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

function matchesScopeTransition(
	component: AdmissionComponent,
	rename: RenameEvidence,
	consequence: RenameScopeConsequence,
): boolean {
	const actions = component.actions;
	if (consequence === "none") return actions.length === 0;
	if (consequence === "defer" || consequence === "rename_local" || consequence === "rename_remote") {
		return false;
	}
	if (actions.length !== 1) return false;
	const expectedPath = consequence === "delete_local" || consequence === "delete_remote"
		? rename.oldPath : rename.newPath;
	if (actions[0]!.action !== consequence || actions[0]!.path !== expectedPath) return false;
	if (consequence === "push") return !isOccupied(component, "remote", rename.newPath);
	if (consequence === "pull") return !isOccupied(component, "local", rename.newPath);
	return true;
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

function folderMappingComplete(
	action: Extract<SyncAction, { action: "rename_local" | "rename_remote" }>,
	rename: RenameEvidence,
	scope: ScopeProjection,
): boolean {
	if (!action.isFolder || !action.descendants || action.descendants.length === 0) return false;
	const mapped = new Set<string>();
	const oldPrefix = `${rename.oldPath}/`;
	const newPrefix = `${rename.newPath}/`;
	for (const pair of action.descendants) {
		if (!pair.oldPath.startsWith(oldPrefix) || !pair.newPath.startsWith(newPrefix) ||
			pair.oldPath.substring(oldPrefix.length) !== pair.newPath.substring(newPrefix.length) ||
			scope.byEndpoint.get(pair.oldPath) !== "included" ||
			scope.byEndpoint.get(pair.newPath) !== "included" ||
			mapped.has(pair.oldPath) || mapped.has(pair.newPath)) return false;
		mapped.add(pair.oldPath);
		mapped.add(pair.newPath);
	}
	for (const path of scope.byEndpoint.keys()) {
		if ((path.startsWith(oldPrefix) || path.startsWith(newPrefix)) && !mapped.has(path)) return false;
	}
	return true;
}

function hasOpposingDeletes(actions: readonly SyncAction[]): boolean {
	return actions.some((action) => action.action === "delete_local") &&
		actions.some((action) => action.action === "delete_remote");
}

function hasAliasTargetMutation(component: AdmissionComponent): boolean {
	return component.evidence.some((evidence) => evidence.kind === "alias" &&
		component.actions.some((action) => !isMatchingAliasRename(component, action, evidence)));
}

function isMatchingAliasRename(
	component: AdmissionComponent,
	action: SyncAction,
	alias: Extract<IdentityEvidence, { kind: "alias" }>,
): boolean {
	if (action.action !== "rename_local" && action.action !== "rename_remote") return false;
	if (!((alias.requestedPath === action.oldPath && alias.resolvedPath === action.path) ||
		(alias.requestedPath === action.path && alias.resolvedPath === action.oldPath))) return false;
	return component.evidence.some((evidence) => evidence.kind === "rename" &&
		evidence.oldPath === action.oldPath && evidence.newPath === action.path &&
		action.action === (evidence.side === "local" ? "rename_remote" : "rename_local"));
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

function isOccupied(component: AdmissionComponent, side: "local" | "remote", path: string): boolean {
	return component.observations.some((observation) => observation.side === side &&
		((observation.kind === "exact" && observation.requestedPath === path) ||
			(observation.kind === "alias" && observation.resolvedPath === path) ||
			(observation.kind === "present_unresolved" && observation.returnedPath === path)));
}
