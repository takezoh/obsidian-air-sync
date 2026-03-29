import type { RenamePair, SyncAction } from "./types";
import type { RenameOptResult, RemoteFolderRenameOptResult } from "./rename-optimizer-types";
import type { Logger } from "../logging/logger";
import { replaceConsumed } from "./rename-optimizer";

/**
 * Replace matching `delete_local(oldPath) + pull(newPath)` pairs
 * with a single `rename_local` action using remote rename pair info.
 *
 * Remote rename information is authoritative (from the backend),
 * so no hash verification is needed.
 */
export function optimizeRemoteFileRenames(
	actions: SyncAction[],
	remoteRenamePairs: RenamePair[],
	logger?: Logger,
): RenameOptResult {
	if (remoteRenamePairs.length === 0) return { actions, applied: [], skipped: [] };

	const byPath = new Map<string, SyncAction>();
	for (const a of actions) byPath.set(a.path, a);

	const consumed = new Set<string>();
	const renamed: SyncAction[] = [];
	const applied: RenamePair[] = [];
	const skipped: RenameOptResult["skipped"] = [];

	for (const { oldPath, newPath } of remoteRenamePairs) {
		const del = byPath.get(oldPath);
		const pull = byPath.get(newPath);
		if (del?.action !== "delete_local" || pull?.action !== "pull") {
			skipped.push({ pair: { oldPath, newPath }, reason: "action_type_mismatch" });
			logger?.debug("Remote rename optimization skipped", {
				newPath, oldPath, reason: "action_type_mismatch",
				delAction: del?.action,
				pullAction: pull?.action,
			});
			continue;
		}
		renamed.push({
			path: newPath,
			action: "rename_local",
			oldPath,
			local: del.local,
			remote: pull.remote,
			baseline: del.baseline,
		});
		consumed.add(oldPath);
		consumed.add(newPath);
		applied.push({ oldPath, newPath });
	}

	if (consumed.size === 0) return { actions, applied, skipped };

	return { actions: replaceConsumed(actions, consumed, renamed), applied, skipped };
}

/**
 * Coalesce individual remote file renames into a single folder rename action
 * when the remote rename pair is flagged as a folder rename.
 *
 * Remote rename info is authoritative — no hash verification needed.
 * Scans actions directly for delete_local+pull pairs matching the folder
 * prefix, since incremental-sync only reports the folder-level rename pair
 * (individual file pairs are reported as separate changes, not rename pairs).
 *
 * Trusts remote backend's rename detection (no hash verification).
 */
export function coalesceRemoteFolderRenames(
	actions: SyncAction[],
	remoteRenamePairs: RenamePair[],
	logger?: Logger,
): RemoteFolderRenameOptResult {
	const folderPairs = remoteRenamePairs.filter((p) => p.isFolder);
	if (folderPairs.length === 0) {
		logger?.debug("Remote folder coalesce: no isFolder pairs", {
			pairs: remoteRenamePairs.map((p) => ({ old: p.oldPath, new: p.newPath, isFolder: p.isFolder })),
		});
		return { actions, remainingPairs: remoteRenamePairs, applied: [], skipped: [] };
	}

	const filePairs = remoteRenamePairs.filter((p) => !p.isFolder);
	const byPath = new Map<string, SyncAction>();
	for (const a of actions) byPath.set(a.path, a);

	const consumed = new Set<string>();
	const folderRenames: SyncAction[] = [];
	const applied: RemoteFolderRenameOptResult["applied"] = [];
	const skipped: RemoteFolderRenameOptResult["skipped"] = [];

	for (const { oldPath: oldFolder, newPath: newFolder } of folderPairs) {
		const oldPrefix = oldFolder + "/";
		const newPrefix = newFolder + "/";
		const descendants: RenamePair[] = [];

		for (const a of actions) {
			if (a.action !== "delete_local" || !a.path.startsWith(oldPrefix)) continue;
			const suffix = a.path.substring(oldPrefix.length);
			const newPath = newPrefix + suffix;
			const pull = byPath.get(newPath);
			if (pull?.action !== "pull") continue;
			descendants.push({ oldPath: a.path, newPath });
		}

		if (descendants.length === 0) {
			skipped.push({ pair: { oldPath: oldFolder, newPath: newFolder, isFolder: true }, reason: "no_descendants" });
			const deleteLocals = actions.filter((a) => a.action === "delete_local" && a.path.startsWith(oldPrefix));
			logger?.debug("Remote folder coalesce: no descendants", {
				oldFolder, newFolder,
				deleteLocalCount: deleteLocals.length,
				deleteLocalPaths: deleteLocals.map((a) => a.path),
				actionTypes: [...new Set(actions.map((a) => a.action))],
			});
			continue;
		}

		for (const { oldPath, newPath } of descendants) {
			consumed.add(oldPath);
			consumed.add(newPath);
		}

		folderRenames.push({
			path: newFolder,
			action: "rename_local",
			oldPath: oldFolder,
			isFolder: true,
			descendants,
		});
		applied.push({ oldPath: oldFolder, newPath: newFolder, isFolder: true });
		logger?.debug("Remote folder rename coalesced", { oldFolder, newFolder, descendants: descendants.length });
	}

	if (consumed.size === 0) {
		return { actions, remainingPairs: remoteRenamePairs, applied, skipped };
	}

	const remainingPairs = filePairs.filter((p) => !consumed.has(p.oldPath) && !consumed.has(p.newPath));
	return {
		actions: replaceConsumed(actions, consumed, folderRenames),
		remainingPairs,
		applied,
		skipped,
	};
}
