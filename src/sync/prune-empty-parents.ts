import type { IFileSystem } from "../fs/interface";
import type { Logger } from "../logging/logger";
import { toError } from "../backend-api/error-classification";
import type { SyncAction } from "./types";

/**
 * The inputs of one cycle's empty-parent cleanup: the filesystems it may mutate and
 * the logger. No store, cursor, or sync state — this pass reads only current directory
 * occupancy and persists nothing.
 */
export interface EmptyParentPruneContext {
	readonly localFs: IFileSystem;
	readonly remoteFs: IFileSystem;
	readonly logger?: Logger;
}

/**
 * Delete the directories this cycle's admitted removals emptied, on the side that
 * received the opposite-side change.
 *
 * It runs once after every serial removal, over the union of the succeeded actions'
 * admitted `pruneEmptyAncestors` chains, keyed by side and directory, so each candidate
 * directory is read at most once per cycle. Emptiness is proven from current facts
 * through `hasChildren`; a directory with any child — in scope, ignored, dot-prefixed,
 * or otherwise — is kept, and its ancestors are skipped unread because each necessarily
 * contains it. An unreadable or undeletable directory is kept, logged, and never fails
 * the cycle. Nothing is persisted.
 */
export async function pruneEmptiedDirectories(
	completed: readonly { readonly action: SyncAction }[],
	ctx: EmptyParentPruneContext,
): Promise<void> {
	const candidates = new Map<string, { side: "local" | "remote"; directory: string }>();
	for (const { action } of completed) {
		const chain = action.pruneEmptyAncestors;
		if (!chain || chain.length === 0) continue;
		const side = action.action === "delete_local" || action.action === "rename_local"
			? "local" : "remote";
		for (const directory of chain) candidates.set(`${side}\0${directory}`, { side, directory });
	}
	if (candidates.size === 0) return;
	const blocked = new Set<string>();
	// A strict ancestor is always the shorter path, so descending length orders every
	// descendant before its ancestors and lets a deleted directory expose its parent.
	const deepestFirst = [...candidates.entries()]
		.sort(([, left], [, right]) => right.directory.length - left.directory.length);
	for (const [key, { side, directory }] of deepestFirst) {
		if (blocked.has(key)) continue;
		const fs = side === "local" ? ctx.localFs : ctx.remoteFs;
		let occupied: boolean;
		try {
			occupied = await fs.hasChildren(directory);
		} catch (err) {
			blockPruneAncestors(candidates, blocked, side, directory);
			ctx.logger?.warn("executePlan: prune occupancy check failed", {
				path: directory, side, error: toError(err).message,
			});
			continue;
		}
		if (occupied) {
			blockPruneAncestors(candidates, blocked, side, directory);
			continue;
		}
		try {
			await fs.delete(directory);
		} catch (err) {
			blockPruneAncestors(candidates, blocked, side, directory);
			ctx.logger?.warn("executePlan: prune directory delete failed", {
				path: directory, side, error: toError(err).message,
			});
		}
	}
}

/** A kept directory proves every strict ancestor occupied; skip those reads. */
function blockPruneAncestors(
	candidates: ReadonlyMap<string, { side: "local" | "remote"; directory: string }>,
	blocked: Set<string>,
	side: "local" | "remote",
	directory: string,
): void {
	let separator = directory.lastIndexOf("/");
	while (separator > 0) {
		const ancestor = directory.slice(0, separator);
		const key = `${side}\0${ancestor}`;
		if (candidates.has(key)) blocked.add(key);
		separator = ancestor.lastIndexOf("/");
	}
}
