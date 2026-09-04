import { hasRemoteChanged } from "./change-compare";
import type {
	IdentityEvidence,
	MixedEntity,
	PathObservation,
	RenameEvidence,
	ScopeProjection,
	SyncAction,
} from "./types";

/** Reconstruct unchanged child renames hidden by case-insensitive local aliases. */
export function reconstructCaseAliasChildRenames(
	baseActions: readonly SyncAction[],
	entries: readonly MixedEntity[],
	evidence: readonly IdentityEvidence[],
	observations: readonly PathObservation[],
	scope: ScopeProjection,
): SyncAction[] {
	const folders = evidence.filter((item): item is RenameEvidence =>
		item.kind === "rename" && item.side === "local" && item.isFolder === true &&
		scope.byEndpoint.get(item.oldPath) === "included" &&
		scope.byEndpoint.get(item.newPath) === "included");
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
			item.kind === "exact" && item.side === "remote" &&
			item.requestedPath === candidate.oldPath);
		const remoteTarget = observations.find((item): item is Extract<PathObservation, { kind: "absent" }> =>
			item.kind === "absent" && item.side === "remote" &&
			item.requestedPath === candidate.newPath);
		if (!source?.prevSync || !source.local || !alias || !remoteSource || !remoteTarget ||
			!source.prevSync.hash || source.local.hash !== source.prevSync.hash ||
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

function isAlignedChild(folder: RenameEvidence, child: RenameEvidence): boolean {
	const oldPrefix = `${folder.oldPath}/`;
	const newPrefix = `${folder.newPath}/`;
	return child.oldPath.startsWith(oldPrefix) && child.newPath.startsWith(newPrefix) &&
		child.oldPath.substring(oldPrefix.length) === child.newPath.substring(newPrefix.length);
}
