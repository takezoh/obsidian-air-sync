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
 * Pure pipeline stage: apply rename optimizations and recompute safety check.
 */
export function refinePlan(
	plan: SyncPlan,
	localRenamePairs: ReadonlyMap<string, string>,
	remoteRenamePairs: RenamePair[],
	logger?: Logger,
): SyncPlan {
	let actions = plan.actions;

	if (localRenamePairs.size > 0) {
		logger?.debug("Local rename pairs", {
			pairs: [...localRenamePairs.entries()].map(([n, o]) => `${o} → ${n}`),
		});
		actions = optimizeRenames(actions, localRenamePairs, logger);
	}

	if (remoteRenamePairs.length > 0) {
		logger?.debug("Remote rename pairs", {
			pairs: remoteRenamePairs.map(({ oldPath, newPath }) => `${oldPath} → ${newPath}`),
		});
		actions = optimizeRemoteRenames(actions, remoteRenamePairs, logger);
	}

	if (actions === plan.actions) return plan;
	return { actions, safetyCheck: checkSafety(actions) };
}
