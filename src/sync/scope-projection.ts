import type { ChangeSet } from "./change-detector";
import type { AirSyncSettings } from "../settings";
import { getEffectiveIgnorePatterns, getEffectiveSyncDotPaths } from "../config-sync";
import { INTERNAL_METADATA_PATH } from "../fs/remote-vault-contract";
import { isIgnored, isSystemJunkFile } from "../utils/ignore";
import { isDotPathOutOfScope } from "../utils/path";
import type {
	IdentityEvidence,
	PathObservation,
	RenameEvidence,
	ScopeDisposition,
	ScopeProjection,
} from "./types";

export type RenameScopeConsequence = "rename_remote" | "rename_local" | "defer";

interface RenameScopeRule {
	consequence: RenameScopeConsequence;
	oldDisposition: ScopeDisposition;
	newDisposition: ScopeDisposition;
}

export interface ScopeProjectionPolicy {
	readonly ignorePatterns?: readonly string[];
	readonly syncDotPaths?: readonly string[];
	readonly reservedPaths?: readonly string[];
	readonly excludeSystemJunk?: boolean;
	readonly mobileMaxBytes?: number;
}

/** Copy configured values, never a live settings callback, into the cycle cut. */
export function captureScopePolicy(
	settings: AirSyncSettings, configDir: string, pluginId: string, mobile = false,
): ScopeProjectionPolicy {
	return Object.freeze({
		ignorePatterns: Object.freeze([...getEffectiveIgnorePatterns(settings, configDir, pluginId)]),
		syncDotPaths: Object.freeze([...getEffectiveSyncDotPaths(settings, configDir)]),
		reservedPaths: Object.freeze([INTERNAL_METADATA_PATH, `${configDir}/plugins/${pluginId}/data.json`]),
		excludeSystemJunk: true,
		mobileMaxBytes: mobile ? settings.mobileMaxFileSizeMB * 1024 * 1024 : undefined,
	});
}

export function isExcludedFromScope(path: string, policy: ScopeProjectionPolicy): boolean {
	return policy.reservedPaths?.includes(path) === true ||
		(policy.excludeSystemJunk === true && isSystemJunkFile(path)) ||
		(policy.syncDotPaths !== undefined && isDotPathOutOfScope(path, [...policy.syncDotPaths])) ||
		isIgnored(path, [...policy.ignorePatterns ?? []]);
}

export interface ScopedChangeSet {
	changeSet: ChangeSet;
	projection: ScopeProjection;
}

/**
 * Apply configured scope before constructing the sync engine's Observation.
 * Excluded paths and identity edges do not have an engine representation.
 */
export function applyScope(
	changeSet: ChangeSet,
	inputPolicy: ScopeProjectionPolicy,
): ScopedChangeSet {
	const policy: ScopeProjectionPolicy = Object.freeze({
		...inputPolicy,
		ignorePatterns: Object.freeze([...inputPolicy.ignorePatterns ?? []]),
		reservedPaths: Object.freeze([...inputPolicy.reservedPaths ?? []]),
		syncDotPaths: inputPolicy.syncDotPaths && Object.freeze([...inputPolicy.syncDotPaths]),
	});
	const outsideRoot = new Set(changeSet.observations.flatMap((observation) =>
		observation.side === "remote" && observation.kind === "unknown" &&
		observation.reason === "outside_tracked_root"
			? [observation.requestedPath]
			: []));
	const isIncluded = (path: string) => !outsideRoot.has(path) && !isExcludedFromScope(path, policy);
	const surfacePaths = collectChangeSetPaths(changeSet);
	const scoped: ChangeSet = {
		...changeSet,
		entries: changeSet.entries.flatMap((entry) => {
			if (!isIncluded(entry.path)) return [];
			return [{
				...entry,
				local: entry.local && isIncluded(entry.local.path) ? entry.local : undefined,
				remote: entry.remote && isIncluded(entry.remote.path) ? entry.remote : undefined,
				prevSync: entry.prevSync && isIncluded(entry.prevSync.path) ? entry.prevSync : undefined,
			}];
		}),
		observations: changeSet.observations.flatMap((observation) =>
			normalizeObservation(observation, isIncluded)),
		identityEvidence: changeSet.identityEvidence.flatMap((evidence) =>
			normalizeIdentityEvidence(evidence, surfacePaths, isIncluded)),
	};
	const projection = projectScope(scoped, policy.mobileMaxBytes);
	return {
		changeSet: scoped,
		projection: {
			...projection,
			isConfiguredScopeCompatible: (from, to) => isIncluded(from) && isIncluded(to) &&
				!crossesScope({ oldPath: from, newPath: to }, surfacePaths, isIncluded),
		},
	};
}

