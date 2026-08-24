import type { ChangeSet } from "./change-detector";
import type {
	IdentityEvidence,
	PathObservation,
	RenameEvidence,
	ScopeDisposition,
	ScopeProjection,
} from "./types";

export type RenameScopeConsequence =
	| "rename_remote"
	| "delete_remote"
	| "push"
	| "rename_local"
	| "delete_local"
	| "pull"
	| "none"
	| "defer";

interface RenameScopeRule {
	consequence: RenameScopeConsequence;
	oldDisposition: ScopeDisposition;
	newDisposition: ScopeDisposition;
}

export interface ScopeProjectionPolicy {
	classifyPath: (path: string) => "included" | "policy_out" | "unknown";
	mobileMaxBytes?: number;
}

/**
 * Classify the complete pre-filter change surface. Rename and alias endpoints
 * are included even when no exact MixedEntity exists for them.
 */
export function projectScope(
	changeSet: Pick<ChangeSet, "entries" | "observations" | "identityEvidence">,
	policy: ScopeProjectionPolicy,
): ScopeProjection {
	const requiredPaths = collectScopePaths(changeSet.identityEvidence);
	for (const entry of changeSet.entries) requiredPaths.add(entry.path);
	const paths = new Set(requiredPaths);
	const knownPaths = new Set<string>();
	const unknownPaths = new Set<string>();
	for (const entry of changeSet.entries) {
		if (entry.local || entry.remote) knownPaths.add(entry.path);
	}
	for (const observation of changeSet.observations) {
		if (isIncidentalDirectory(observation, requiredPaths)) continue;
		paths.add(observation.requestedPath);
		if (observation.kind === "unknown") {
			unknownPaths.add(observation.requestedPath);
		} else {
			knownPaths.add(observation.requestedPath);
		}
		if (observation.kind === "alias") {
			paths.add(observation.resolvedPath);
			knownPaths.add(observation.resolvedPath);
		} else if (observation.kind === "present_unresolved" &&
			observation.returnedPath !== observation.requestedPath) {
			paths.add(observation.returnedPath);
			unknownPaths.add(observation.returnedPath);
		}
	}

	const sizes = new Map<string, number>();
	for (const entry of changeSet.entries) {
		for (const entity of [entry.local, entry.remote]) {
			if (entity) rememberLargestSize(sizes, entry.path, entity.size);
		}
	}
	for (const observation of changeSet.observations) {
		if (isIncidentalDirectory(observation, requiredPaths)) continue;
		if (observation.kind === "exact" || observation.kind === "present_unresolved") {
			rememberLargestSize(sizes, observation.requestedPath, observation.entity.size);
		} else if (observation.kind === "alias") {
			rememberLargestSize(sizes, observation.resolvedPath, observation.entity.size);
		}
	}

	const outsideRoot = new Set(changeSet.observations.flatMap((observation) =>
		observation.side === "remote" && observation.kind === "unknown" &&
		observation.reason === "outside_tracked_root"
			? [observation.requestedPath]
			: []));
	const byEndpoint = new Map<string, ScopeDisposition>();
	for (const path of paths) {
		const configured = outsideRoot.has(path) ? "policy_out" : policy.classifyPath(path);
		if (configured !== "included") {
			byEndpoint.set(path, configured);
			continue;
		}
		if (unknownPaths.has(path) || !knownPaths.has(path)) {
			byEndpoint.set(path, "unknown");
			continue;
		}
		const size = sizes.get(path);
		byEndpoint.set(
			path,
			policy.mobileMaxBytes !== undefined && size !== undefined && size > policy.mobileMaxBytes
				? "mobile_deferred"
				: "included",
		);
	}
	return { byEndpoint };
}

