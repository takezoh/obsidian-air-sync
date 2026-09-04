/* eslint max-lines: ["error", 900] -- the executor owns fresh compound effects, destructive re-observation, cycle-local terminal proof, and proof-gated commit routing. */
import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { ConflictStrategy, RenameAction, SyncAction, SyncActionType } from "./types";
import {
	isCaseAliasCanonicalizationAction,
	isFreshRenameAction,
	type AuthorizedSyncPlan,
	type FreshRenameAction,
} from "./plan-admission";
import type { StateCommitterContext } from "./state-committer";
import {
	ConflictPreparationError,
	type ConflictResolverContext,
	type ConflictResolutionResult,
} from "./conflict-resolver";
import type { VerifiedConflictOutput } from "./conflict";
import type { Logger } from "../logging/logger";
import { commitAction, commitTerminalFresh } from "./state-committer";
import { resolveConflict } from "./conflict-resolver";
import { AuthError, classifyHttpError } from "../fs/errors";
import type { ErrorClassification } from "../fs/errors";
import { AsyncPool, AdaptivePool } from "../queue/async-queue";
import type { AdaptivePoolOpts } from "../queue/async-queue";
import { decideRetry, sleep } from "./error";
import type { ExecutionResult } from "./execution-result";
import type { NormalActionPermit } from "./priority-coordinator";
import type { LocalMutationBarrier } from "./local-mutation-barrier";
import { hasRemoteChanged } from "./change-compare";
import { sameContent } from "./content-identity";
export type { BlockedAction, CompletedAction, ExecutionResult, FailedAction, ResolvedConflict } from "./execution-result";
export { toConflictRecords } from "./execution-result";

const terminalFreshProofBrand: unique symbol = Symbol("TerminalFreshProof");

/** Executor-owned proof seam consumed by the state committer in the following unit. */
export interface TerminalFreshProof {
	readonly [terminalFreshProofBrand]: true;
	readonly action: FreshRenameAction;
	readonly localEntity: FileEntity;
	readonly remoteEntity: FileEntity;
	readonly intendedContent: ArrayBuffer;
	readonly verifiedOutputs: readonly VerifiedConflictOutput[];
}

class InternalFreshInvariantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InternalFreshInvariantError";
	}
}

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
	/** Scheduler safe point acquired immediately before exact action execution. */
	acquireActionPermit?: () => Promise<NormalActionPermit>;
	/** Consume the active cycle's exact-object scheduler state; never chooses another action. */
	beginAction?: (action: SyncAction) => "run" | "superseded" | "invalidated";
	/** Publish a fatal terminal state before releasing the action permit. */
	onActionFatal?: (action: SyncAction, error: AuthError) => void;
	mutationBarrier?: LocalMutationBarrier;
	onPhaseChange?: (phase: "transfer" | "conflict" | "structural") => void;
	/** Test seam and dependency boundary for the configured resolver. */
	conflictResolver?: typeof resolveConflict;
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

