import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { ConflictStrategy, SyncAction } from "./types";
import { memberObligationFor } from "./plan-authority";
import type { AuthorizedMemberObligation, AuthorizedSyncPlan } from "./plan-authority";
import type { StateCommitterContext } from "./state-committer";
import type { ConflictResolverContext } from "./conflict-resolver";
import type { Logger } from "../logging/logger";
import { commitAction } from "./state-committer";
import { resolveConflict } from "./conflict-resolver";
import { ConflictAdmissionInvalidatedError } from "./conflict";
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
import {
	buildComponentReceipts, copyExecutionResultForResume, type ExecutionResult,
} from "./execution-result";
import type { NoActionFreshnessWitness } from "./execution-result";
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
	yieldNonterminal?: () => Promise<void>;
	admitAction?: (action: SyncAction, member: AuthorizedMemberObligation) => Promise<
		| { kind: "run"; action: SyncAction; boundRemoteContent?: ArrayBuffer; boundLocalContent?: ArrayBuffer;
			validateBeforeEffect?: () => Promise<boolean>;
			validateBeforeCommit?: (expectedLocal?: FileEntity | null) => Promise<boolean> }
		| { kind: "no_action"; freshness: NoActionFreshnessWitness }
		| { kind: "nonterminal"; reason: string }
	>;
}

export interface ExecutionResume {
	result: ExecutionResult;
	memberObligationIds: ReadonlySet<string>;
}

/**
 * Per-action I/O retry attempts for transient / rate-limit errors. DISTINCT from
 * the orchestrator's cycle-level `MAX_RETRIES`: this retries one action's I/O
 * in-cycle so a 429/5xx doesn't defer the file to the next incremental cycle. An
 * exhausted retry lands the action in `result.failed` (a return, not a throw), so
 * it never multiplies with the cycle-level retry. Worst case: 3 I/O attempts.
 */
const MAX_ACTION_RETRIES = 3;
const MAX_ATTEMPTS_PER_QUANTUM = 3;
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
	resume?: ExecutionResume,
): Promise<ExecutionResult> {
	const result: ExecutionResult = resume ? copyExecutionResultForResume(resume.result) : {
		succeeded: [], failed: [], blocked: [], conflicts: [], deferred: [],
		componentReceipts: [],
	};

	const total = plan.actions.length;
	let completed = 0;
	const reportProgress = () => {
		completed++;
		ctx.onProgress?.(completed, total);
	};

	let pending: WorkItem[] = [];
	for (const action of plan.actions) {
		const member = memberObligationFor(plan, action);
		if (resume && !resume.memberObligationIds.has(member.id)) continue;
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
		pending.push({ proposal: action, scheduled: action, member });
	}

	let attempt = 0;
	while (pending.length > 0) {
		pending = await runSchedulingQuantum(pending, ctx, result, reportProgress);
		attempt++;
		if (pending.length > 0 && attempt === MAX_ATTEMPTS_PER_QUANTUM) {
			ctx.logger?.warn("executePlan: current-state work yielded", {
				pending: pending.length, attempts: MAX_ATTEMPTS_PER_QUANTUM,
			});
			await (ctx.yieldNonterminal?.() ?? sleep(1000));
			attempt = 0;
		}
	}
	result.componentReceipts = buildComponentReceipts(plan, result);
	return result;
}

interface WorkItem {
	proposal: SyncAction;
	scheduled: SyncAction;
	member: AuthorizedMemberObligation;
}

type AttemptResult =
	| { kind: "terminal" }
	| { kind: "reroute"; action: SyncAction }
	| { kind: "nonterminal" };

class ActionAdmissionInvalidatedError extends Error {}

