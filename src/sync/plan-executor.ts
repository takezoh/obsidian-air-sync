import type { IFileSystem } from "../fs/interface";
import type { ConflictStrategy, SyncAction } from "./types";
import { memberObligationFor } from "./plan-authority";
import type { AuthorizedMemberObligation, AuthorizedSyncPlan } from "./plan-authority";
import type { StateCommitterContext } from "./state-committer";
import type { ConflictResolverContext } from "./conflict-resolver";
import type { Logger } from "../logging/logger";
import { commitAction } from "./state-committer";
import { resolveConflict } from "./conflict-resolver";
import { AuthError, classifyHttpError } from "../fs/errors";
import type { ErrorClassification } from "../fs/errors";
import { AsyncPool, AdaptivePool } from "../queue/async-queue";
import type { AdaptivePoolOpts } from "../queue/async-queue";
import {
	ACTION_CLASS,
	canRunInScheduledRoute,
	DESKTOP_TRANSFER_POOL,
	transferSize,
} from "./execution-routing";
import { runActionIO } from "./action-io";
import { decideRetry, sleep } from "./error";
import type { ExecutionResult } from "./execution-result";
import type { NormalActionPermit } from "./priority-coordinator";
import type { LocalMutationBarrier } from "./local-mutation-barrier";
export type { BlockedAction, CompletedAction, ExecutionResult, FailedAction, ResolvedConflict } from "./execution-result";
export { toConflictRecords } from "./execution-result";
export { DESKTOP_TRANSFER_POOL, MOBILE_TRANSFER_POOL } from "./execution-routing";

export interface ExecutionContext {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	committer: StateCommitterContext;
	conflictStrategy: ConflictStrategy;
	onProgress?: (completed: number, total: number) => void;
	logger?: Logger;
	/**
	 * Classify a failed I/O for the per-action retry — the backend's own override
	 * (e.g. Google's 403-means-rate-limit) when present, else the generic HTTP
	 * classifier. Set by the orchestrator; defaults to `classifyHttpError`.
	 */
	classifyError?: (err: unknown) => ErrorClassification;
	/**
	 * AIMD bounds for the transfer-phase pool (platform-aware; set by the
	 * orchestrator). Defaults to `DESKTOP_TRANSFER_POOL`.
	 */
	transferPool?: AdaptivePoolOpts;
	/** Test seam: random source for retry backoff jitter (default `Math.random`). */
	rng?: () => number;
	/** Test seam: backoff sleep (default the real `sleep` from `./error`). */
	sleep?: (ms: number) => Promise<void>;
	/** この cycle で action を skip すべき場合に、その理由を返す。 */
	isActionBlocked?: (action: SyncAction) => string | null;
	acquireActionPermit?: () => Promise<NormalActionPermit>;
	mutationBarrier?: LocalMutationBarrier;
	admitAction?: (action: SyncAction) => Promise<
		| { kind: "run"; action: SyncAction }
		| { kind: "no_action" }
		| { kind: "nonterminal"; reason: string }
	>;
}

/**
 * Per-action I/O retry attempts for transient / rate-limit errors. DISTINCT from
 * the orchestrator's cycle-level `MAX_RETRIES`: this retries one action's I/O
 * in-cycle so a 429/5xx doesn't defer the file to the next incremental cycle. An
 * exhausted retry lands the action in `result.failed` (a return, not a throw), so
 * it never multiplies with the cycle-level retry. Worst case: 3 I/O attempts.
 */
