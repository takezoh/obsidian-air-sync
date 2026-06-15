import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { ConflictRecord, ConflictStrategy, SyncAction, SyncActionType, SyncPlan } from "./types";
import type { StateCommitterContext } from "./state-committer";
import type { ConflictResolverContext, ConflictResolutionResult } from "./conflict-resolver";
import type { Logger } from "../logging/logger";
import { commitAction } from "./state-committer";
import { resolveConflict } from "./conflict-resolver";
import { AuthError } from "../fs/errors";
import { AsyncPool } from "../queue/async-queue";

export interface CompletedAction {
	action: SyncAction;
	localEntity?: FileEntity;
	remoteEntity?: FileEntity;
}

export interface FailedAction {
	action: SyncAction;
	error: Error;
}

export interface ResolvedConflict {
	action: SyncAction;
	resolution: ConflictResolutionResult;
	localEntity?: FileEntity;
	remoteEntity?: FileEntity;
}

export interface ExecutionResult {
	succeeded: CompletedAction[];
	failed: FailedAction[];
	conflicts: ResolvedConflict[];
}

/**
 * Bridge resolved conflicts into audit-history records (one per resolution). Pure,
 * so the writer (ConflictHistory) stays separate from both resolution and this
 * mapping — the caller stamps a session id and timestamp and hands the records to
 * the writer once per cycle.
 */
export function toConflictRecords(
	conflicts: ResolvedConflict[],
	strategy: ConflictStrategy,
	sessionId: string,
	resolvedAt: string,
): ConflictRecord[] {
	return conflicts.map((c) => ({
		path: c.action.path,
		actionType: c.action.action,
		strategy,
		action: c.resolution.action,
		local: c.localEntity,
		remote: c.remoteEntity,
		duplicatePath: c.resolution.duplicatePath,
		hasConflictMarkers: c.resolution.hasConflictMarkers,
		resolvedAt,
		sessionId,
	}));
}

export interface ExecutionContext {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	committer: StateCommitterContext;
	conflictStrategy: ConflictStrategy;
	onProgress?: (completed: number, total: number) => void;
	logger?: Logger;
}

type Lane = "remote" | "local" | "both" | "none";
type Tier = "transfer" | "rename" | "delete" | "none";

/**
 * Executor-internal classification of each action by the filesystem it mutates
 * (`lane`) and its dependency tier (`tier`). This drives the phase/lane scheduling
 * in {@link executePlan}; `SyncActionType` stays the planner's vocabulary. The
 * `Record<SyncActionType, …>` makes the classification exhaustive — adding a new
 * action type fails the build until it is classified here.
 *
 * `conflict` is transfer-tier (content I/O) but is DELIBERATELY scheduled in its
 * own serial phase, NOT pooled with `push`/`pull`: conflict resolution mints a
 * planner-invisible `.conflict` sibling path (`conflict.ts` `generateConflictPath`)
 * and writes it to both sides, so the one-action-per-path invariant does not cover
 * that sibling. Pooling it would risk clobbering a concurrent `push` of a
 * same-named file and would wake the dormant `withCacheMutex` new-path guard. See
 * ADR 0001 (prohibited patterns). Do not move it into the transfer phase.
 */
const ACTION_CLASS: Record<SyncActionType, { lane: Lane; tier: Tier }> = {
	push: { lane: "remote", tier: "transfer" },
	pull: { lane: "local", tier: "transfer" },
	conflict: { lane: "both", tier: "transfer" },
	match: { lane: "none", tier: "none" },
	cleanup: { lane: "none", tier: "none" },
	rename_remote: { lane: "remote", tier: "rename" },
	rename_local: { lane: "local", tier: "rename" },
	delete_remote: { lane: "remote", tier: "delete" },
	delete_local: { lane: "local", tier: "delete" },
};

/** Max concurrent content transfers (push/pull) — bandwidth / rate-limit bound. */
const TRANSFER_CONCURRENCY = 5;
/**
 * Max concurrent deletes, per lane. Deletes are metadata-only (trash / delete by
 * id) and could run hotter, but they share the backend rate-limit budget, so kept
 * at 5 for parity. Each lane gets its OWN pool — local (vault trash) and remote
 * (network) deletes have disjoint resource profiles and must not share a budget.
 */
