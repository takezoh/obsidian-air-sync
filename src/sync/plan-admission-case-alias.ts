import { hasChanged, hasRemoteChanged } from "./change-compare";
import type {
	IdentityEvidence,
	MixedEntity,
	PathObservation,
	RenameEvidence,
	ScopeProjection,
	SyncAction,
} from "./types";

interface AdmissionComponent {
	paths: Set<string>;
	actions: SyncAction[];
	entries: MixedEntity[];
	evidence: IdentityEvidence[];
	observations: PathObservation[];
}

/**
 * Collapse a proven case-only folder component onto the provider's current
 * spelling for content I/O, followed by one explicit parent rename.
 *
 * The executor already runs content before structural effects.  Projecting
 * content to the current provider path lets it keep that schedule without a
 * dependency graph, while the folder action rotates both provider topology
 * and the committed descendant records afterward.
 */
export function normalizeCaseAliasParentTransition(
	component: AdmissionComponent,
	scope: ScopeProjection,
	decideChild: (component: AdmissionComponent) => SyncAction | undefined,
): SyncAction[] | undefined {
	const folderAliases = component.observations.filter((item): item is Extract<PathObservation, { kind: "alias" }> =>
		item.kind === "alias" && item.side === "local" && item.entity.isDirectory &&
		scope.byEndpoint.get(item.requestedPath) === "included" &&
		scope.byEndpoint.get(item.resolvedPath) === "included");
	if (folderAliases.length !== 1) return undefined;

	const folder = folderAliases[0]!;
	const oldPath = folder.requestedPath;
	const newPath = folder.resolvedPath;
	const remoteOld = component.observations.find((item) => item.kind === "exact" &&
		item.side === "remote" && item.requestedPath === oldPath && item.entity.isDirectory);
	const remoteNewAbsent = component.observations.some((item) => item.kind === "absent" &&
		item.side === "remote" && item.requestedPath === newPath && item.authority === "stat");
	if (!remoteOld || !remoteNewAbsent) return undefined;

	const oldPrefix = `${oldPath}/`;
	const newPrefix = `${newPath}/`;
	const childAliases = component.observations.filter((item): item is Extract<PathObservation, { kind: "alias" }> =>
		item.kind === "alias" && item.side === "local" && !item.entity.isDirectory &&
		item.requestedPath.startsWith(oldPrefix) && item.resolvedPath.startsWith(newPrefix) &&
		item.requestedPath.slice(oldPrefix.length) === item.resolvedPath.slice(newPrefix.length) &&
		scope.byEndpoint.get(item.requestedPath) === "included" &&
		scope.byEndpoint.get(item.resolvedPath) === "included");
	const affected = component.actions.filter((action) =>
		action.path.startsWith(oldPrefix) || action.path.startsWith(newPrefix));
	const childPaths = new Set(childAliases.flatMap((item) => [item.requestedPath, item.resolvedPath]));
	if (affected.length === 0 || affected.some((action) => !childPaths.has(action.path))) return undefined;

	const descendants = childAliases.map((item) => ({
		oldPath: item.requestedPath,
		newPath: item.resolvedPath,
	}));
	if (descendants.length === 0) return undefined;

	const actions = component.actions.filter((action) => !childPaths.has(action.path));
	for (const alias of childAliases) {
		const paths = new Set([alias.requestedPath, alias.resolvedPath]);
		const child: AdmissionComponent = {
			paths,
			actions: component.actions.filter((action) => paths.has(action.path)),
			entries: component.entries.filter((entry) => paths.has(entry.path)),
			evidence: component.evidence.filter((item) => evidenceTouches(item, paths)),
			observations: component.observations.filter((item) =>
				paths.has(item.requestedPath)),
		};
		const decided = decideChild(child);
		if (!decided) return undefined;
		if (decided.action === "rename_remote" && "oldPath" in decided &&
			decided.oldPath === alias.requestedPath) {
			if (decided.local && decided.baseline && hasChanged(decided.local, decided.baseline)) {
				actions.push({
					path: alias.requestedPath, action: "push",
					local: decided.local, remote: decided.remote, baseline: decided.baseline,
				});
			}
			continue;
		}
		if (decided.action !== "push" && decided.action !== "pull" &&
			decided.action !== "match" && decided.action !== "conflict") return undefined;
		actions.push({
			path: alias.requestedPath,
			action: decided.action,
			local: decided.local,
			remote: decided.remote,
			baseline: decided.baseline,
		});
	}
	actions.push({
		path: newPath, action: "rename_remote", oldPath, isFolder: true, descendants,
	});
	return actions;
}

function evidenceTouches(item: IdentityEvidence, paths: ReadonlySet<string>): boolean {
	if (item.kind === "rename") return paths.has(item.oldPath) || paths.has(item.newPath);
	if (item.kind === "alias") return paths.has(item.requestedPath) || paths.has(item.resolvedPath);
	return item.occurrences.some((occurrence) => paths.has(occurrence.path));
}

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
