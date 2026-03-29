import type { RenamePair, SyncAction, SyncPlan } from "./types";
import type { Logger } from "../logging/logger";
import { checkSafety } from "./safety-check";

/**
 * Replace matching `delete_remote(oldPath) + push(newPath)` pairs
 * with a single `rename_remote` action when the content hash is unchanged.
 */
export function optimizeRenames(
	actions: SyncAction[],
	renamePairs: ReadonlyMap<string, string>,
	logger?: Logger,
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
			logger?.debug("Rename optimization skipped", {
				newPath,
				oldPath,
				delAction: del?.action,
				pushAction: push?.action,
				baselineHash: del?.baseline?.hash ? `${del.baseline.hash.substring(0, 8)}...` : "(empty)",
				localHash: push?.local?.hash ? `${push.local.hash.substring(0, 8)}...` : "(empty)",
			});
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

/**
 * Replace matching `delete_local(oldPath) + pull(newPath)` pairs
 * with a single `rename_local` action using remote rename pair info.
 */
export function optimizeRemoteRenames(
	actions: SyncAction[],
	remoteRenamePairs: RenamePair[],
	logger?: Logger,
): SyncAction[] {
	if (remoteRenamePairs.length === 0) return actions;

	const byPath = new Map<string, SyncAction>();
	for (const a of actions) byPath.set(a.path, a);

	const consumed = new Set<string>();
	const renamed: SyncAction[] = [];

	for (const { oldPath, newPath } of remoteRenamePairs) {
		const del = byPath.get(oldPath);
		const pull = byPath.get(newPath);
		if (
			del?.action !== "delete_local" ||
			pull?.action !== "pull"
		) {
			logger?.debug("Remote rename optimization skipped", {
				newPath, oldPath,
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
	}

	if (consumed.size === 0) return actions;

	const result: SyncAction[] = [];
	for (const a of actions) {
		if (!consumed.has(a.path)) result.push(a);
	}
	return result.concat(renamed);
}

/**
 * Coalesce individual file renames into a single folder rename action
 * when a folder rename is detected from Obsidian events.
 *
 * Only coalesces when ALL descendant file renames have matching hashes
 * (pure renames with no content changes).
 */
export function coalesceFolderRenames(
	actions: SyncAction[],
	folderRenamePairs: ReadonlyMap<string, string>,
	fileRenamePairs: ReadonlyMap<string, string>,
	logger?: Logger,
): { actions: SyncAction[]; remainingFileRenames: ReadonlyMap<string, string> } {
	if (folderRenamePairs.size === 0) return { actions, remainingFileRenames: fileRenamePairs };

	const byPath = new Map<string, SyncAction>();
	for (const a of actions) byPath.set(a.path, a);

	const consumed = new Set<string>();
	const consumedFileRenames = new Set<string>();
	const folderRenames: SyncAction[] = [];

	for (const [newFolder, oldFolder] of folderRenamePairs) {
		const oldPrefix = oldFolder + "/";
		const newPrefix = newFolder + "/";

		const descendants: RenamePair[] = [];
		let allHashesMatch = true;

		for (const [newFile, oldFile] of fileRenamePairs) {
			if (!oldFile.startsWith(oldPrefix) || !newFile.startsWith(newPrefix)) continue;
			const suffix = oldFile.substring(oldPrefix.length);
			if (newFile !== newPrefix + suffix) continue;

			const del = byPath.get(oldFile);
			const push = byPath.get(newFile);
			if (del?.action !== "delete_remote" || push?.action !== "push") {
				logger?.debug("Folder rename: action type mismatch", {
					oldFile, newFile, delAction: del?.action, pushAction: push?.action,
				});
				allHashesMatch = false;
				break;
			}
			if (!del.baseline?.hash || !push.local?.hash || push.local.hash !== del.baseline.hash) {
				logger?.debug("Folder rename: hash mismatch", {
					oldFile, newFile,
					baselineHash: del.baseline?.hash ? `${del.baseline.hash.substring(0, 8)}...` : "(empty)",
					localHash: push.local?.hash ? `${push.local.hash.substring(0, 8)}...` : "(empty)",
				});
				allHashesMatch = false;
				break;
			}
			descendants.push({ oldPath: oldFile, newPath: newFile });
		}

		if (!allHashesMatch || descendants.length === 0) {
			logger?.debug("Folder rename coalescing skipped", { oldFolder, newFolder, descendants: descendants.length, allHashesMatch });
			continue;
		}

		for (const { oldPath, newPath } of descendants) {
			consumed.add(oldPath);
			consumed.add(newPath);
			consumedFileRenames.add(newPath);
		}

		folderRenames.push({
			path: newFolder,
			action: "rename_remote",
			oldPath: oldFolder,
			isFolder: true,
			descendants,
		});
		logger?.debug("Folder rename coalesced", { oldFolder, newFolder, descendants: descendants.length });
	}

	if (consumed.size === 0) return { actions, remainingFileRenames: fileRenamePairs };

	const result: SyncAction[] = [];
	for (const a of actions) {
		if (!consumed.has(a.path)) result.push(a);
	}

	const remaining = new Map<string, string>();
	for (const [newPath, oldPath] of fileRenamePairs) {
		if (!consumedFileRenames.has(newPath)) remaining.set(newPath, oldPath);
	}

	return { actions: result.concat(folderRenames), remainingFileRenames: remaining };
}

/**
 * Coalesce individual remote file renames into a single folder rename action
 * when the remote rename pair is flagged as a folder rename.
 *
 * Remote rename info is authoritative — no hash verification needed.
 * Scans actions directly for delete_local+pull pairs matching the folder
 * prefix, since incremental-sync only reports the folder-level rename pair
 * (individual file pairs are reported as separate changes, not rename pairs).
 */
export function coalesceRemoteFolderRenames(
	actions: SyncAction[],
	remoteRenamePairs: RenamePair[],
	logger?: Logger,
): { actions: SyncAction[]; remainingPairs: RenamePair[] } {
	const folderPairs = remoteRenamePairs.filter((p) => p.isFolder);
	if (folderPairs.length === 0) {
		logger?.debug("Remote folder coalesce: no isFolder pairs", {
			pairs: remoteRenamePairs.map((p) => ({ old: p.oldPath, new: p.newPath, isFolder: p.isFolder })),
		});
		return { actions, remainingPairs: remoteRenamePairs };
	}

	const filePairs = remoteRenamePairs.filter((p) => !p.isFolder);
	const byPath = new Map<string, SyncAction>();
	for (const a of actions) byPath.set(a.path, a);

	const consumed = new Set<string>();
	const folderRenames: SyncAction[] = [];

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
		logger?.debug("Remote folder rename coalesced", { oldFolder, newFolder, descendants: descendants.length });
	}

	if (consumed.size === 0) return { actions, remainingPairs: remoteRenamePairs };

	const result: SyncAction[] = [];
	for (const a of actions) {
		if (!consumed.has(a.path)) result.push(a);
	}

	const remainingPairs = filePairs.filter((p) => !consumed.has(p.oldPath) && !consumed.has(p.newPath));
	return { actions: result.concat(folderRenames), remainingPairs };
}

/**
 * Pure pipeline stage: apply rename optimizations and recompute safety check.
 */
export function refinePlan(
	plan: SyncPlan,
	localRenamePairs: ReadonlyMap<string, string>,
	localFolderRenamePairs: ReadonlyMap<string, string>,
	remoteRenamePairs: RenamePair[],
	logger?: Logger,
): SyncPlan {
	let actions = plan.actions;

	if (localFolderRenamePairs.size > 0) {
		logger?.debug("Local folder rename pairs", {
			pairs: [...localFolderRenamePairs.entries()].map(([n, o]) => `${o} → ${n}`),
		});
		const result = coalesceFolderRenames(actions, localFolderRenamePairs, localRenamePairs, logger);
		actions = result.actions;
		if (result.remainingFileRenames.size > 0) {
			logger?.debug("Local rename pairs (remaining)", {
				pairs: [...result.remainingFileRenames.entries()].map(([n, o]) => `${o} → ${n}`),
			});
			actions = optimizeRenames(actions, result.remainingFileRenames, logger);
		}
	} else if (localRenamePairs.size > 0) {
		logger?.debug("Local rename pairs", {
			pairs: [...localRenamePairs.entries()].map(([n, o]) => `${o} → ${n}`),
		});
		actions = optimizeRenames(actions, localRenamePairs, logger);
	}

	if (remoteRenamePairs.length > 0) {
		logger?.debug("Remote rename pairs", {
			pairs: remoteRenamePairs.map(({ oldPath, newPath }) => `${oldPath} → ${newPath}`),
		});
		const result = coalesceRemoteFolderRenames(actions, remoteRenamePairs, logger);
		actions = result.actions;
		if (result.remainingPairs.length > 0) {
			actions = optimizeRemoteRenames(actions, result.remainingPairs, logger);
		}
	}

	if (actions === plan.actions) return plan;
	return { actions, safetyCheck: checkSafety(actions) };
}