function normalizeObservation(
	observation: PathObservation,
	isIncluded: (path: string) => boolean,
): PathObservation[] {
	if (!isIncluded(observation.requestedPath)) return [];
	if ((observation.kind === "exact" || observation.kind === "alias" ||
		observation.kind === "present_unresolved") && !isIncluded(observation.entity.path)) {
		return [];
	}
	if (observation.kind === "alias" && !isIncluded(observation.resolvedPath)) {
		return [];
	}
	if (observation.kind === "present_unresolved" && !isIncluded(observation.returnedPath)) {
		return [];
	}
	return [observation];
}

function normalizeIdentityEvidence(
	evidence: IdentityEvidence,
	surfacePaths: ReadonlySet<string>,
	isIncluded: (path: string) => boolean,
): IdentityEvidence[] {
	if (evidence.kind === "rename") {
		if (!isIncluded(evidence.oldPath) || !isIncluded(evidence.newPath)) return [];
		return evidence.isFolder && crossesScope(evidence, surfacePaths, isIncluded) ? [] : [evidence];
	}
	if (evidence.kind === "alias") {
		return isIncluded(evidence.requestedPath) && isIncluded(evidence.resolvedPath)
			? [evidence]
			: [];
	}
	const occurrences = evidence.occurrences.filter((occurrence) => isIncluded(occurrence.path));
	return occurrences.length > 0 ? [{ ...evidence, occurrences }] : [];
}

function collectChangeSetPaths(changeSet: ChangeSet): Set<string> {
	const paths = new Set<string>();
	for (const entry of changeSet.entries) {
		paths.add(entry.path);
		if (entry.local) paths.add(entry.local.path);
		if (entry.remote) paths.add(entry.remote.path);
		if (entry.prevSync) paths.add(entry.prevSync.path);
	}
	for (const observation of changeSet.observations) {
		paths.add(observation.requestedPath);
		if (observation.kind === "exact" || observation.kind === "alias" ||
			observation.kind === "present_unresolved") paths.add(observation.entity.path);
		if (observation.kind === "alias") paths.add(observation.resolvedPath);
		if (observation.kind === "present_unresolved") paths.add(observation.returnedPath);
	}
	for (const evidence of changeSet.identityEvidence) {
		for (const path of collectScopePaths([evidence])) paths.add(path);
	}
	return paths;
}

function crossesScope(
	rename: Pick<RenameEvidence, "oldPath" | "newPath">,
	paths: ReadonlySet<string>,
	isIncluded: (path: string) => boolean,
): boolean {
	const oldPrefix = `${rename.oldPath}/`;
	const newPrefix = `${rename.newPath}/`;
	for (const path of paths) {
		const relative = path.startsWith(oldPrefix)
			? path.substring(oldPrefix.length)
			: path.startsWith(newPrefix) ? path.substring(newPrefix.length) : undefined;
		if (relative === undefined) continue;
		if (isIncluded(`${oldPrefix}${relative}`) !== isIncluded(`${newPrefix}${relative}`)) {
			return true;
		}
	}
	return false;
}

/** Project mobile and observation completeness over already scoped facts. */
export function projectScope(
	changeSet: Pick<ChangeSet, "entries" | "observations" | "identityEvidence">,
	mobileMaxBytes?: number,
): ScopeProjection {
	const requiredPaths = collectScopePaths(changeSet.identityEvidence);
	const paths = new Set(requiredPaths);
	for (const entry of changeSet.entries) paths.add(entry.path);
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

	const byEndpoint = new Map<string, ScopeDisposition>();
	for (const path of paths) {
		if (unknownPaths.has(path) || !knownPaths.has(path)) {
			byEndpoint.set(path, "unknown");
			continue;
		}
		const size = sizes.get(path);
		byEndpoint.set(
			path,
			mobileMaxBytes !== undefined && size !== undefined && size > mobileMaxBytes
				? "mobile_deferred"
				: "included",
		);
	}
	return { byEndpoint, isConfiguredScopeCompatible: () => true };
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
	const consequence = consequenceFor(rename, oldDisposition, newDisposition);
	if (!projection.isConfiguredScopeCompatible(rename.oldPath, rename.newPath) ||
		(rename.isFolder && !descendantsMatch(rename, projection, consequence))) {
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
	rename: RenameEvidence,
	oldDisposition: ScopeDisposition,
	newDisposition: ScopeDisposition,
): RenameScopeConsequence {
	if (isIndeterminate(oldDisposition) || isIndeterminate(newDisposition)) return "defer";
	return rename.side === "local" ? "rename_remote" : "rename_local";
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
		if (consequenceFor(rename, oldDisposition, newDisposition) !== expected) return false;
	}
	return true;
}
