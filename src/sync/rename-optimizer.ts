import type { RenamePair, SyncAction, SyncPlan } from "./types";
import type { Logger } from "../logging/logger";
import { checkSafety } from "./safety-check";
import { optimizeLocalFileRenames, coalesceLocalFolderRenames } from "./optimize-local-renames";
import { optimizeRemoteFileRenames, coalesceRemoteFolderRenames } from "./optimize-remote-renames";

/** Filter out consumed actions and append replacements. */
export function replaceConsumed(
	actions: SyncAction[],
	consumed: ReadonlySet<string>,
	replacements: SyncAction[],
): SyncAction[] {
	return actions.filter((a) => !consumed.has(a.path)).concat(replacements);
}

/**
 * Pure pipeline stage: apply rename optimizations and recompute safety check.
 *
 * Local renames are processed first — they require hash verification
 * to prove the rename is content-preserving.
 * Remote renames are processed second — they are authoritative from
 * the backend and require no hash verification.
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
		const result = coalesceLocalFolderRenames(actions, localFolderRenamePairs, localRenamePairs, logger);
		actions = result.actions;
		if (result.remainingFileRenames.size > 0) {
			logger?.debug("Local rename pairs (remaining)", {
				pairs: [...result.remainingFileRenames.entries()].map(([n, o]) => `${o} → ${n}`),
			});
			actions = optimizeLocalFileRenames(actions, result.remainingFileRenames, logger).actions;
		}
	} else if (localRenamePairs.size > 0) {
		logger?.debug("Local rename pairs", {
			pairs: [...localRenamePairs.entries()].map(([n, o]) => `${o} → ${n}`),
		});
		actions = optimizeLocalFileRenames(actions, localRenamePairs, logger).actions;
	}

	if (remoteRenamePairs.length > 0) {
		logger?.debug("Remote rename pairs", {
			pairs: remoteRenamePairs.map(({ oldPath, newPath }) => `${oldPath} → ${newPath}`),
		});
		const result = coalesceRemoteFolderRenames(actions, remoteRenamePairs, logger);
		actions = result.actions;
		if (result.remainingPairs.length > 0) {
			actions = optimizeRemoteFileRenames(actions, result.remainingPairs, logger).actions;
		}
	}

	if (actions === plan.actions) return plan;
	return { actions, safetyCheck: checkSafety(actions) };
}
