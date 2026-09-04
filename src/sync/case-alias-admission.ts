import type { FileEntity } from "../fs/types";
import { sameContent } from "./content-identity";
import type {
	IdentityEvidence,
	LocalRenameEvidence,
	MixedEntity,
	PathObservation,
	ScopeProjection,
	SyncRecord,
} from "./types";

interface CaseAliasComponent {
	readonly entries: readonly MixedEntity[];
	readonly evidence: readonly IdentityEvidence[];
	readonly observations: readonly PathObservation[];
}

export type LocalRenameCandidate = LocalRenameEvidence | {
	readonly oldPath: string;
	readonly newPath: string;
};

export interface NormalizedLocalCaseAlias {
	readonly candidate: LocalRenameCandidate;
	readonly local: FileEntity;
	readonly remote: FileEntity;
	readonly baseline?: SyncRecord;
}

/** Recognize the one local case-alias edge that Admission must decide. */
export function localCaseAliasCandidate(
	component: CaseAliasComponent,
	scope: ScopeProjection,
): LocalRenameCandidate | undefined {
	const aliases = component.evidence.filter((item): item is Extract<IdentityEvidence, { kind: "alias" }> =>
		item.kind === "alias" && item.side === "local" &&
		item.requestedPath !== item.resolvedPath &&
		item.requestedPath.toLowerCase() === item.resolvedPath.toLowerCase() &&
		scope.byEndpoint.get(item.requestedPath) === "included" &&
		scope.byEndpoint.get(item.resolvedPath) === "included");
	if (aliases.length !== 1) return undefined;
	const alias = aliases[0]!;
	return { oldPath: alias.requestedPath, newPath: alias.resolvedPath };
}

/** Parse complete case-alias facts without choosing an action or disposition. */
export function normalizeLocalCaseAlias(
	component: CaseAliasComponent,
	scope: ScopeProjection,
): NormalizedLocalCaseAlias | undefined {
	const candidate = localCaseAliasCandidate(component, scope);
	if (!candidate) return undefined;
	const source = component.entries.find((entry) => entry.path === candidate.oldPath);
	const target = component.entries.find((entry) => entry.path === candidate.newPath);
	if (!source?.remote || !target?.local || source.local || target.remote ||
		source.remote.path !== candidate.oldPath || target.local.path !== candidate.newPath ||
		!source.remote.identityKey) return undefined;

	if (!observesOnlyLocalAlias(component, candidate.oldPath, candidate.newPath)) return undefined;
	if (!observesOnlyExact(component, "local", candidate.newPath, target.local)) return undefined;
	if (!observesOnlyExact(component, "remote", candidate.oldPath, source.remote)) return undefined;
	if (!observesOnlyStatAbsence(component, "remote", candidate.newPath)) return undefined;
	if (!remoteIdentityIsUniqueAt(component, source.remote.identityKey, candidate.oldPath)) return undefined;
	return {
		candidate, local: target.local, remote: source.remote,
		baseline: source.prevSync ?? target.prevSync,
	};
}

function observesOnlyLocalAlias(
	component: CaseAliasComponent,
	requestedPath: string,
	resolvedPath: string,
): boolean {
	const found = observations(component, "local", requestedPath);
	return found.length > 0 && found.every((item) =>
		item.kind === "alias" && item.resolvedPath === resolvedPath);
}

function observesOnlyExact(
	component: CaseAliasComponent,
	side: "local" | "remote",
	path: string,
	entity: FileEntity,
): boolean {
	const found = observations(component, side, path);
	return found.length > 0 && found.every((item) => item.kind === "exact" &&
		item.entity.path === path && item.entity.size === entity.size &&
		sameContent(item.entity, entity) &&
		(side === "local" || item.entity.identityKey === entity.identityKey));
}

function observesOnlyStatAbsence(
	component: CaseAliasComponent,
	side: "local" | "remote",
	path: string,
): boolean {
	const found = observations(component, side, path);
	return found.length > 0 && found.every((item) =>
		item.kind === "absent" && item.authority === "stat");
}

function remoteIdentityIsUniqueAt(
	component: CaseAliasComponent,
	identityKey: string,
	path: string,
): boolean {
	const observedPaths = new Set(component.observations.flatMap((item) =>
		item.side === "remote" && (item.kind === "exact" || item.kind === "alias") &&
		item.entity.identityKey === identityKey
			? [item.kind === "alias" ? item.resolvedPath : item.requestedPath]
			: []));
	if (observedPaths.size !== 1 || !observedPaths.has(path)) return false;
	return !component.evidence.some((item) => item.kind === "stable_identity" &&
		item.identityKey === identityKey &&
		new Set(item.occurrences.filter((entry) => entry.phase === "current")
			.map((entry) => entry.path)).size > 1);
}

function observations(
	component: CaseAliasComponent,
	side: "local" | "remote",
	path: string,
) {
	return component.observations.filter((item) =>
		item.side === side && item.requestedPath === path);
}
