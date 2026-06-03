import type { RenamePair, SyncAction } from "./types";
import type {
	RenameOptResult,
	RemoteFolderRenameOptResult,
} from "./rename-optimizer-types";
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
	if (remoteRenamePairs.length === 0)
		return { actions, applied: [], skipped: [] };

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
			skipped.push({
				pair: { oldPath, newPath },
				reason: "action_type_mismatch",
			});
			logger?.debug("Remote rename optimization skipped", {
				newPath,
				oldPath,
				reason: "action_type_mismatch",
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

	return {
		actions: replaceConsumed(actions, consumed, renamed),
		applied,
		skipped,
	};
}

/**
 * Coalesce remote file renames into a single folder rename action
 * when the remote rename pair is flagged as a folder rename.
 *
 * Remote rename info is authoritative — no hash verification needed.
 * Scans actions directly for `delete_local` children under the folder
 * prefix, since incremental-sync only reports the folder-level rename pair
 * (individual file pairs are reported as separate changes, not rename pairs).
 *
 * A child whose matching `pull` is missing (the file was deleted on the
 * remote during the rename, filtered by ignore rules, or dropped by a
 * partial/paged sync) is still absorbed as a move descendant rather than
 * left behind. Leaving a standalone `delete_local` would fire it *after*
 * the folder has physically moved (A/x already lives at B/x), deleting the
 * wrong path and stranding B/x without a baseline — which a later sync
 * would resurrect with a `push`. Folding it into the rename rewrites the
 * baseline to B/x instead, so a genuine remote deletion propagates safely
 * as a `delete_local(B/x)` on the next cycle. Bias toward safe deletion:
 * never leave a dangling delete under a renamed folder.
 *
 * Destination occupancy is the opposite case and is handled differently.
 * `rename_local` moves the whole folder via `localFs.rename(A→B)`, which
 * throws "Destination already exists" when B/ already holds a local file
 * (LocalFs.rename, src/fs/local/index.ts:198). We detect this best-effort:
 * any action under the new prefix that carries a local entity (`a.local`)
 * proves a local file physically exists under B/, so the move would collide.
 * Note this is the action's local side, not its type — a no-baseline `pull`
 * (the normal rename counterpart) has no local side, but a baseline `pull`
 * for a path that already exists locally DOES, and correctly counts as
 * occupancy (decision-engine attaches `local` whenever a local entity
 * exists, regardless of action type).
 *
 * Why skip rather than coalesce: the optimization's whole value is replacing
 * N delete+pull pairs with one atomic `localFs.rename` of the folder, but
 * that single move is exactly what collides with an occupied destination —
 * there is no partial folder rename, so the optimization cannot apply at all
 * here. We therefore drop back to the unoptimized plan: the decision engine's
 * per-file `delete_local`/`pull`/`push`/`conflict` actions never move the
 * folder as a unit — each path is created/deleted independently — so no
 * destination collision occurs and the folder converges file-by-file (over
 * one or two cycles). Skipping is strictly the honest non-optimized behavior,
 * not a workaround.
 *
 * Why the split — a missing pull is absorbed but an occupied destination is
 * skipped: a missing pull means B/ stays empty (no collision), whereas an
 * occupied destination means B/ already has local content (collision). The
 * original `pull`-match guard lumped both together and excluded them alike,
 * which is exactly what produced the dangling delete; separating "absent"
 * from "occupied" is the correct fix.
 *
 * Limits of the best-effort check: occupancy is only visible when B/ holds a
 * file that produced an action this cycle. An in-sync file (local == remote
 * == baseline) or a pre-existing empty/ignored folder under B/ yields no
 * action, so the move is still attempted and `localFs.rename` throws; that
 * failure is caught per-action (plan-executor) and recovers next cycle once
 * the rename pair has drained. Also, in the occupancy-skip branch the
 * dangling-absorption above does NOT apply, so a child whose pull is missing
 * only because of an asymmetric ignore rule is deleted locally rather than
 * moved — its content still lives on the remote (it was ignore-filtered), so
 * this is a visible local removal, not data loss.
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
			pairs: remoteRenamePairs.map((p) => ({
				old: p.oldPath,
				new: p.newPath,
				isFolder: p.isFolder,
			})),
		});
		return {
			actions,
			remainingPairs: remoteRenamePairs,
			applied: [],
			skipped: [],
		};
	}

	const filePairs = remoteRenamePairs.filter((p) => !p.isFolder);

	const consumed = new Set<string>();
	const folderRenames: SyncAction[] = [];
	const applied: RemoteFolderRenameOptResult["applied"] = [];
	const skipped: RemoteFolderRenameOptResult["skipped"] = [];

	for (const { oldPath: oldFolder, newPath: newFolder } of folderPairs) {
		const oldPrefix = oldFolder + "/";
		const newPrefix = newFolder + "/";

		// Destination occupancy (checked before building descendants — if B/ is
		// occupied we skip without the wasted scan): a folder rename_local moves
		// the whole folder via localFs.rename(A→B), which throws when B/ already
		// holds a local file. Any action under newPrefix that carries a local
		// entity proves B/ is occupied (best-effort — see the doc comment).
		const destinationOccupied = actions.some(
			(a) => a.path.startsWith(newPrefix) && a.local != null,
		);
		if (destinationOccupied) {
			skipped.push({
				pair: {
					oldPath: oldFolder,
					newPath: newFolder,
					isFolder: true,
				},
				reason: "destination_occupied",
			});
			logger?.debug("Remote folder coalesce: destination occupied", {
				oldFolder,
				newFolder,
			});
			continue;
		}

		const descendants: RenamePair[] = [];
		for (const a of actions) {
			if (a.action !== "delete_local" || !a.path.startsWith(oldPrefix))
				continue;
			const suffix = a.path.substring(oldPrefix.length);
			const newPath = newPrefix + suffix;
			descendants.push({ oldPath: a.path, newPath });
		}

		if (descendants.length === 0) {
			skipped.push({
				pair: {
					oldPath: oldFolder,
					newPath: newFolder,
					isFolder: true,
				},
				reason: "no_descendants",
			});
			const deleteLocals = actions.filter(
				(a) =>
					a.action === "delete_local" && a.path.startsWith(oldPrefix),
			);
			logger?.debug("Remote folder coalesce: no descendants", {
				oldFolder,
				newFolder,
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
		applied.push({
			oldPath: oldFolder,
			newPath: newFolder,
			isFolder: true,
		});
		logger?.debug("Remote folder rename coalesced", {
			oldFolder,
			newFolder,
			descendants: descendants.length,
		});
	}

	if (consumed.size === 0) {
		return { actions, remainingPairs: remoteRenamePairs, applied, skipped };
	}

	const remainingPairs = filePairs.filter(
		(p) => !consumed.has(p.oldPath) && !consumed.has(p.newPath),
	);
	return {
		actions: replaceConsumed(actions, consumed, folderRenames),
		remainingPairs,
		applied,
		skipped,
	};
}
