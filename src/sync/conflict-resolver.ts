import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { ConflictStrategy, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";
import { resolveWithStrategy, type ConflictResolutionResult } from "./conflict";

export interface ConflictResolverContext {
	path: string;
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	local?: FileEntity;
	remote?: FileEntity;
	baseline?: SyncRecord;
	stateStore?: SyncStateStore;
	logger?: Logger;
}

export type { ConflictResolutionResult };

/**
 * Resolve a conflict using the configured strategy.
 *
 * auto_merge fallback chain:
 *   text file + base content → 3-way merge → success: write merged to both sides
 *                                           → fail: keep newer
 *   else → keep newer
 *   keep newer: mtime comparable → newer wins, older saved as .conflict backup
 *               else → duplicate
 *   duplicate: save remote as .conflict file, keep local at original path
 */
export async function resolveConflict(
	ctx: ConflictResolverContext,
	strategy: ConflictStrategy,
): Promise<ConflictResolutionResult> {
	switch (strategy) {
		case "auto_merge":
			return resolveAutoMerge(ctx);
		case "duplicate":
			return resolveWithStrategy(
				{
					path: ctx.path,
					localFs: ctx.localFs,
					remoteFs: ctx.remoteFs,
					local: ctx.local,
					remote: ctx.remote,
					prevSync: ctx.baseline,
					stateStore: ctx.stateStore,
					logger: ctx.logger,
				},
				"duplicate",
			);
	}
}

async function resolveAutoMerge(
	ctx: ConflictResolverContext,
): Promise<ConflictResolutionResult> {
	const { path, localFs, remoteFs, local, remote, baseline, stateStore, logger } = ctx;

	const conflictCtx = {
		path,
		localFs,
		remoteFs,
		local,
		remote,
		prevSync: baseline,
		stateStore,
		logger,
	};

	// Try 3-way merge if we have everything needed; newer-wins is the fallback
	if (local && remote && baseline && stateStore) {
		return resolveWithStrategy(conflictCtx, "auto_merge", "keep_newer");
	}

	return resolveWithStrategy(conflictCtx, "keep_newer");
}
