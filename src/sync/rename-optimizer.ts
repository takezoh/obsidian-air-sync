import type { SyncAction, SyncPlan } from "./types";
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
 * Pure pipeline stage: apply rename optimization and recompute safety check.
 */
export function refinePlan(
	plan: SyncPlan,
	renamePairs: ReadonlyMap<string, string>,
	logger?: Logger,
): SyncPlan {
	if (renamePairs.size === 0) return plan;
	logger?.debug("Rename pairs", {
		pairs: [...renamePairs.entries()].map(([n, o]) => `${o} → ${n}`),
	});
	const optimized = optimizeRenames(plan.actions, renamePairs, logger);
	return { actions: optimized, safetyCheck: checkSafety(optimized) };
}
