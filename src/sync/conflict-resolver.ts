import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { ConflictStrategy, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";
import { resolveWithStrategy, type ConflictResolutionResult } from "./conflict";
import { contentKey, sameContent } from "./content-identity";

export interface ConflictResolverContext {
	path: string;
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	local?: FileEntity;
	remote?: FileEntity;
	baseline?: SyncRecord;
	localPath?: string;
	remotePath?: string;
	remoteIdentitySource?: FileEntity;
	baselinePath?: string;
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
 *   keep newer: mtime comparable → newer wins (older side overwritten, no backup)
 *               equal/unknown mtime → identical content keeps local, else duplicate
 *   duplicate: save remote as .conflict file, keep local at original path
 */
export async function resolveConflict(
	ctx: ConflictResolverContext,
	strategy: ConflictStrategy,
): Promise<ConflictResolutionResult> {
	let result: ConflictResolutionResult;
	switch (strategy) {
		case "auto_merge":
			result = await resolveAutoMerge(ctx);
			break;
		case "duplicate":
			result = await resolveWithStrategy(
				{
					path: ctx.path,
					localFs: ctx.localFs,
					remoteFs: ctx.remoteFs,
					local: ctx.local,
					remote: ctx.remote,
					prevSync: ctx.baseline,
					stateStore: ctx.stateStore,
					logger: ctx.logger,
					localPath: ctx.localPath,
					remotePath: ctx.remotePath,
					baselinePath: ctx.baselinePath,
				},
				"duplicate",
			);
			break;
	}
	if (ctx.remoteIdentitySource && ctx.remoteIdentitySource.path !== ctx.path) {
		await rotateRemoteIdentityToTarget(ctx);
	} else if (ctx.remotePath && ctx.remotePath !== ctx.path) {
		await ctx.remoteFs.delete(ctx.remotePath);
	}
	return result;
}

async function rotateRemoteIdentityToTarget(ctx: ConflictResolverContext): Promise<void> {
	const source = ctx.remoteIdentitySource!;
	const sourceNow = await ctx.remoteFs.stat(source.path);
	if (!sourceNow || sourceNow.identityKey !== source.identityKey ||
		!sameRemoteVersion(sourceNow, source)) {
		throw new Error(`Remote identity source changed during conflict resolution: ${source.path}`);
	}
	const content = await ctx.localFs.read(ctx.path);
	const local = await ctx.localFs.stat(ctx.path);
	await ctx.remoteFs.delete(ctx.path);
	await ctx.remoteFs.rename(source.path, ctx.path);
	await ctx.remoteFs.write(ctx.path, content, local?.mtime ?? ctx.local?.mtime ?? 0);
}

function sameRemoteVersion(current: FileEntity, observed: FileEntity): boolean {
	const currentKey = contentKey(current);
	const observedKey = contentKey(observed);
	if (currentKey || observedKey) return sameContent(current, observed);
	return current.size === observed.size && current.mtime > 0 && current.mtime === observed.mtime;
}

async function resolveAutoMerge(
	ctx: ConflictResolverContext,
): Promise<ConflictResolutionResult> {
	const { path, localFs, remoteFs, local, remote, baseline, stateStore, logger,
		localPath, remotePath, baselinePath } = ctx;

	const conflictCtx = {
		path,
		localFs,
		remoteFs,
		local,
		remote,
		prevSync: baseline,
		stateStore,
		logger,
		localPath,
		remotePath,
		baselinePath,
	};

	// attemptThreeWayMerge already handles every missing-prerequisite case — a deleted
	// side, no baseline, or no stored base content — by falling back to keep_newer, so
	// no pre-check is needed here.
	return resolveWithStrategy(conflictCtx, "auto_merge", "keep_newer");
}
