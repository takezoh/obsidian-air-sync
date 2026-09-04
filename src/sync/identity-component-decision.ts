/* eslint max-lines: ["error", 420] -- the final identity verdict keeps its cycle-local topology proof and all fail-closed predicates together as one Admission authority. */
import { projectRenameScope, type RenameScopeConsequence } from "./scope-projection";
import type { AdmissionComponent } from "./plan-admission-graph";
import type {
	EvidenceContradictionReason,
	EvidenceUnknownReason,
	NormalizedRenameState,
} from "./local-rename-admission";
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

export function evaluateIdentityComponent(
	component: AdmissionComponent,
	scope: ScopeProjection,
	additionalReasons: readonly AdmissionFailureReason[] = [],
): AdmissionFailureReason[] {
	const reasons = new Set<AdmissionFailureReason>(additionalReasons);
	if (reasons.size > 0) return [...reasons].sort();
	const coverage = deriveTopologyCoverage(component, scope);
	if (component.observations.some((item) => item.kind === "present_unresolved")) {
		reasons.add("present_unresolved");
	}
	if (component.observations.some((item) => item.kind === "unknown")) {
		reasons.add("unknown_observation");
	}
	if (hasConflictingIdentity(component)) reasons.add("conflicting_identity");
	if (hasOpposingDeletes(component.actions)) reasons.add("opposing_deletes");
	if (hasAliasTargetMutation(component, coverage)) reasons.add("alias_target_mutation");

	const renames = component.evidence.filter((item): item is RenameEvidence => item.kind === "rename");
	const resolvedNoAction = component.actions.length === 0 && renames.length > 0 &&
		renames.every((rename) => resolvedAtBothSides(rename, component.observations));
	if (renames.length > 0 && reasons.size === 0) {
		const renameReason = matchesNormalizedLocalMove(component, renames)
			? undefined : evaluateRenames(component, renames, scope, resolvedNoAction);
		if (renameReason) reasons.add(renameReason);
	} else if (renames.length === 0 && reasons.size === 0 &&
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
	return rules.every(({ rename, consequence }) => {
		const expected = consequence === "rename_local" || consequence === "rename_remote"
			? consequence : undefined;
		if (!expected) return false;
		const exactAction = component.actions.find((candidate) =>
			candidate.action === expected && candidate.oldPath === rename.oldPath &&
			candidate.path === rename.newPath);
		if (exactAction?.action === expected) {
			if (nativeDestinationOccupied(component, rename, expected)) return false;
			return !rename.isFolder || folderMappingComplete(exactAction, rename, scope);
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

function hasAliasTargetMutation(
	component: AdmissionComponent,
	coverage: TopologyCoverage,
): boolean {
	return component.evidence.some((evidence) => evidence.kind === "alias" &&
		!isMatchingAliasRename(component, evidence, coverage));
}

function isMatchingAliasRename(
	component: AdmissionComponent,
	alias: Extract<IdentityEvidence, { kind: "alias" }>,
	coverage: TopologyCoverage,
): boolean {
	const forward = coverage.byPair.get(pairKey(alias.requestedPath, alias.resolvedPath)) ?? [];
	const reverse = coverage.byPair.get(pairKey(alias.resolvedPath, alias.requestedPath)) ?? [];
	return [...forward, ...reverse].some((entry) => {
		if (entry.action.action !== "rename_local" && entry.action.action !== "rename_remote") {
			return false;
		}
		if ("protocol" in entry.action &&
			entry.action.protocol === "case_alias_canonicalization") return true;
		if ("normalizedRenameState" in entry.action) return true;
		if (component.evidence.some((evidence) => evidence.kind === "rename" &&
			evidence.oldPath === entry.oldPath && evidence.newPath === entry.newPath &&
			entry.action.action === (evidence.side === "local" ? "rename_remote" : "rename_local"))) {
			return true;
		}
		return alias.side === "local" && entry.action.action === "rename_remote" &&
			entry.action.isFolder === true && entry.complete && entry.remoteTopologyObserved;
	});
}

interface CoverageEntry {
	readonly action: SyncAction;
	readonly oldPath: string;
	readonly newPath: string;
	readonly complete: boolean;
	readonly remoteTopologyObserved: boolean;
}

interface TopologyCoverage {
	readonly byPair: ReadonlyMap<string, readonly CoverageEntry[]>;
}

function deriveTopologyCoverage(
	component: AdmissionComponent,
	scope: ScopeProjection,
): TopologyCoverage {
	const byPair = new Map<string, CoverageEntry[]>();
	for (const action of component.actions) {
		if (action.action !== "rename_local" && action.action !== "rename_remote") {
			if ("normalizedRenameState" in action && "oldPath" in action) {
				addCoverageEntry(byPair, {
					action, oldPath: action.oldPath, newPath: action.path,
					complete: false, remoteTopologyObserved: false,
				});
			}
			continue;
		}
		const complete = action.isFolder === true && folderMappingComplete(action, {
			kind: "rename", side: action.action === "rename_remote" ? "local" : "remote",
			oldPath: action.oldPath, newPath: action.path, isFolder: true, authority: "reported",
		}, scope);
		const remoteTopologyObserved = action.action === "rename_remote" &&
			component.observations.some((observation) => observation.kind === "exact" &&
				observation.side === "remote" && observation.requestedPath === action.oldPath &&
				observation.entity.isDirectory) &&
			component.observations.some((observation) => observation.kind === "absent" &&
				observation.side === "remote" && observation.requestedPath === action.path &&
				observation.authority === "stat");
		addCoverageEntry(byPair, {
			action, oldPath: action.oldPath, newPath: action.path,
			complete, remoteTopologyObserved,
		});
		for (const pair of action.descendants ?? []) {
			addCoverageEntry(byPair, {
				action, oldPath: pair.oldPath, newPath: pair.newPath,
				complete, remoteTopologyObserved,
			});
		}
	}
	return { byPair };
}

function matchesNormalizedLocalMove(
	component: AdmissionComponent,
	renames: readonly RenameEvidence[],
): boolean {
	return component.actions.length === 1 && component.actions.every((action) =>
		"normalizedRenameState" in action && "oldPath" in action &&
		renames.some((rename) => rename.side === "local" && !rename.isFolder &&
			rename.oldPath === action.oldPath && rename.newPath === action.path));
}

function addCoverageEntry(
	byPair: Map<string, CoverageEntry[]>,
	entry: CoverageEntry,
): void {
	const key = pairKey(entry.oldPath, entry.newPath);
	const entries = byPair.get(key) ?? [];
	entries.push(entry);
	byPair.set(key, entries);
}

function pairKey(oldPath: string, newPath: string): string {
	return `${oldPath}\0${newPath}`;
}

function hasUncoveredStableIdentity(
	component: AdmissionComponent,
	coverage: TopologyCoverage,
): boolean {
	return component.evidence.some((evidence) => {
		if (evidence.kind !== "stable_identity" || evidence.side !== "remote") return false;
		if (component.actions.some((action) => {
			if (!("normalizedRenameState" in action)) return false;
			const state = action.normalizedRenameState as NormalizedRenameState;
			return typeof state === "object" && state !== null && "baseline" in state &&
				state.baseline?.remoteIdentityKey === evidence.identityKey;
		})) return false;
		const current = evidence.occurrences.filter((item) => item.phase === "current");
		const baseline = evidence.occurrences.filter((item) => item.phase === "baseline");
		const spansPaths = new Set(evidence.occurrences.map((item) => item.path)).size > 1;
		if (!spansPaths) return false;
		if (current.length !== 1 || baseline.length !== 1 ||
			current[0]!.identityKey !== evidence.identityKey ||
			baseline[0]!.identityKey !== evidence.identityKey) return true;
		const entries = coverage.byPair.get(pairKey(current[0]!.path, baseline[0]!.path)) ?? [];
		return !entries.some((entry) => entry.action.action === "rename_remote" &&
			entry.action.isFolder === true && entry.complete && entry.remoteTopologyObserved);
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