const DELETE_CONCURRENCY = 5;

/**
 * Execute a plan in three phases separated by barriers, scheduled by (lane, tier):
 *
 *   Phase 1  transfers (push/pull) pooled + state-only (match/cleanup) inline
 *   Phase 2  conflict — serial (own phase; see {@link ACTION_CLASS})
 *   Phase 3  structural — remote & local lanes run concurrently; within each lane,
 *            renames serial then deletes pooled
 *
 * The barriers are load-bearing: no content write (Phase 1) runs concurrently with
 * a same-subtree structural rename/delete (Phase 3), and conflict (which mutates a
 * planner-invisible sibling, Phase 2) never overlaps either. Renames stay serial
 * (two endpoints + folder-subtree rewrites); deletes pool (the bulk-delete win).
 * `AuthError` from any action rejects its pool/lane and propagates out (aborting the
 * cycle); all other per-action errors are caught into `result.failed`.
 */
export async function executePlan(
	plan: SyncPlan,
	ctx: ExecutionContext,
): Promise<ExecutionResult> {
	const result: ExecutionResult = {
		succeeded: [],
		failed: [],
		conflicts: [],
	};

	// Partition by (lane, tier). Conflict is its own phase; match/cleanup are
	// state-only (run inline, no pool slot); renames/deletes split by lane.
	const transfers: SyncAction[] = [];
	const stateOnly: SyncAction[] = [];
	const conflicts: SyncAction[] = [];
	const renameRemote: SyncAction[] = [];
	const deleteRemote: SyncAction[] = [];
	const renameLocal: SyncAction[] = [];
	const deleteLocal: SyncAction[] = [];

	for (const action of plan.actions) {
		const { lane, tier } = ACTION_CLASS[action.action];
		if (action.action === "conflict") {
			conflicts.push(action);
		} else if (tier === "none") {
			stateOnly.push(action);
		} else if (tier === "transfer") {
			transfers.push(action);
		} else if (tier === "rename") {
			(lane === "remote" ? renameRemote : renameLocal).push(action);
		} else {
			(lane === "remote" ? deleteRemote : deleteLocal).push(action);
		}
	}

	const total = plan.actions.length;
	let completed = 0;
	const reportProgress = () => {
		completed++;
		ctx.onProgress?.(completed, total);
	};

	// ── Phase 1 — transfers (pooled) + state-only (inline). ──
	// One action per path ⇒ concurrent transfers target disjoint paths. State-only
	// actions do no I/O, so they don't take a pool slot — they're awaited alongside.
	const transferPool = new AsyncPool(TRANSFER_CONCURRENCY);
	await Promise.all([
		...transfers.map((action) =>
			transferPool.run(() => executeAction(action, ctx, result, reportProgress))
		),
		...stateOnly.map((action) =>
			executeAction(action, ctx, result, reportProgress)
		),
	]);

	// ── Phase 2 — conflicts (serial, own phase). ──
	// Headless, but mutates a planner-invisible `.conflict` sibling — kept serial so
	// concurrent resolutions can't collide on that sibling namespace (see ACTION_CLASS).
	for (const action of conflicts) {
		await executeConflictAction(action, ctx, result, reportProgress);
	}

	// ── Phase 3 — structural mutations; the two lanes run concurrently. ──
	// They touch disjoint filesystems (the local FS has no remote metadata cache), so
	// they share no mutable state — safe to overlap. Within each lane: renames first
	// (serial — a rename has two endpoints and folder renames rewrite subtrees), then
	// deletes pooled (the bulk-folder-delete win). Each lane has its OWN delete pool.
	const runLane = async (renames: SyncAction[], deletes: SyncAction[]) => {
		for (const action of renames) {
			await executeAction(action, ctx, result, reportProgress);
		}
		const pool = new AsyncPool(DELETE_CONCURRENCY);
		await Promise.all(
			deletes.map((action) =>
				pool.run(() => executeAction(action, ctx, result, reportProgress))
			)
		);
	};
	await Promise.all([
		runLane(renameRemote, deleteRemote),
		runLane(renameLocal, deleteLocal),
	]);

	return result;
}

