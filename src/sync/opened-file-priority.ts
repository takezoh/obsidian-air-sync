import type { IFileSystem } from "../fs/interface";
import type { Logger } from "../logging/logger";
import { hasChanged, hasRemoteChanged } from "./change-compare";
import type { LocalChangeTracker } from "./local-tracker";
import type { LocalMutationBarrier } from "./local-mutation-barrier";
import type { PriorityBatchTarget } from "./priority-batch-state";
import type { SyncStateStore } from "./state";
import { buildSyncRecord } from "./state-committer";
import type { SyncAction } from "./types";

export type OpenedFilePriorityResult =
	| "applied"
	| "already_current"
	| "deferred_to_batch"
	| "failed_retryable";

interface OpenedFilePriorityContext {
	path: string;
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	stateStore: SyncStateStore;
	localTracker: LocalChangeTracker;
	mutationBarrier: LocalMutationBarrier;
	target: PriorityBatchTarget;
	supersede(action: SyncAction): boolean;
	invalidate(action: SyncAction): boolean;
	invalidateCycle(): void;
	requestNormalLifecycle(): void;
	logger?: Logger;
}

/** One pull-only file-open operation. Provider facts and batch policy are supplied by their owners. */
export async function syncOpenedFilePriority(
	ctx: OpenedFilePriorityContext,
): Promise<OpenedFilePriorityResult> {
	if (ctx.target.kind === "defer" || !ctx.remoteFs.priority) return deferToBatch(ctx);
	const expectedRecord = await ctx.stateStore.get(ctx.path);
	if (!expectedRecord?.remoteIdentityKey) return deferToBatch(ctx);
	const expectedGeneration = ctx.localTracker.generation(ctx.path);

	try {
		const [localBefore, observed] = await Promise.all([
			ctx.localFs.stat(ctx.path),
			ctx.remoteFs.priority.observe({
				path: ctx.path,
				identityKey: expectedRecord.remoteIdentityKey,
			}),
		]);
		if (!localBefore || localBefore.isDirectory || hasChanged(localBefore, expectedRecord)) {
			invalidateTarget(ctx);
			return "deferred_to_batch";
		}
		if (observed.kind !== "current" || observed.entity.isDirectory) {
			invalidateTarget(ctx);
			return "deferred_to_batch";
		}

		if (!hasRemoteChanged(observed.entity, expectedRecord)) {
			const currentRecord = buildSyncRecord(localBefore, observed.entity, ctx.path);
			if (!await ctx.stateStore.compareAndPut(expectedRecord, currentRecord)) {
				invalidateTarget(ctx);
				return "deferred_to_batch";
			}
			return supersedeTarget(ctx) ? "already_current" : deferToBatch(ctx);
		}

		const read = await ctx.remoteFs.priority.read(observed);
		if (read.kind !== "content") {
			invalidateTarget(ctx);
			return "deferred_to_batch";
		}

		return ctx.mutationBarrier.run([ctx.path], async () => {
			const [currentRecord, localNow] = await Promise.all([
				ctx.stateStore.get(ctx.path),
				ctx.localFs.stat(ctx.path),
			]);
			if (JSON.stringify(currentRecord) !== JSON.stringify(expectedRecord) ||
				ctx.localTracker.generation(ctx.path) !== expectedGeneration ||
				!localNow || localNow.isDirectory || hasChanged(localNow, expectedRecord)) {
				invalidateTarget(ctx);
				return "deferred_to_batch";
			}

			const localEntity = await ctx.localFs.write(ctx.path, read.content, observed.entity.mtime);
			const nextRecord = buildSyncRecord(localEntity, observed.entity, ctx.path);
			let baselined = false;
			try {
				baselined = await ctx.stateStore.compareAndPut(expectedRecord, nextRecord);
			} catch (error) {
				ctx.logger?.warn("file-open priority baseline commit failed", {
					path: ctx.path,
					message: error instanceof Error ? error.message : String(error),
				});
			}
			if (!baselined) {
				ctx.localTracker.markDirty(ctx.path);
				invalidateTarget(ctx);
				return "deferred_to_batch";
			}

			if (!supersedeTarget(ctx)) {
				ctx.localTracker.markDirty(ctx.path);
				ctx.invalidateCycle();
				return deferToBatch(ctx);
			}
			const postGeneration = ctx.localTracker.generation(ctx.path);
			const localAfter = await ctx.localFs.stat(ctx.path);
			if (localAfter && !hasChanged(localAfter, nextRecord)) {
				ctx.localTracker.acknowledgePath(ctx.path, postGeneration);
			}
			return "applied";
		});
	} catch (error) {
		ctx.logger?.warn("file-open priority attempt failed", {
			path: ctx.path,
			message: error instanceof Error ? error.message : String(error),
		});
		ctx.requestNormalLifecycle();
		return "failed_retryable";
	}
}

function supersedeTarget(ctx: OpenedFilePriorityContext): boolean {
	return ctx.target.kind !== "superseding" || ctx.supersede(ctx.target.action);
}

function invalidateTarget(ctx: OpenedFilePriorityContext): void {
	if (ctx.target.kind === "superseding") ctx.invalidate(ctx.target.action);
	ctx.invalidateCycle();
	ctx.requestNormalLifecycle();
}

function deferToBatch(ctx: OpenedFilePriorityContext): "deferred_to_batch" {
	ctx.requestNormalLifecycle();
	return "deferred_to_batch";
}