function isIncidentalDirectory(
	observation: PathObservation,
	requiredPaths: ReadonlySet<string>,
): boolean {
	if (observation.kind !== "exact" && observation.kind !== "alias" &&
		observation.kind !== "present_unresolved") return false;
	if (!observation.entity.isDirectory) return false;
	const endpointPaths = observation.kind === "alias"
		? [observation.requestedPath, observation.resolvedPath]
		: observation.kind === "present_unresolved"
			? [observation.requestedPath, observation.returnedPath]
			: [observation.requestedPath];
	return endpointPaths.every((path) => !requiredPaths.has(path));
}

/** The only action kind scope permits for one normative reported rename. */
export function projectRenameScope(
	rename: RenameEvidence,
	projection: ScopeProjection,
): RenameScopeRule {
	const oldDisposition = projection.byEndpoint.get(rename.oldPath) ?? "unknown";
	const newDisposition = projection.byEndpoint.get(rename.newPath) ?? "unknown";
	const consequence = consequenceFor(rename.side, oldDisposition, newDisposition);
	if (rename.isFolder && !descendantsMatch(rename, projection, consequence)) {
		return { consequence: "defer", oldDisposition, newDisposition };
	}
	return { consequence, oldDisposition, newDisposition };
}

function collectScopePaths(evidence: readonly IdentityEvidence[]): Set<string> {
	const paths = new Set<string>();
	for (const item of evidence) {
		if (item.kind === "rename") {
			paths.add(item.oldPath);
			paths.add(item.newPath);
		} else if (item.kind === "alias") {
			paths.add(item.requestedPath);
			paths.add(item.resolvedPath);
		} else {
			for (const occurrence of item.occurrences) paths.add(occurrence.path);
		}
	}
	return paths;
}

function rememberLargestSize(sizes: Map<string, number>, path: string, size: number): void {
	sizes.set(path, Math.max(sizes.get(path) ?? 0, size));
}

function isIndeterminate(
	disposition: ScopeDisposition,
): disposition is "unknown" | "mobile_deferred" {
	return disposition === "unknown" || disposition === "mobile_deferred";
}

function consequenceFor(
	side: "local" | "remote",
	oldDisposition: ScopeDisposition,
	newDisposition: ScopeDisposition,
): RenameScopeConsequence {
	if (isIndeterminate(oldDisposition) || isIndeterminate(newDisposition)) return "defer";
	if (oldDisposition === "policy_out" && newDisposition === "policy_out") return "none";
	return side === "local"
		? localConsequence(oldDisposition, newDisposition)
		: remoteConsequence(oldDisposition, newDisposition);
}

function descendantsMatch(
	rename: RenameEvidence,
	projection: ScopeProjection,
	expected: RenameScopeConsequence,
): boolean {
	const oldPrefix = `${rename.oldPath}/`;
	const newPrefix = `${rename.newPath}/`;
	const relatives = new Set<string>();
	for (const path of projection.byEndpoint.keys()) {
		if (path.startsWith(oldPrefix)) relatives.add(path.substring(oldPrefix.length));
		if (path.startsWith(newPrefix)) relatives.add(path.substring(newPrefix.length));
	}
	for (const relative of relatives) {
		const oldDisposition = projection.byEndpoint.get(`${oldPrefix}${relative}`) ?? "unknown";
		const newDisposition = projection.byEndpoint.get(`${newPrefix}${relative}`) ?? "unknown";
		if (consequenceFor(rename.side, oldDisposition, newDisposition) !== expected) {
			return false;
		}
	}
	return true;
}

function localConsequence(
	oldDisposition: "included" | "policy_out",
	newDisposition: "included" | "policy_out",
): RenameScopeConsequence {
	if (oldDisposition === "included" && newDisposition === "included") return "rename_remote";
	if (oldDisposition === "included") return "delete_remote";
	return "push";
}

function remoteConsequence(
	oldDisposition: "included" | "policy_out",
	newDisposition: "included" | "policy_out",
): RenameScopeConsequence {
	if (oldDisposition === "included" && newDisposition === "included") return "rename_local";
	if (oldDisposition === "included") return "delete_local";
	return "pull";
}
