import type { SyncAction } from "./types";

/**
 * Replace matching `delete_remote(oldPath) + push(newPath)` pairs
 * with a single `rename_remote` action when the content hash is unchanged.
 */
export function optimizeRenames(
	actions: SyncAction[],
	renamePairs: ReadonlyMap<string, string>,
): SyncAction[] {
	if (renamePairs.size === 0) return actions;

	const byPath = new Map<string, SyncAction>();
	for (const a of actions) byPath.set(a.path, a);

	const consumed = new Set<string>();
	const renamed: SyncAction[] = [];

	for (const [newPath, oldPath] of renamePairs) {
		const del = byPath.get(oldPath);
		const push = byPath.get(newPath);
		if (
			del?.action !== "delete_remote" ||
			push?.action !== "push" ||
			!del.baseline?.hash ||
			!push.local?.hash ||
			push.local.hash !== del.baseline.hash
		) {
			continue;
		}
		renamed.push({
			path: newPath,
			action: "rename_remote",
			oldPath,
			local: push.local,
			remote: del.remote,
			baseline: del.baseline,
		});
		consumed.add(oldPath);
		consumed.add(newPath);
	}

	if (consumed.size === 0) return actions;

	const result: SyncAction[] = [];
	for (const a of actions) {
		if (!consumed.has(a.path)) result.push(a);
	}
	return result.concat(renamed);
}
