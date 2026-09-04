import type { AdmissionComponent } from "./plan-admission-graph";
import type { NormalizedRenameState } from "./local-rename-admission";
import type {
	IdentityEvidence,
	RenameEvidence,
	ScopeProjection,
	SyncAction,
} from "./types";

interface CoverageEntry {
	readonly action: SyncAction;
	readonly oldPath: string;
	readonly newPath: string;
	readonly complete: boolean;
	readonly remoteTopologyObserved: boolean;
	readonly governingRename?: RenameEvidence;
}

export interface TopologyCoverage {
	readonly byPair: ReadonlyMap<string, readonly CoverageEntry[]>;
}

export type TopologyAuthority =
	| { readonly kind: "reported"; readonly reports: readonly RenameEvidence[] }
	| { readonly kind: "current_fact"; readonly enabled: boolean }
	| { readonly kind: "none" };

export function folderMappingComplete(
	action: Extract<SyncAction, { action: "rename_local" | "rename_remote" }>,
	rename: Pick<RenameEvidence, "oldPath" | "newPath">,
	scope: ScopeProjection,
	evidence: readonly IdentityEvidence[] = [],
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
	const nestedFolderEndpoints = reportedNestedFolderEndpoints(rename, evidence);
	for (const path of scope.byEndpoint.keys()) {
		if ((path.startsWith(oldPrefix) || path.startsWith(newPrefix)) && !mapped.has(path) &&
			!nestedFolderEndpoints.has(path)) return false;
	}
	return true;
}

function reportedNestedFolderEndpoints(
	root: Pick<RenameEvidence, "oldPath" | "newPath">,
	evidence: readonly IdentityEvidence[],
): ReadonlySet<string> {
	const endpoints = new Set<string>();
	for (const item of evidence) {
		if (item.kind !== "rename" || !item.isFolder ||
			item.oldPath === root.oldPath || item.newPath === root.newPath ||
			!item.oldPath.startsWith(`${root.oldPath}/`) ||
			!item.newPath.startsWith(`${root.newPath}/`) ||
			item.oldPath.slice(root.oldPath.length) !== item.newPath.slice(root.newPath.length)) continue;
		endpoints.add(item.oldPath);
		endpoints.add(item.newPath);
	}
	return endpoints;
}

export function deriveTopologyCoverage(
	component: AdmissionComponent,
	scope: ScopeProjection,
	authority: TopologyAuthority,
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
		const governingRename = authority.kind === "reported"
			? authority.reports.find((item) => item.oldPath === action.oldPath &&
			item.newPath === action.path &&
			action.action === (item.side === "local" ? "rename_remote" : "rename_local"))
			: undefined;
		const complete = action.isFolder === true && folderMappingComplete(action, {
			oldPath: action.oldPath, newPath: action.path,
		}, scope, component.evidence);
		const remoteTopologyObserved = authority.kind === "current_fact" && authority.enabled &&
			action.action === "rename_remote" &&
			component.observations.some((observation) => observation.kind === "exact" &&
				observation.side === "remote" && observation.requestedPath === action.oldPath &&
				observation.entity.isDirectory) &&
			component.observations.some((observation) => observation.kind === "absent" &&
				observation.side === "remote" && observation.requestedPath === action.path &&
				observation.authority === "stat");
		addCoverageEntry(byPair, {
			action, oldPath: action.oldPath, newPath: action.path,
			complete, remoteTopologyObserved, governingRename,
		});
		for (const pair of action.descendants ?? []) {
			addCoverageEntry(byPair, {
				action, oldPath: pair.oldPath, newPath: pair.newPath,
				complete, remoteTopologyObserved, governingRename,
			});
		}
		if (governingRename?.isFolder) {
			for (const item of component.evidence) {
				if (item.kind !== "rename" || !item.isFolder ||
					!isAlignedNestedReport(governingRename, item)) continue;
				addCoverageEntry(byPair, {
					action, oldPath: item.oldPath, newPath: item.newPath,
					complete, remoteTopologyObserved, governingRename,
				});
			}
		}
	}
	return { byPair };
}

function isAlignedNestedReport(root: RenameEvidence, candidate: RenameEvidence): boolean {
	if (candidate.side !== root.side || candidate.oldPath === root.oldPath ||
		candidate.newPath === root.newPath) return false;
	const oldPrefix = `${root.oldPath}/`;
	const newPrefix = `${root.newPath}/`;
	return candidate.oldPath.startsWith(oldPrefix) && candidate.newPath.startsWith(newPrefix) &&
		candidate.oldPath.slice(oldPrefix.length) === candidate.newPath.slice(newPrefix.length);
}

export function hasAliasTargetMutation(
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
		if (entry.governingRename && entry.action.action ===
			(entry.governingRename.side === "local" ? "rename_remote" : "rename_local")) {
			return true;
		}
		return alias.side === "local" && entry.action.action === "rename_remote" &&
			entry.action.isFolder === true && entry.complete && entry.remoteTopologyObserved;
	});
}

export function hasUncoveredStableIdentity(
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