const MAX_ACTION_RETRIES = 3;
/**
 * AIMD transfer-pool presets, selected by the orchestrator per platform. `start`
 * is today's fixed value (5) on desktop ⇒ zero behaviour change at t=0; it ramps
 * toward `max` on sustained success and halves toward `min` on a rate-limit.
 *
 * Each transfer holds a whole-file `ArrayBuffer` in memory (`requestUrl` is buffered
 * — no streaming on either platform), so a count limit alone makes peak memory scale
 * with file COUNT. The `byteBudget` is a second admission dimension that instead caps
 * memory by BYTES in flight: small text files run highly concurrent (count-bound)
 * while large files self-throttle (byte-bound). This decouples the count ceiling from
 * memory, so mobile can run wider than the old fixed 3 while peak memory stays ≈
 * `byteBudget` regardless of file mix (mobile also pre-filters files over
 * `mobileMaxFileSizeMB`). Desktop's budget is a generous safety cap — a burst of large
 * files can't blow memory — with no effect on normal vaults.
 */
/**
 * Max concurrent deletes, per lane. Deletes are metadata-only (trash / delete by
 * id) and could run hotter, but they share the backend rate-limit budget, so kept
 * at 5 for parity. Each lane gets its OWN pool — local (vault trash) and remote
 * (network) deletes have disjoint resource profiles and must not share a budget.
 */
const DELETE_CONCURRENCY = 5;

/**
 * Max concurrent state-only commits (match/cleanup) in Phase 1. They issue no
 * network I/O, but a `match` commit may read the file to store a 3-way-merge base
 * (`maybeStoreMergeBase`), so a cold scan's thousands of matches must not all read
 * at once — the old Group A bounded these at 5 via `AsyncPool`.
 */
const STATE_COMMIT_CONCURRENCY = 5;