async function executeAction(
	action: SyncAction,
	ctx: ExecutionContext,
	result: ExecutionResult,
	reportProgress: () => void,
): Promise<void> {
	try {
		const { localEntity, remoteEntity } = await runActionIO(action, ctx);
		await commitAction(action, localEntity, remoteEntity, ctx.committer);
		result.succeeded.push({ action, localEntity, remoteEntity });
	} catch (err) {
		if (err instanceof AuthError) throw err;
		const error = err instanceof Error ? err : new Error(String(err));
		ctx.logger?.error("executePlan: action failed", {
			path: action.path,
			action: action.action,
			error: error.message,
		});
		result.failed.push({ action, error });
	} finally {
		reportProgress();
	}
}

async function runActionIO(
	action: SyncAction,
	ctx: ExecutionContext,
): Promise<{ localEntity?: FileEntity; remoteEntity?: FileEntity }> {
	const { localFs, remoteFs } = ctx;
	const { path } = action;

	switch (action.action) {
		case "push": {
			if (!action.local) throw new Error(`push action requires local entity: ${path}`);
			const content = await localFs.read(path);
			const remoteEntity = await remoteFs.write(path, content, action.local.mtime);
			// stat() may return null if the file was deleted between read and stat (race condition);
			// fall back to action.local which is the pre-sync metadata
			const localEntity = await localFs.stat(path) ?? action.local;
			return { localEntity, remoteEntity };
		}

		case "pull": {
			if (!action.remote) throw new Error(`pull action requires remote entity: ${path}`);
			const content = await remoteFs.read(path);
			const localEntity = await localFs.write(path, content, action.remote.mtime);
			// stat() may return null if the file was deleted between write and stat (race condition);
			// fall back to action.remote which is the pre-sync metadata
			const remoteEntity = await remoteFs.stat(path) ?? action.remote;
			return { localEntity, remoteEntity };
		}

		case "match": {
			return { localEntity: action.local, remoteEntity: action.remote };
		}

		case "rename_remote": {
			await remoteFs.rename(action.oldPath, path);
			const remoteEntity = await remoteFs.stat(path);
			const localEntity = await localFs.stat(path) ?? action.local;
			return { localEntity, remoteEntity: remoteEntity ?? undefined };
		}

		case "rename_local": {
			await localFs.rename(action.oldPath, path);
			const localEntity = await localFs.stat(path) ?? undefined;
			return { localEntity, remoteEntity: action.remote };
		}

		case "delete_remote": {
			await remoteFs.delete(path);
			return {};
		}

		case "delete_local": {
			await localFs.delete(path);
			return {};
		}

		case "cleanup": {
			return {};
		}

		// "conflict" is routed through executeConflictAction, not this function
		case "conflict": {
			return {};
		}
	}
}

async function executeConflictAction(
	action: SyncAction,
	ctx: ExecutionContext,
	result: ExecutionResult,
	reportProgress: () => void,
): Promise<void> {
	try {
		const conflictCtx: ConflictResolverContext = {
			path: action.path,
			localFs: ctx.localFs,
			remoteFs: ctx.remoteFs,
			local: action.local,
			remote: action.remote,
			baseline: action.baseline,
			stateStore: ctx.committer.stateStore,
			logger: ctx.logger,
		};

		const resolution = await resolveConflict(conflictCtx, ctx.conflictStrategy);

		const localEntity = await ctx.localFs.stat(action.path) ?? action.local;
		const remoteEntity = await ctx.remoteFs.stat(action.path) ?? action.remote;

		await commitAction(action, localEntity, remoteEntity, ctx.committer);

		result.conflicts.push({ action, resolution, localEntity, remoteEntity });
		result.succeeded.push({ action, localEntity, remoteEntity });
	} catch (err) {
		if (err instanceof AuthError) throw err;
		const error = err instanceof Error ? err : new Error(String(err));
		ctx.logger?.error("executePlan: conflict action failed", {
			path: action.path,
			error: error.message,
		});
		result.failed.push({ action, error });
	} finally {
		reportProgress();
	}
}