async function runSchedulingQuantum(
	items: WorkItem[], ctx: ExecutionContext, result: ExecutionResult, reportProgress: () => void,
): Promise<WorkItem[]> {
	const transfers: WorkItem[] = [];
	const stateOnly: WorkItem[] = [];
	const conflicts: WorkItem[] = [];
	const renameRemote: WorkItem[] = [];
	const deleteRemote: WorkItem[] = [];
	const renameLocal: WorkItem[] = [];
	const deleteLocal: WorkItem[] = [];
	for (const item of items) {
		const { lane, tier } = ACTION_CLASS[item.scheduled.action];
		if (item.scheduled.action === "conflict") conflicts.push(item);
		else if (tier === "none") stateOnly.push(item);
		else if (tier === "transfer") transfers.push(item);
		else if (tier === "rename") (lane === "remote" ? renameRemote : renameLocal).push(item);
		else (lane === "remote" ? deleteRemote : deleteLocal).push(item);
	}
	const next: WorkItem[] = [];
	const settle = (item: WorkItem, attempt: AttemptResult) => {
		if (attempt.kind === "terminal") reportProgress();
		else next.push({ ...item, scheduled: attempt.kind === "reroute" ? attempt.action : item.scheduled });
	};
	const transferPool = new AdaptivePool(ctx.transferPool ?? DESKTOP_TRANSFER_POOL);
	const statePool = new AsyncPool(STATE_COMMIT_CONCURRENCY);
	await Promise.all([
		...transfers.map((item) => transferPool.run(async () => settle(item,
			await executeAction(item.scheduled, item.member, ctx, result, () => transferPool.noteRateLimit())),
			transferSize(item.scheduled))),
		...stateOnly.map((item) => statePool.run(async () => settle(item,
			await executeAction(item.scheduled, item.member, ctx, result)))),
	]);
	for (const item of conflicts) settle(item,
		await executeConflictAction(item.scheduled, item.member, ctx, result));
	const runLane = async (renames: WorkItem[], deletes: WorkItem[]) => {
		for (const item of renames) settle(item, await executeAction(item.scheduled, item.member, ctx, result));
		const pool = new AsyncPool(DELETE_CONCURRENCY);
		await Promise.all(deletes.map((item) => pool.run(async () => settle(item,
			await executeAction(item.scheduled, item.member, ctx, result)))));
	};
	await Promise.all([runLane(renameRemote, deleteRemote), runLane(renameLocal, deleteLocal)]);
	return next;
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
			if (err instanceof ActionAdmissionInvalidatedError) throw err;
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
	onRateLimit?: () => void,
): Promise<AttemptResult> {
	const permit = await ctx.acquireActionPermit?.();
	try {
		const run = async (): Promise<AttemptResult> => {
			const admission = await ctx.admitAction?.(action, member) ?? { kind: "run" as const, action };
			if (admission.kind === "no_action") {
				result.succeeded.push({
					action,
					componentId: member.componentId,
					memberObligationId: member.id,
					admissionEpoch: member.admissionEpoch,
					completionKind: "no_action",
					freshness: admission.freshness,
				});
				return { kind: "terminal" };
			}
			if (admission.kind === "nonterminal") {
				return { kind: "nonterminal" };
			}
			const admittedAction = admission.action;
			if (!canRunInScheduledRoute(action, admittedAction)) {
				return { kind: "reroute", action: admittedAction };
			}
			// Retry only operations that replay safely: push/pull overwrite by path and
			// delete is idempotent. Renames remain single-attempt.
			const io = async () => {
				if (admission.validateBeforeEffect && !(await admission.validateBeforeEffect())) {
					throw new ActionAdmissionInvalidatedError();
				}
				return await runActionIO(
					admittedAction, ctx, admission.boundRemoteContent, admission.boundLocalContent,
				);
			};
			const { localEntity, remoteEntity } =
				ACTION_CLASS[admittedAction.action].tier === "rename"
					? await io()
					: await withIoRetry(io, ctx, onRateLimit);
			if (admission.validateBeforeCommit && !(await admission.validateBeforeCommit())) {
				return { kind: "nonterminal" };
			}
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
			return { kind: "terminal" };
		};
		if (ctx.mutationBarrier) return await ctx.mutationBarrier.run(member.componentPaths, run);
		return await run();
	} catch (err) {
		if (err instanceof AuthError) throw err;
		if (err instanceof ActionAdmissionInvalidatedError) return { kind: "nonterminal" };
		const error = err instanceof Error ? err : new Error(String(err));
		ctx.logger?.error("executePlan: action failed", {
			path: action.path,
			action: action.action,
			error: error.message,
		});
		result.failed.push({ action, error });
		return { kind: "terminal" };
	} finally {
		permit?.release();
	}
}

async function executeConflictAction(
	action: SyncAction,
	member: AuthorizedMemberObligation,
	ctx: ExecutionContext,
	result: ExecutionResult,
): Promise<AttemptResult> {
	const permit = await ctx.acquireActionPermit?.();
	try {
		const run = async (): Promise<AttemptResult> => {
		const admission = await ctx.admitAction?.(action, member) ?? { kind: "run" as const, action };
		if (admission.kind === "no_action") {
			result.succeeded.push({
				action,
				componentId: member.componentId,
				memberObligationId: member.id,
				admissionEpoch: member.admissionEpoch,
				completionKind: "no_action",
				freshness: admission.freshness,
			});
			return { kind: "terminal" };
		}
		if (admission.kind === "nonterminal") {
			return { kind: "nonterminal" };
		}
		const admittedAction = admission.action;
		if (!canRunInScheduledRoute(action, admittedAction)) {
			return { kind: "reroute", action: admittedAction };
		}
		if (admittedAction.action !== "conflict") {
			const { localEntity, remoteEntity } = await withIoRetry(
				() => runActionIO(
					admittedAction, ctx, admission.boundRemoteContent, admission.boundLocalContent,
				), ctx,
			);
			if (admission.validateBeforeCommit && !(await admission.validateBeforeCommit())) {
				return { kind: "nonterminal" };
			}
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
				return { kind: "terminal" };
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
			boundRemoteContent: admission.boundRemoteContent,
			boundLocalContent: admission.boundLocalContent,
			validateBeforeEffect: admission.validateBeforeEffect,
		};

		// No in-cycle retry: conflict resolution (the `duplicate` strategy) is NOT
		// idempotent on replay — after a partial write, generateConflictPath would pick
		// a fresh `.conflict-N` name, orphaning the first backup. A rate-limited resolve
		// fails the action and re-resolves next cycle (it runs serially and never feeds
		// the transfer pool's AIMD).
		const resolution = await resolveConflict(conflictCtx, ctx.conflictStrategy);
		if (admission.validateBeforeCommit &&
			!(await admission.validateBeforeCommit(resolution.expectedLocalEntity))) {
			return { kind: "nonterminal" };
		}

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
		return { kind: "terminal" };
		};
		if (ctx.mutationBarrier) return await ctx.mutationBarrier.run(member.componentPaths, run);
		return await run();
	} catch (err) {
		if (err instanceof AuthError) throw err;
		if (err instanceof ConflictAdmissionInvalidatedError) return { kind: "nonterminal" };
		const error = err instanceof Error ? err : new Error(String(err));
		ctx.logger?.error("executePlan: conflict action failed", {
			path: action.path,
			error: error.message,
		});
		result.failed.push({ action, error });
		return { kind: "terminal" };
	} finally {
		permit?.release();
	}
}