/**
 * Declared byte size of a transfer action, for the transfer pool's byte budget. The
 * `transfers` bucket holds only push/pull (conflict has its own serial phase), so the
 * source entity is local for a push and remote for a pull. Falls back to 0 (count-gated
 * only) if the size is unknown — the budget is a soft memory ceiling, not exact.
 */

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
	plan: AuthorizedSyncPlan,
	ctx: ExecutionContext,
): Promise<ExecutionResult> {
	const result: ExecutionResult = {
		succeeded: [],
		failed: [],
		blocked: [],
		conflicts: [],
		deferred: [],
	};

	const total = plan.actions.length;
	let completed = 0;
	const reportProgress = () => {
		completed++;
		ctx.onProgress?.(completed, total);
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
		const blockedReason = ctx.isActionBlocked?.(action);
		if (blockedReason) {
			result.blocked.push({ action, reason: blockedReason });
			ctx.logger?.warn("executePlan: action blocked", {
				path: action.path,
				action: action.action,
				reason: blockedReason,
			});
			reportProgress();
			continue;
		}
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

	// ── Phase 1 — transfers (adaptive pool) + state-only (bounded pool). ──
	// One action per path ⇒ concurrent transfers target disjoint paths. State-only
	// actions (match/cleanup) issue no network I/O, but their commit can read a file
	// to store a 3-way-merge base, so they run through their own bounded pool rather
	// than all at once (a cold scan can emit thousands of matches).
	const transferPool = new AdaptivePool(ctx.transferPool ?? DESKTOP_TRANSFER_POOL);
	const statePool = new AsyncPool(STATE_COMMIT_CONCURRENCY);
	await Promise.all([
		...transfers.map((action) =>
			transferPool.run(
				() =>
					executeAction(action, memberObligationFor(plan, action), ctx, result, reportProgress, () =>
						transferPool.noteRateLimit()
					),
				transferSize(action)
			)
		),
		...stateOnly.map((action) =>
			statePool.run(() => executeAction(
				action, memberObligationFor(plan, action), ctx, result, reportProgress,
			))
		),
	]);

	// ── Phase 2 — conflicts (serial, own phase). ──
	// Headless, but mutates a planner-invisible `.conflict` sibling — kept serial so
	// concurrent resolutions can't collide on that sibling namespace (see ACTION_CLASS).
	for (const action of conflicts) {
		await executeConflictAction(
			action, memberObligationFor(plan, action), ctx, result, reportProgress,
		);
	}

	// ── Phase 3 — structural mutations; the two lanes run concurrently. ──
	// They touch disjoint filesystems (the local FS has no remote metadata cache), so
	// they share no mutable state — safe to overlap. Within each lane: renames first
	// (serial — a rename has two endpoints and folder renames rewrite subtrees), then
	// deletes pooled (the bulk-folder-delete win). Each lane has its OWN delete pool.
	const runLane = async (renames: SyncAction[], deletes: SyncAction[]) => {
		for (const action of renames) {
			await executeAction(
				action, memberObligationFor(plan, action), ctx, result, reportProgress,
			);
		}
		const pool = new AsyncPool(DELETE_CONCURRENCY);
		await Promise.all(
			deletes.map((action) =>
				pool.run(() => executeAction(
					action, memberObligationFor(plan, action), ctx, result, reportProgress,
				))
			)
		);
	};
	await Promise.all([
		runLane(renameRemote, deleteRemote),
		runLane(renameLocal, deleteLocal),
	]);

	return result;
}

/**
 * Run an action's network I/O with bounded in-cycle retry for transient /
 * rate-limit errors. `AuthError` is rethrown immediately — the ONLY cycle-abort
 * path, unchanged. Any other non-retryable classification rethrows the ORIGINAL
 * error so the caller's catch records it in `result.failed` (preserving today's
 * semantics: e.g. a permission-403 fails the action, it does NOT abort the cycle).
 * On a rate-limit, `onRateLimit` fires BEFORE the backoff sleep so an adaptive pool
 * can shrink immediately.
 */
async function withIoRetry<T>(
	io: () => Promise<T>,
	ctx: ExecutionContext,
	onRateLimit?: () => void,
): Promise<T> {
	const rng = ctx.rng ?? Math.random;
	const doSleep = ctx.sleep ?? sleep;
	const classify = ctx.classifyError ?? classifyHttpError;
	for (let attempt = 1; ; attempt++) {
		try {
			return await io();
		} catch (err) {
			if (err instanceof AuthError) throw err;
			const classification = classify(err);
			const decision = decideRetry(classification, attempt, MAX_ACTION_RETRIES, rng);
			if (decision.action !== "retry") throw err;
			if (classification.kind === "rateLimit") onRateLimit?.();
			await doSleep(decision.delayMs);
		}
	}
}

async function executeAction(
	action: SyncAction,
	member: AuthorizedMemberObligation,
	ctx: ExecutionContext,
	result: ExecutionResult,
	reportProgress: () => void,
	onRateLimit?: () => void,
): Promise<void> {
	const permit = await ctx.acquireActionPermit?.();
	try {
		const run = async () => {
			const admission = await ctx.admitAction?.(action) ?? { kind: "run" as const, action };
			if (admission.kind === "no_action") {
				result.succeeded.push({
					action,
					componentId: member.componentId,
					memberObligationId: member.id,
					admissionEpoch: member.admissionEpoch,
				});
				return;
			}
			if (admission.kind === "nonterminal") {
				result.blocked.push({ action, reason: admission.reason });
				return;
			}
			const admittedAction = admission.action;
			if (!canRunInScheduledRoute(action, admittedAction)) {
				result.blocked.push({ action, reason: "current_action_requires_reroute" });
				return;
			}
			// Retry only operations that replay safely: push/pull overwrite by path and
			// delete is idempotent. Renames remain single-attempt.
			const io = () => runActionIO(admittedAction, ctx);
			const { localEntity, remoteEntity } =
				ACTION_CLASS[admittedAction.action].tier === "rename"
					? await io()
					: await withIoRetry(io, ctx, onRateLimit);
			await commitAction(admittedAction, localEntity, remoteEntity, ctx.committer);
			result.succeeded.push({
				action,
				componentId: member.componentId,
				memberObligationId: member.id,
				admissionEpoch: member.admissionEpoch,
				executedAction: admittedAction === action ? undefined : admittedAction,
				localEntity,
				remoteEntity,
			});
		};
		if (ctx.mutationBarrier) await ctx.mutationBarrier.run(actionMutationPaths(action), run);
		else await run();
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
		permit?.release();
		reportProgress();
	}
}

function actionMutationPaths(action: SyncAction): string[] {
	if (action.action === "rename_local" || action.action === "rename_remote") {
		return [action.oldPath, action.path, ...(action.descendants?.flatMap((pair) => [pair.oldPath, pair.newPath]) ?? [])];
	}
	return [action.path];
}

async function executeConflictAction(
	action: SyncAction,
	member: AuthorizedMemberObligation,
	ctx: ExecutionContext,
	result: ExecutionResult,
	reportProgress: () => void,
): Promise<void> {
	const permit = await ctx.acquireActionPermit?.();
	try {
		const run = async () => {
		const admission = await ctx.admitAction?.(action) ?? { kind: "run" as const, action };
		if (admission.kind === "no_action") {
			result.succeeded.push({
				action,
				componentId: member.componentId,
				memberObligationId: member.id,
				admissionEpoch: member.admissionEpoch,
			});
			return;
		}
		if (admission.kind === "nonterminal") {
			result.blocked.push({ action, reason: admission.reason });
			return;
		}
		const admittedAction = admission.action;
		if (!canRunInScheduledRoute(action, admittedAction)) {
			result.blocked.push({ action, reason: "current_action_requires_reroute" });
			return;
		}
		if (admittedAction.action !== "conflict") {
			const { localEntity, remoteEntity } = await withIoRetry(
				() => runActionIO(admittedAction, ctx), ctx,
			);
			await commitAction(admittedAction, localEntity, remoteEntity, ctx.committer);
			result.succeeded.push({
				action,
				componentId: member.componentId,
				memberObligationId: member.id,
				admissionEpoch: member.admissionEpoch,
				executedAction: admittedAction === action ? undefined : admittedAction,
				localEntity,
				remoteEntity,
			});
			return;
		}
		const conflictCtx: ConflictResolverContext = {
			path: admittedAction.path,
			localFs: ctx.localFs,
			remoteFs: ctx.remoteFs,
			local: admittedAction.local,
			remote: admittedAction.remote,
			baseline: admittedAction.baseline,
			stateStore: ctx.committer.stateStore,
			logger: ctx.logger,
		};

		// No in-cycle retry: conflict resolution (the `duplicate` strategy) is NOT
		// idempotent on replay — after a partial write, generateConflictPath would pick
		// a fresh `.conflict-N` name, orphaning the first backup. A rate-limited resolve
		// fails the action and re-resolves next cycle (it runs serially and never feeds
		// the transfer pool's AIMD).
		const resolution = await resolveConflict(conflictCtx, ctx.conflictStrategy);

		const localEntity = await ctx.localFs.stat(admittedAction.path) ?? admittedAction.local;
		const remoteEntity = await ctx.remoteFs.stat(admittedAction.path) ?? admittedAction.remote;

		await commitAction(admittedAction, localEntity, remoteEntity, ctx.committer);

		result.conflicts.push({ action: admittedAction, resolution, localEntity, remoteEntity });
		result.succeeded.push({
			action,
			componentId: member.componentId,
			memberObligationId: member.id,
			admissionEpoch: member.admissionEpoch,
			executedAction: admittedAction === action ? undefined : admittedAction,
			localEntity,
			remoteEntity,
		});
		};
		if (ctx.mutationBarrier) await ctx.mutationBarrier.run(actionMutationPaths(action), run);
		else await run();
	} catch (err) {
		if (err instanceof AuthError) throw err;
		const error = err instanceof Error ? err : new Error(String(err));
		ctx.logger?.error("executePlan: conflict action failed", {
			path: action.path,
			error: error.message,
		});
		result.failed.push({ action, error });
	} finally {
		permit?.release();
		reportProgress();
	}
}
