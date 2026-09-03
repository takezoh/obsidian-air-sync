import { projectRenameScope } from "./scope-projection";
import { hasRemoteChanged } from "./change-compare";
import type {
	IdentityEvidence,
	MixedEntity,
	PathObservation,
	RenameEvidence,
	ScopeProjection,
	SyncAction,
} from "./types";

/**
 * A folder rename is only an executable unit while every descendant has the
 * same scope consequence. When policy-excluded descendants coexist with
 * included files, the folder edge is structural evidence rather than an
 * executable operation: the included child edges are the complete authorized
 * units and excluded paths remain outside sync authority.
 */
export function partitionMixedScopeFolderEvidence(
	evidence: readonly IdentityEvidence[],
	scope: ScopeProjection,
): IdentityEvidence[] {
	const partitioned = evidence.filter((item): item is RenameEvidence =>
		item.kind === "rename" && item.isFolder &&
		isCompletelyRepresentedByIncludedChildren(item, evidence, scope));
	if (partitioned.length === 0) return [...evidence];

	const retained = evidence.filter((item) => {
		if (partitioned.includes(item as RenameEvidence)) return false;
		if (item.kind !== "alias") return true;
		return !partitioned.some((folder) => item.side === folder.side &&
			((item.requestedPath === folder.oldPath && item.resolvedPath === folder.newPath) ||
				(item.requestedPath === folder.newPath && item.resolvedPath === folder.oldPath)));
	});
	return deduplicateRenameEvidence(retained);
}

/**
 * Recover a pure local child rename after a case-insensitive filesystem has
 * canonicalized the requested destination back to the old spelling. The
 * action is reconstructed only from a complete baseline and exact unchanged
 * remote source; ambiguous or edited states remain failed Admission inputs.
 */
export function reconstructCaseAliasChildRenames(
	baseActions: readonly SyncAction[],
	entries: readonly MixedEntity[],
	evidence: readonly IdentityEvidence[],
	observations: readonly PathObservation[],
	scope: ScopeProjection,
): SyncAction[] {
	const folders = partitionableFolders(evidence, scope);
	if (folders.length === 0) return [...baseActions];
	const actions = [...baseActions];
	const seen = new Set<string>();
	for (const candidate of evidence) {
		if (candidate.kind !== "rename" || candidate.side !== "local" || candidate.isFolder) continue;
		const key = `${candidate.oldPath}\0${candidate.newPath}`;
		if (seen.has(key) || !folders.some((folder) => isAlignedChild(folder, candidate))) continue;
		seen.add(key);
		if (actions.some((action) => action.path === candidate.oldPath ||
			action.path === candidate.newPath)) continue;

		const source = entries.find((entry) => entry.path === candidate.oldPath);
		const alias = observations.find((item): item is Extract<PathObservation, { kind: "alias" }> =>
			item.kind === "alias" && item.side === "local" &&
			item.requestedPath === candidate.newPath && item.resolvedPath === candidate.oldPath);
		const remoteSource = observations.find((item): item is Extract<PathObservation, { kind: "exact" }> =>
			item.kind === "exact" &&
			item.side === "remote" && item.requestedPath === candidate.oldPath);
		const remoteTarget = observations.find((item): item is Extract<PathObservation, { kind: "absent" }> =>
			item.kind === "absent" &&
			item.side === "remote" && item.requestedPath === candidate.newPath);
		if (!source?.prevSync || !source.local || !alias || !remoteSource ||
			!remoteTarget || !source.prevSync.hash || source.local.hash !== source.prevSync.hash ||
			(source.prevSync.remoteIdentityKey !== undefined &&
				remoteSource.entity.identityKey !== source.prevSync.remoteIdentityKey) ||
			hasRemoteChanged(remoteSource.entity, source.prevSync)) continue;

		actions.push({
			action: "rename_remote", oldPath: candidate.oldPath, path: candidate.newPath,
			local: source.local, remote: remoteSource.entity, baseline: source.prevSync,
		});
	}
	return actions;
}

function partitionableFolders(
	evidence: readonly IdentityEvidence[],
	scope: ScopeProjection,
): RenameEvidence[] {
	return evidence.filter((item): item is RenameEvidence => item.kind === "rename" &&
		item.isFolder && isCompletelyRepresentedByIncludedChildren(item, evidence, scope));
}

function isAlignedChild(folder: RenameEvidence, child: RenameEvidence): boolean {
	const oldPrefix = `${folder.oldPath}/`;
	const newPrefix = `${folder.newPath}/`;
	return child.side === folder.side && child.oldPath.startsWith(oldPrefix) &&
		child.newPath.startsWith(newPrefix) &&
		child.oldPath.substring(oldPrefix.length) === child.newPath.substring(newPrefix.length);
}

function deduplicateRenameEvidence(evidence: readonly IdentityEvidence[]): IdentityEvidence[] {
	const seen = new Set<string>();
	return evidence.filter((item) => {
		if (item.kind !== "rename") return true;
		const key = [
			item.side, item.oldPath, item.newPath, item.isFolder === true,
			item.identityKey ?? "", item.authority,
		].join("\0");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function isCompletelyRepresentedByIncludedChildren(
	folder: RenameEvidence,
	evidence: readonly IdentityEvidence[],
	scope: ScopeProjection,
): boolean {
	const rule = projectRenameScope(folder, scope);
	if (rule.consequence !== "defer" || rule.oldDisposition !== "included" ||
		rule.newDisposition !== "included") return false;

	const oldPrefix = `${folder.oldPath}/`;
	const newPrefix = `${folder.newPath}/`;
	const descendants = [...scope.byEndpoint].filter(([path]) =>
		path.startsWith(oldPrefix) || path.startsWith(newPrefix));
	if (descendants.some(([, disposition]) =>
		disposition === "unknown" || disposition === "mobile_deferred")) return false;
	if (!descendants.some(([, disposition]) => disposition === "policy_out")) return false;

	const childRenames = evidence.filter((item): item is RenameEvidence =>
		item.kind === "rename" && !item.isFolder && item.side === folder.side &&
		item.oldPath.startsWith(oldPrefix) && item.newPath.startsWith(newPrefix) &&
		item.oldPath.substring(oldPrefix.length) === item.newPath.substring(newPrefix.length) &&
		projectRenameScope(item, scope).consequence !== "defer");
	if (childRenames.length === 0) return false;

	const covered = new Set(childRenames.flatMap((item) => [item.oldPath, item.newPath]));
	return descendants.every(([path, disposition]) =>
		disposition === "policy_out" || covered.has(path));
}