/**
 * Per-action I/O retry attempts for transient / rate-limit errors. DISTINCT from
 * the orchestrator's cycle-level `MAX_RETRIES`: this retries one action's I/O
 * in-cycle so a 429/5xx doesn't defer the file to the next (forced-cold) cycle. An
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
export const DESKTOP_TRANSFER_POOL: AdaptivePoolOpts =
	{ min: 2, start: 5, max: 10, rampAfter: 8, byteBudget: 1024 * 1024 * 1024 };
export const MOBILE_TRANSFER_POOL: AdaptivePoolOpts =
	{ min: 1, start: 3, max: 8, rampAfter: 8, byteBudget: 512 * 1024 * 1024 };
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
function transferSize(action: SyncAction): number {
	return (action.action === "push" ? action.local?.size : action.remote?.size) ?? 0;
}

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
		superseded: [],
		failed: [],
		blocked: [],
		conflicts: [],
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
	ctx.onPhaseChange?.("transfer");
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
					executeAction(action, ctx, result, reportProgress, () =>
						transferPool.noteRateLimit()
					),
				transferSize(action)
			)
		),
		...stateOnly.map((action) =>
			statePool.run(() => executeAction(action, ctx, result, reportProgress))
		),
	]);

	// ── Phase 2 — conflicts (serial, own phase). ──
	ctx.onPhaseChange?.("conflict");
	// Headless, but mutates a planner-invisible `.conflict` sibling — kept serial so
	// concurrent resolutions can't collide on that sibling namespace (see ACTION_CLASS).
	for (const action of conflicts) {
		await executeConflictAction(action, ctx, result, reportProgress);
	}

	// ── Phase 3 — structural mutations; the two lanes run concurrently. ──
	ctx.onPhaseChange?.("structural");
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
	ctx: ExecutionContext,
	result: ExecutionResult,
	reportProgress: () => void,
	onRateLimit?: () => void,
): Promise<void> {
	const permit = await ctx.acquireActionPermit?.();
	try {
		const start = ctx.beginAction?.(action) ?? "run";
		if (start === "superseded") {
			result.superseded.push(action);
			return;
		}
		if (start === "invalidated") {
			result.blocked.push({ action, reason: "priority observation invalidated pending action" });
			return;
		}
		// Retry only operations that replay safely: push/pull overwrite by path and
		// delete is idempotent on our backends. A rename would, on replay, re-issue
		// rename(oldPath, …) against a source the first (successful) attempt already
		// moved → a spurious not-found failure — so renames run without the retry wrapper.
		const io = () => runActionIO(action, ctx);
		const execute = async () => {
			const entities = isFreshRenameAction(action) || ACTION_CLASS[action.action].tier === "rename"
				? await io()
				: await withIoRetry(io, ctx, onRateLimit);
			const terminalFreshProof = isFreshRenameAction(action)
				? await proveFreshTerminal(action, ctx, entities, [])
				: undefined;
			if (terminalFreshProof) {
				const baseline = terminalFreshProof.action.baseline;
				if (!baseline) {
					throw new InternalFreshInvariantError(
						`Fresh rename baseline missing: ${terminalFreshProof.action.oldPath}`,
					);
				}
				await commitTerminalFresh(terminalFreshProof, baseline, ctx.committer);
			} else {
				await commitAction(action, entities.localEntity, entities.remoteEntity, ctx.committer);
			}
			return { ...entities, terminalFreshProof };
		};
		const paths = localMutationPaths(action);
		const { localEntity, remoteEntity, terminalFreshProof } = ctx.mutationBarrier && paths.length > 0
			? await ctx.mutationBarrier.run(paths, execute)
			: await execute();
		result.succeeded.push({ action, localEntity, remoteEntity, terminalFreshProof });
	} catch (err) {
		if (err instanceof InternalFreshInvariantError) throw err;
		if (err instanceof ConflictPreparationError && err.kind === "proof_mismatch") {
			result.blocked.push({ action, reason: err.message });
			return;
		}
		if (err instanceof AuthError) {
			ctx.onActionFatal?.(action, err);
			throw err;
		}
		const error = err instanceof Error ? err : new Error(String(err));
		ctx.logger?.error("executePlan: action failed", {
			path: action.path,
			action: action.action,
			error: error.message,
		});
		result.failed.push({ action, error });
	} finally {
		reportProgress();
		permit?.release();
	}
}

function localMutationPaths(action: SyncAction): string[] {
	if (isCaseAliasCanonicalizationAction(action)) {
		return [action.path];
	}
	if (action.action === "pull" || action.action === "delete_local" || action.action === "conflict") {
		return [action.path];
	}
	if (action.action !== "rename_local") return [];
	return [action.oldPath, action.path,
		...(action.descendants?.flatMap(({ oldPath, newPath }) => [oldPath, newPath]) ?? [])];
}

async function runActionIO(
	action: SyncAction,
	ctx: ExecutionContext,
): Promise<{ localEntity?: FileEntity; remoteEntity?: FileEntity }> {
	if (isFreshRenameAction(action)) return runFreshRenameIO(action, ctx);
	if (isCaseAliasCanonicalizationAction(action)) {
		return runCaseAliasCanonicalizationIO(action, ctx);
	}
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

async function runCaseAliasCanonicalizationIO(
	action: RenameAction,
	ctx: ExecutionContext,
): Promise<{ localEntity?: FileEntity; remoteEntity?: FileEntity }> {
	const { localFs, remoteFs } = ctx;
	if (!action.local || !action.remote?.identityKey) {
		throw new ConflictPreparationError(
			"proof_mismatch", `Case-alias protocol proof missing: ${action.oldPath}`,
		);
	}
	const [localBefore, oldBefore, newBefore, localBytes, remoteBytes] = await Promise.all([
		localFs.stat(action.path), remoteFs.stat(action.oldPath), remoteFs.stat(action.path),
		localFs.read(action.path), remoteFs.read(action.oldPath),
	]);
	if (!isExactPath(localBefore, action.path) ||
		!isExactPath(oldBefore, action.oldPath) || newBefore ||
		oldBefore.identityKey !== action.remote.identityKey ||
		localBefore.size !== oldBefore.size ||
		localBefore.size !== localBytes.byteLength ||
		oldBefore.size !== remoteBytes.byteLength ||
		!buffersEqual(localBytes, remoteBytes)) {
		throw new ConflictPreparationError(
			"proof_mismatch", `Case-alias protocol precondition changed: ${action.oldPath}`,
		);
	}

	await remoteFs.rename(action.oldPath, action.path);
	const [localAfter, oldAfter, newAfter, finalLocalBytes, finalRemoteBytes] = await Promise.all([
		localFs.stat(action.path), remoteFs.stat(action.oldPath), remoteFs.stat(action.path),
		localFs.read(action.path), remoteFs.read(action.path),
	]);
	if (!isExactPath(localAfter, action.path) || oldAfter ||
		!isExactPath(newAfter, action.path) ||
		newAfter.identityKey !== action.remote.identityKey ||
		localAfter.size !== newAfter.size ||
		localAfter.size !== finalLocalBytes.byteLength ||
		newAfter.size !== finalRemoteBytes.byteLength ||
		!buffersEqual(finalLocalBytes, finalRemoteBytes)) {
		throw new ConflictPreparationError(
			"proof_mismatch", `Case-alias protocol terminal proof failed: ${action.path}`,
		);
	}
	return { localEntity: localAfter, remoteEntity: newAfter };
}

function isExactPath(entity: FileEntity | null, path: string): entity is FileEntity {
	return entity?.path === path && entity.pathAuthority === "actual_resolved";
}

async function runFreshRenameIO(
	action: FreshRenameAction,
	ctx: ExecutionContext,
): Promise<{ localEntity?: FileEntity; remoteEntity?: FileEntity }> {
	const { localFs, remoteFs } = ctx;
	const local = await localFs.stat(action.path);
	if (!local || !action.local || !sameContent(local, action.local)) {
		throw new ConflictPreparationError(
			"proof_mismatch", `Fresh rename local content changed before execution: ${action.path}`,
		);
	}
	if (action.freshRenameState === "converged") {
		return { localEntity: local, remoteEntity: action.remote };
	}
	if (action.freshRenameState === "remote_changed" ||
		action.freshRenameState === "destination_conflict") {
		throw new Error(`Fresh rename conflict must use conflict execution: ${action.path}`);
	}
	const identityKey = action.baseline?.remoteIdentityKey;
	if (!action.baseline || !identityKey) {
		throw new Error(`Fresh rename requires an identity-aware baseline: ${action.oldPath}`);
	}
	const oldBefore = await remoteFs.stat(action.oldPath);
	const newBefore = await remoteFs.stat(action.path);
	let identityObservation: FileEntity;
	if (action.freshRenameState === "old_path_baseline") {
		if (!oldBefore || oldBefore.identityKey !== identityKey ||
			hasRemoteChanged(oldBefore, action.baseline) || newBefore) {
			throw new ConflictPreparationError(
				"proof_mismatch", `Fresh rename precondition changed: ${action.oldPath}`,
			);
		}
		await remoteFs.rename(action.oldPath, action.path);
		const moved = await remoteFs.stat(action.path);
		if (!moved || moved.identityKey !== identityKey) {
			throw new ConflictPreparationError(
				"proof_mismatch", `Fresh rename identity not observed at destination: ${action.path}`,
			);
		}
		identityObservation = moved;
	} else {
		if (oldBefore || !newBefore || newBefore.identityKey !== identityKey ||
			hasRemoteChanged(newBefore, action.baseline)) {
			throw new ConflictPreparationError(
				"proof_mismatch", `Fresh rename write precondition changed: ${action.path}`,
			);
		}
		identityObservation = newBefore;
	}
	const content = await localFs.read(action.path);
	const written = await remoteFs.write(action.path, content, local.mtime);
	const [oldAfter, newAfter, remoteContent] = await Promise.all([
		remoteFs.stat(action.oldPath), remoteFs.stat(action.path), remoteFs.read(action.path),
	]);
	if (oldAfter || !newAfter || !buffersEqual(content, remoteContent)) {
		throw new ConflictPreparationError(
			"proof_mismatch", `Fresh rename terminal verification failed: ${action.path}`,
		);
	}
	return {
		localEntity: local,
		remoteEntity: {
			...written, ...newAfter,
			identityKey: newAfter.identityKey ?? written.identityKey ?? identityObservation.identityKey,
		},
	};
}

function buffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) return false;
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	return a.every((value, index) => value === b[index]);
}

function verifiedFreshOutputs(
	action: FreshRenameAction,
	resolution: ConflictResolutionResult,
): readonly VerifiedConflictOutput[] {
	const expected = action.remote ? [
		{ role: "primary" as const, sourcePath: action.remotePath ?? action.remote.path },
		...(action.additionalRemote
			? [{ role: "additional" as const, sourcePath: action.additionalRemote.path }]
			: []),
	] : [];
	const actual = resolution.verifiedOutputs;
	if (!actual || actual.length !== expected.length ||
		new Set(actual.map(({ path }) => path)).size !== actual.length ||
		actual.some((output, index) => output.role !== expected[index]?.role ||
			output.sourcePath !== expected[index]?.sourcePath)) {
		throw new ConflictPreparationError(
			"proof_mismatch", `Conflict preservation coverage mismatch: ${action.path}`,
		);
	}
	return actual;
}

function makeTerminalFreshProof(
	action: FreshRenameAction,
	localEntity: FileEntity,
	remoteEntity: FileEntity,
	intendedContent: ArrayBuffer,
	verifiedOutputs: readonly VerifiedConflictOutput[],
): TerminalFreshProof {
	return Object.freeze({
		[terminalFreshProofBrand]: true as const,
		action,
		localEntity: Object.freeze({ ...localEntity }),
		remoteEntity: Object.freeze({ ...remoteEntity }),
		intendedContent: intendedContent.slice(0),
		verifiedOutputs,
	});
}

async function proveFreshTerminal(
	action: FreshRenameAction,
	ctx: ExecutionContext,
	entities: { localEntity?: FileEntity; remoteEntity?: FileEntity },
	outputs: readonly VerifiedConflictOutput[],
): Promise<TerminalFreshProof> {
	const [localEntity, remoteEntity, oldEntity, localBytes, remoteBytes] = await Promise.all([
		ctx.localFs.stat(action.path), ctx.remoteFs.stat(action.path),
		ctx.remoteFs.stat(action.oldPath), ctx.localFs.read(action.path), ctx.remoteFs.read(action.path),
	]);
	if (!localEntity || !remoteEntity || oldEntity ||
		!buffersEqual(localBytes, remoteBytes)) {
		throw new ConflictPreparationError("proof_mismatch", `Fresh rename terminal proof failed: ${action.path}`);
	}
	const trackedIdentity = action.baseline?.remoteIdentityKey;
	if (trackedIdentity && remoteEntity.identityKey !== trackedIdentity) {
		throw new ConflictPreparationError("proof_mismatch", `Fresh rename terminal identity mismatch: ${action.path}`);
	}
	if (entities.localEntity && entities.localEntity.path !== localEntity.path ||
		entities.remoteEntity && entities.remoteEntity.path !== remoteEntity.path) {
		throw new InternalFreshInvariantError(`Fresh rename execution returned wrong endpoint: ${action.path}`);
	}
	return makeTerminalFreshProof(action, localEntity, remoteEntity, localBytes, outputs);
}

async function executeFreshConflictEffects(
	action: FreshRenameAction,
	ctx: ExecutionContext,
	resolution: ConflictResolutionResult,
): Promise<{
	localEntity: FileEntity;
	remoteEntity: FileEntity;
	terminalFreshProof: TerminalFreshProof;
}> {
	const outputs = verifiedFreshOutputs(action, resolution);
	if (!resolution.targetContent) {
		throw new InternalFreshInvariantError(`Fresh resolver omitted target content: ${action.path}`);
	}
	const intended = resolution.targetContent.slice(0);
	const source = action.remoteIdentitySource;
	const rotationRequired = !!source && source.path !== action.path;
	const trackedSourceIdentity = source?.identityKey;
	if (action.baseline?.remoteIdentityKey && !source &&
		action.normalizedRenameState.kind !== "baseline_absent_foreign_target" &&
		action.normalizedRenameState.kind !== "baseline_absent_vacant_target") {
		throw new InternalFreshInvariantError(`Tracked fresh conflict omitted identity source: ${action.path}`);
	}

	const primaryOutput = outputs.find((output) => output.role === "primary");
	const additionalOutput = outputs.find((output) => output.role === "additional");
	if (source) {
		if (!primaryOutput) {
			throw new InternalFreshInvariantError(`Fresh conflict omitted primary snapshot: ${action.path}`);
		}
		await assertPreservedSourceUnchanged(ctx.remoteFs, source.path, source.identityKey, primaryOutput);
	}
	const expectedTargetOutput = action.additionalRemote
		? additionalOutput
		: !source && action.remote ? primaryOutput : undefined;
	if ((action.additionalRemote || (!source && action.remote)) && !expectedTargetOutput) {
		throw new InternalFreshInvariantError(`Fresh conflict omitted target snapshot: ${action.path}`);
	}
	if (expectedTargetOutput) {
		const expectedIdentity = action.additionalRemote?.identityKey ?? action.remote?.identityKey;
		await assertPreservedSourceUnchanged(
			ctx.remoteFs, action.path, expectedIdentity, expectedTargetOutput,
		);
	} else if (source?.path !== action.path && await ctx.remoteFs.stat(action.path)) {
		throw new ConflictPreparationError(
			"proof_mismatch", `Fresh conflict destination changed: ${action.path}`,
		);
	}

	const targetBefore = await ctx.remoteFs.stat(action.path);
	if (rotationRequired) {
		if (targetBefore) await ctx.remoteFs.delete(action.path);
		await ctx.remoteFs.rename(source.path, action.path);
	} else if (!source && targetBefore) {
		// Foreign-only occupancy has been preserved; remove its identity before installing
		// the intended target so no tracked-R authority is inferred from Y.
		await ctx.remoteFs.delete(action.path);
	}

	const mtime = resolution.targetMtime ?? action.local?.mtime ?? 0;
	await ctx.localFs.write(action.path, intended.slice(0), mtime);
	await ctx.remoteFs.write(action.path, intended.slice(0), mtime);
	const [localEntity, remoteEntity, localBytes, remoteBytes, sourceAfter] = await Promise.all([
		ctx.localFs.stat(action.path), ctx.remoteFs.stat(action.path),
		ctx.localFs.read(action.path), ctx.remoteFs.read(action.path),
		rotationRequired ? ctx.remoteFs.stat(source.path) : Promise.resolve(null),
	]);
	if (!localEntity || !remoteEntity || sourceAfter ||
		!buffersEqual(intended, localBytes) || !buffersEqual(intended, remoteBytes)) {
		throw new ConflictPreparationError("proof_mismatch", `Fresh conflict terminal bytes mismatch: ${action.path}`);
	}
	if (trackedSourceIdentity && remoteEntity.identityKey !== trackedSourceIdentity) {
		throw new ConflictPreparationError("proof_mismatch", `Fresh conflict terminal identity mismatch: ${action.path}`);
	}
	const terminalFreshProof = makeTerminalFreshProof(
		action, localEntity, remoteEntity, intended, outputs,
	);
	return { localEntity, remoteEntity, terminalFreshProof };
}

async function assertPreservedSourceUnchanged(
	remoteFs: IFileSystem,
	path: string,
	expectedIdentity: string | undefined,
	output: VerifiedConflictOutput,
): Promise<void> {
	const current = await remoteFs.stat(path);
	if (!current || output.sourcePath !== path ||
		current.identityKey !== expectedIdentity ||
		output.sourceEntity.identityKey !== expectedIdentity) {
		throw new ConflictPreparationError("proof_mismatch", `Fresh conflict source changed: ${path}`);
	}
	const content = await remoteFs.read(path);
	if (!buffersEqual(content, output.sourceContent)) {
		throw new ConflictPreparationError("proof_mismatch", `Fresh conflict source bytes changed: ${path}`);
	}
}

async function executeConflictAction(
	action: SyncAction,
	ctx: ExecutionContext,
	result: ExecutionResult,
	reportProgress: () => void,
): Promise<void> {
	const permit = await ctx.acquireActionPermit?.();
	try {
		const start = ctx.beginAction?.(action) ?? "run";
		if (start === "superseded") {
			result.superseded.push(action);
			return;
		}
		if (start === "invalidated") {
			result.blocked.push({ action, reason: "priority observation invalidated pending action" });
			return;
		}
		const conflictCtx: ConflictResolverContext = {
			path: action.path,
			localFs: ctx.localFs,
			remoteFs: ctx.remoteFs,
			local: action.local,
			remote: action.remote,
			baseline: action.baseline,
			stateStore: ctx.committer.stateStore,
			logger: ctx.logger,
			...(isFreshRenameAction(action) ? {
				localPath: action.path,
				remotePath: action.remotePath ?? action.remote?.path,
				remoteIdentitySource: action.remoteIdentitySource,
				additionalRemote: action.additionalRemote,
				baselinePath: action.oldPath,
				freshRename: true,
			} : {}),
		};

		// No in-cycle retry: conflict resolution (the `duplicate` strategy) is NOT
		// idempotent on replay — after a partial write, generateConflictPath would pick
		// a fresh `.conflict-N` name, orphaning the first backup. A rate-limited resolve
		// fails the action and re-resolves next cycle (it runs serially and never feeds
		// the transfer pool's AIMD).
		const execute = async () => {
			const resolution = await (ctx.conflictResolver ?? resolveConflict)(
				conflictCtx, ctx.conflictStrategy,
			);
			const fresh = isFreshRenameAction(action)
				? await executeFreshConflictEffects(action, ctx, resolution)
				: undefined;
			const localEntity = fresh?.localEntity ?? await ctx.localFs.stat(action.path) ?? action.local;
			const remoteEntity = fresh?.remoteEntity ?? await ctx.remoteFs.stat(action.path) ?? action.remote;
			if (fresh) {
				const baseline = fresh.terminalFreshProof.action.baseline;
				if (!baseline) {
					throw new InternalFreshInvariantError(
						`Fresh conflict baseline missing: ${fresh.terminalFreshProof.action.oldPath}`,
					);
				}
				await commitTerminalFresh(fresh.terminalFreshProof, baseline, ctx.committer);
			} else {
				await commitAction(action, localEntity, remoteEntity, ctx.committer);
			}
			return { resolution, localEntity, remoteEntity, terminalFreshProof: fresh?.terminalFreshProof };
		};
		const mutationPaths = isFreshRenameAction(action) && action.remoteIdentitySource
			? [action.path, action.remoteIdentitySource.path]
			: [action.path];
		const { resolution, localEntity, remoteEntity, terminalFreshProof } = ctx.mutationBarrier
			? await ctx.mutationBarrier.run(mutationPaths, execute)
			: await execute();

		result.conflicts.push({ action, resolution, localEntity, remoteEntity, terminalFreshProof });
		result.succeeded.push({ action, localEntity, remoteEntity, terminalFreshProof });
	} catch (err) {
		if (err instanceof InternalFreshInvariantError) throw err;
		if (err instanceof ConflictPreparationError && err.kind === "proof_mismatch") {
			result.blocked.push({ action, reason: err.message });
			return;
		}
		if (err instanceof ConflictPreparationError && err.kind === "external_auth_failure") {
			result.blocked.push({ action, reason: err.message });
			const cause = err.cause instanceof AuthError
				? err.cause
				: new AuthError(err.message, 401);
			ctx.onActionFatal?.(action, cause);
			throw cause;
		}
		if (err instanceof AuthError) {
			ctx.onActionFatal?.(action, err);
			throw err;
		}
		const error = err instanceof Error ? err : new Error(String(err));
		ctx.logger?.error("executePlan: conflict action failed", {
			path: action.path,
			error: error.message,
		});
		result.failed.push({ action, error });
	} finally {
		reportProgress();
		permit?.release();
	}
}
