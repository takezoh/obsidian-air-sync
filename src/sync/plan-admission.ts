import type { RefinedSyncPlan } from "./rename-optimizer";
import { projectRenameScope, type RenameScopeConsequence } from "./scope-projection";
import { buildAdmissionComponents, type AdmissionComponent } from "./plan-admission-graph";
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

export interface DeferredComponent {
	paths: string[];
	actions: SyncAction[];
	evidence: IdentityEvidence[];
	reasons: AdmissionDeferralReason[];
}

export interface AdmissionResult {
	executable: { actions: SyncAction[] };
	deferred: DeferredComponent[];
}

/**
 * Pure final policy boundary before execution. It leaves ordinary exact-path
 * actions alone and fails closed only for the evidence-connected component
 * whose cross-path identity cannot be reconciled safely.
 */
export function admitDestructivePlan(
	plan: RefinedSyncPlan,
	observations: readonly PathObservation[],
	scope: ScopeProjection,
): AdmissionResult {
	const components = buildAdmissionComponents(plan, observations, scope);
	const deferredActions = new Set<SyncAction>();
	const deferred: DeferredComponent[] = [];
	for (const component of components) {
		const reasons = evaluateComponent(component, scope);
		if (reasons.length === 0) continue;
		for (const action of component.actions) deferredActions.add(action);
		deferred.push({
			paths: [...component.paths].sort(),
			actions: [...component.actions],
			evidence: [...component.evidence].sort(compareEvidence),
			reasons,
		});
	}
	deferred.sort((left, right) => left.paths.join("\0").localeCompare(right.paths.join("\0")));
	return {
		executable: { actions: plan.actions.filter((action) => !deferredActions.has(action)) },
		deferred,
	};
}

function evaluateComponent(
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
	if (hasAliasTargetMutation(component)) {
		reasons.add("alias_target_mutation");
	}

	const renames = component.evidence.filter((item): item is RenameEvidence => item.kind === "rename");
	if (renames.length > 0 && reasons.size === 0) {
		const renameReason = evaluateRenames(component, renames, scope);
		if (renameReason) reasons.add(renameReason);
	} else if (renames.length === 0 && reasons.size === 0 &&
		component.evidence.some((item) => item.kind === "stable_identity" &&
			new Set(item.occurrences.map((occurrence) => occurrence.path)).size > 1)) {
		reasons.add("identity_postcondition_unproven");
	}
	return [...reasons].sort();
}

function evaluateRenames(
	component: AdmissionComponent,
	renames: RenameEvidence[],
	scope: ScopeProjection,
): AdmissionDeferralReason | undefined {
	const rules = renames.map((rename) => ({ rename, rule: projectRenameScope(rename, scope) }));
	if (rules.some(({ rename, rule }) => rename.isFolder && rule.consequence === "defer")) {
		return "incomplete_folder_mapping";
	}
	if (rules.some(({ rule }) => rule.consequence === "defer")) return "unknown_scope";
	if (hasIncompleteNativeFolderMapping(component, rules.map(({ rename, rule }) => ({
		rename, consequence: rule.consequence,
	})), scope)) return "incomplete_folder_mapping";
	if (matchesNativeRenames(component, rules.map(({ rename, rule }) => ({
		rename, consequence: rule.consequence,
	})), scope)) return undefined;
	if (rules.length === 1 && matchesScopeTransition(component, rules[0]!.rename, rules[0]!.rule.consequence)) {
		return undefined;
	}
	if (rules.length === 1 && preservesRecreatedRemoteSource(component, rules[0]!.rename)) {
		return undefined;
	}
	return "rename_mismatch";
}

function matchesNativeRenames(
	component: AdmissionComponent,
	rules: readonly { rename: RenameEvidence; consequence: RenameScopeConsequence }[],
	scope: ScopeProjection,
): boolean {
	const actions = component.actions;
	if (actions.length !== rules.length) return false;
	return rules.every(({ rename, consequence }) => {
		const expected = consequence === "rename_local" || consequence === "rename_remote"
			? consequence : undefined;
		if (!expected) return false;
		const action = actions.find((candidate) =>
			candidate.action === expected && candidate.oldPath === rename.oldPath && candidate.path === rename.newPath);
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
			candidate.action === consequence && candidate.oldPath === rename.oldPath && candidate.path === rename.newPath);
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
		if ((path.startsWith(oldPrefix) || path.startsWith(newPrefix)) && !mapped.has(path)) {
			return false;
		}
	}
	return true;
}

function hasOpposingDeletes(actions: readonly SyncAction[]): boolean {
	return actions.some((action) => action.action === "delete_local") &&
		actions.some((action) => action.action === "delete_remote");
}

function hasAliasTargetMutation(component: AdmissionComponent): boolean {
	return component.evidence.some((evidence) => {
		if (evidence.kind !== "alias") return false;
		return component.actions.some((action) => !isMatchingAliasRename(component, action, evidence));
	});
}

function isMatchingAliasRename(
	component: AdmissionComponent,
	action: SyncAction,
	alias: Extract<IdentityEvidence, { kind: "alias" }>,
): boolean {
	const expected = alias.side === "local" ? "rename_remote" : "rename_local";
	if (action.action !== expected || action.oldPath !== alias.requestedPath || action.path !== alias.resolvedPath) {
		return false;
	}
	return component.evidence.some((evidence) => evidence.kind === "rename" &&
		evidence.side === alias.side && evidence.oldPath === alias.requestedPath &&
		evidence.newPath === alias.resolvedPath);
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

function compareEvidence(left: IdentityEvidence, right: IdentityEvidence): number {
	return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
