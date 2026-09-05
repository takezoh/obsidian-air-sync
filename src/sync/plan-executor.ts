/* eslint max-lines: ["error", 900] -- the executor owns fresh compound effects, destructive re-observation, cycle-local terminal proof, and proof-gated commit routing. */
import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { ConflictStrategy, RenameAction, SyncAction } from "./types";
import type { AuthorizedSyncPlan } from "./plan-admission";
import type { StateCommitterContext } from "./state-committer";
import { bytesMatch, captureContentSnapshot, ContentProofError } from "./content-snapshot";
import type {
	ConflictResolverContext,
	ConflictResolutionResult,
} from "./conflict-resolver";
import type { VerifiedConflictOutput } from "./conflict";
import type { Logger } from "../logging/logger";
import { commitAction } from "./state-committer";
import { resolveConflict } from "./conflict-resolver";
import { AuthError, classifyHttpError } from "../fs/errors";
import type { ErrorClassification } from "../fs/errors";
import { AsyncPool, AdaptivePool } from "../queue/async-queue";
import type { AdaptivePoolOpts } from "../queue/async-queue";
import { decideRetry, sleep } from "./error";
import type { CompletedAction, ExecutionResult, SupersededAction } from "./execution-result";
import { orderedChildReceipts } from "./execution-result";
import type { NormalActionPermit } from "./priority-coordinator";
import type { LocalMutationBarrier } from "./local-mutation-barrier";
import { sameSynchronizedContent } from "./content-identity";
import { hasChanged, hasRemoteChanged } from "./change-compare";
export type { BlockedAction, CompletedAction, ExecutionResult, FailedAction, ResolvedConflict } from "./execution-result";
export { toConflictRecords } from "./execution-result";

const terminalActionProofBrand: unique symbol = Symbol("TerminalActionProof");

/** Executor-owned proof seam consumed by the state committer in the following unit. */
export interface TerminalActionProof {
	readonly [terminalActionProofBrand]: true;
	readonly action: SyncAction & { readonly oldPath?: string };
	readonly localEntity: FileEntity;
	readonly remoteEntity: FileEntity;
	readonly intendedContent?: ArrayBuffer;
	readonly verifiedOutputs: readonly VerifiedConflictOutput[];
}

class TerminalInvariantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TerminalInvariantError";
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
	beginAction?: (action: SyncAction) => "run" | "invalidated" | SupersededAction;
	/** Publish a fatal terminal state before releasing the action permit. */
	onActionFatal?: (action: SyncAction, error: Error) => void;
	mutationBarrier?: LocalMutationBarrier;
	onPhaseChange?: (phase: "transfer" | "conflict" | "structural") => void;
	/** Test seam and dependency boundary for the configured resolver. */
	conflictResolver?: typeof resolveConflict;
}

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
 * Max concurrent independent same-key match commits. They issue no
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
 * Preserve Admission's component order through successful publication. Only
 * independent singleton transfers/matches are pooled; compound effects, including
 * conflict siblings and structural namespaces, run in one exclusive serial interval.
 */
export async function executePlan(
	plan: AuthorizedSyncPlan,
	ctx: ExecutionContext,
): Promise<ExecutionResult> {
	const result: ExecutionResult = {
		succeeded: [], superseded: [], failed: [], blocked: [], conflicts: [],
	};
	let completed = 0;
	const reportProgress = () => {
		ctx.onProgress?.(++completed, plan.actions.length);
	};
	const independent = plan.components.filter((component) => {
		if (component.paths.length !== 1 || component.actions.length !== 1) return false;
		const action = component.actions[0]!;
		return (!action.publication?.source || action.publication.source.path === action.path) &&
			(action.action === "push" || action.action === "pull" || action.action === "match");
	});
	const pooled = new Set(independent);
	const serial = plan.components.filter((component) => !pooled.has(component));
	ctx.onPhaseChange?.("transfer");
	const transferPool = new AdaptivePool(ctx.transferPool ?? DESKTOP_TRANSFER_POOL);
	const statePool = new AsyncPool(STATE_COMMIT_CONCURRENCY);
	await settleScheduled(independent.map((component) => {
		const action = component.actions[0]!;
		return action.action === "match"
			? statePool.run(() => executeAction(action, ctx, result, reportProgress))
			: transferPool.run(() => executeAction(action, ctx, result, reportProgress,
				() => transferPool.noteRateLimit()), transferSize(action));
	}));
	if (serial.length === 0) return result;

	// Close priority eligibility before draining already-running work. Holding
	// its normal permit across this interval also excludes newly queued priority
	// work; nested actions must not reacquire a permit while that work is waiting.
	ctx.onPhaseChange?.("structural");
	const permit = await ctx.acquireActionPermit?.();
	const serialContext = { ...ctx, acquireActionPermit: undefined };
	try {
		for (const component of serial) {
			let prefixFailed = false;
			for (const action of component.actions) {
				if (prefixFailed) {
					result.blocked.push({ action, reason: "component prefix did not publish" });
					reportProgress();
					continue;
				}
				const incompleteBefore = result.failed.length + result.blocked.length;
				if (action.action === "conflict") {
					await executeConflictAction(action, serialContext, result, reportProgress);
				} else {
					await executeAction(action, serialContext, result, reportProgress);
				}
				prefixFailed = result.failed.length + result.blocked.length !== incompleteBefore;
			}
		}
	} finally {
		permit?.release();
	}
	return result;
}

interface FirstFailure {
	observed: boolean;
	error: unknown;
}

/** Preserve the first observed rejection while waiting for every scheduled peer. */
async function settleScheduled(
	tasks: Promise<unknown>[],
	firstFailure: FirstFailure = { observed: false, error: undefined },
): Promise<void> {
	const observed = tasks.map((task) => task.catch((err: unknown) => {
		if (!firstFailure.observed) {
			firstFailure.observed = true;
			firstFailure.error = err;
		}
		throw err;
	}));
	await Promise.allSettled(observed);
	if (firstFailure.observed) throw firstFailure.error;
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
			const failure = err instanceof ContentProofError && err.kind !== "proof_mismatch" && err.cause instanceof Error ? err.cause : err;
			if (failure instanceof AuthError || failure instanceof ContentProofError) throw failure;
			const classification = classify(failure);
			const decision = decideRetry(classification, attempt, MAX_ACTION_RETRIES, rng);
			if (decision.action !== "retry") throw failure;
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
		if (typeof start !== "string") {
			result.superseded.push(start);
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
			await checkPublicationInputs(action, ctx, result.succeeded);
			const entities = action.action === "rename_local" || action.action === "rename_remote"
				? await io()
				: await withIoRetry(io, ctx, onRateLimit);
			const terminalProof = await proveAdmittedTerminal(action, ctx, entities, result.succeeded);
			const terminalLocal = terminalProof?.localEntity ?? entities.localEntity;
			const terminalRemote = terminalProof?.remoteEntity ?? entities.remoteEntity;
			const terminalRecord = await commitAction(action, terminalLocal, terminalRemote,
				ctx.committer, terminalProof, result.succeeded);
			return { localEntity: terminalLocal, remoteEntity: terminalRemote, terminalProof, terminalRecord };
		};
		const paths = localMutationPaths(action);
		const { localEntity, remoteEntity, terminalProof, terminalRecord } = ctx.mutationBarrier && paths.length > 0
			? await ctx.mutationBarrier.run(paths, execute)
			: await execute();
		result.succeeded.push({ action, localEntity, remoteEntity, terminalProof, terminalRecord });
	} catch (err) {
		if (err instanceof TerminalInvariantError) {
			ctx.onActionFatal?.(action, err);
			throw err;
		}
		if (err instanceof ContentProofError && err.kind === "proof_mismatch") {
			ctx.logger?.warn("executePlan: action blocked", { path: action.path, action: action.action, reason: err.message });
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
	if (action.action === "pull" || action.action === "delete_local" || action.action === "conflict") {
		return [action.localPath ?? action.path];
	}
	if (action.action !== "rename_local") return [];
	return [action.oldPath, action.path,
		...(action.descendants?.flatMap(({ oldPath, newPath }) => [oldPath, newPath]) ?? [])];
}

async function runActionIO(
	action: SyncAction,
	ctx: ExecutionContext,
): Promise<{ localEntity?: FileEntity; remoteEntity?: FileEntity; intendedContent?: ArrayBuffer }> {
	if ((action.action === "rename_local" || action.action === "rename_remote") &&
		(action.content || action.descendantRecords)) return runAdmittedRenameIO(action, ctx);
	const { localFs, remoteFs } = ctx;
	const { path } = action;

	switch (action.action) {
		case "push":
		case "pull": {
			const pushing = action.action === "push";
			const expected = pushing ? action.local : action.remote;
			if (!expected) throw new Error(`${action.action} action requires source entity: ${path}`);
			const source = pushing ? localFs : remoteFs;
			const target = pushing ? remoteFs : localFs;
			const targetPath = (pushing ? action.remotePath : action.localPath) ?? path;
			const { content } = await captureContentSnapshot(source, expected.path, expected);
			// Reading may yield to local edits or another writer. Revalidate the
			// captured destination and record expectations before destructive use.
			await checkPublicationInputs(action, ctx, []);
			await target.write(targetPath, content.slice(0), expected.mtime);
			const [localEntity, remoteEntity] = await Promise.all([
				localFs.stat(action.localPath ?? action.local?.path ?? path),
				remoteFs.stat(action.remotePath ?? action.remote?.path ?? path),
			]);
			if (!localEntity || !remoteEntity) throw new ContentProofError("proof_mismatch", "Transfer terminal endpoint disappeared");
			return { localEntity, remoteEntity, intendedContent: content };
		}

		case "match": {
			return {};
		}

		case "rename_remote":
		case "rename_local":
			throw new Error(`Rename action omitted its admitted execution inputs: ${path}`);

		case "delete_remote": {
			await remoteFs.delete(action.remotePath ?? path);
			return {};
		}

		case "delete_local": {
			await localFs.delete(action.localPath ?? path);
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

async function checkPublicationInputs(action: SyncAction, ctx: ExecutionContext, completed: readonly CompletedAction[]): Promise<void> {
	if (!action.publication && !((action.action === "rename_local" || action.action === "rename_remote") && action.descendantRecords)) {
		throw new ContentProofError("proof_mismatch", `Admission publication inputs missing: ${action.path}`);
	}
	const store = ctx.committer.stateStore;
	const checkRecord = async (path: string, expected: import("./types").SyncRecord | undefined) => {
		if (JSON.stringify(await store.get(path)) !== JSON.stringify(expected)) {
			throw new ContentProofError("proof_mismatch", `Publication precondition changed: ${path}`);
		}
	};
	if (action.publication) {
		const { source, destination } = action.publication;
		await checkRecord(action.path, destination);
		if (source && source.path !== action.path) await checkRecord(source.path, source);
		for (const [fs, expected, address] of [
			[ctx.localFs, action.local, action.localPath ?? action.path],
			[ctx.remoteFs, action.remote, action.remotePath ?? action.path],
		] as const) {
			if (expected) await unchangedEndpoint(fs, expected);
			else if (await fs.stat(address)) {
				throw new ContentProofError("proof_mismatch", `Previously absent endpoint appeared: ${address}`);
			}
		}
	}
	if ((action.action === "rename_local" || action.action === "rename_remote") && action.descendantRecords) {
		for (const { child, receipt } of orderedChildReceipts(action, completed)) {
			const source = child.after ? receipt?.terminalRecord : child.source;
			if (!source) throw new ContentProofError("proof_mismatch", `Child publication missing: ${child.oldPath}`);
			await checkRecord(source.path, source);
			if (source.path !== child.newPath) await checkRecord(child.newPath, child.destination);
		}
	}
}

async function unchangedEndpoint(fs: IFileSystem, expected: FileEntity): Promise<FileEntity> {
	const current = await fs.stat(expected.path);
	if (!isExactPath(current, expected.path) || current.isDirectory !== expected.isDirectory ||
		(expected.identityKey && current.identityKey !== expected.identityKey) ||
		(expected.remoteChecksum && current.remoteChecksum &&
			(expected.remoteChecksum.algo !== current.remoteChecksum.algo ||
				expected.remoteChecksum.value !== current.remoteChecksum.value)) ||
		(!expected.isDirectory && (current.size !== expected.size ||
			(expected.hash && current.hash ? expected.hash !== current.hash :
				expected.remoteChecksum && current.remoteChecksum
					? expected.remoteChecksum.algo !== current.remoteChecksum.algo || expected.remoteChecksum.value !== current.remoteChecksum.value
					: current.mtime !== expected.mtime)))) {
		throw new ContentProofError("proof_mismatch", `Endpoint changed before execution: ${expected.path}`);
	}
	return current;
}

/** One rename-then-copy protocol for either direction. Capture precedes mutation. */
async function runAdmittedRenameIO(action: RenameAction, ctx: ExecutionContext) {
	if (!action.local || !action.remote) throw new ContentProofError("proof_mismatch", "Rename endpoints missing");
	const moving = action.action === "rename_local" ? ctx.localFs : ctx.remoteFs;
	await Promise.all([
		unchangedEndpoint(ctx.localFs, action.local), unchangedEndpoint(ctx.remoteFs, action.remote),
	]);
	const destination = await moving.stat(action.path);
	if (destination && destination.path !== action.oldPath) {
		throw new ContentProofError("proof_mismatch", `Rename destination occupied: ${action.path}`);
	}
	let content: ArrayBuffer | undefined;
	if (action.content?.mode === "copy") {
		const read = action.content.read;
		const fs = read.side === "local" ? ctx.localFs : ctx.remoteFs;
		content = (await captureContentSnapshot(fs, read.entity.path, read.entity)).content;
		await unchangedEndpoint(fs, read.entity);
	}
	await unchangedEndpoint(moving, action.action === "rename_local" ? action.local : action.remote);
	await moving.rename(action.oldPath, action.path);
	if (content && action.content?.mode === "copy") {
		const write = action.content.write;
		await (write.side === "local" ? ctx.localFs : ctx.remoteFs).write(write.path, content.slice(0), action.content.read.entity.mtime);
	}
	const [localEntity, remoteEntity] = await Promise.all([
		ctx.localFs.stat(action.path), ctx.remoteFs.stat(action.path),
	]);
	if (!isExactPath(localEntity, action.path) || !isExactPath(remoteEntity, action.path) ||
		(action.remote.identityKey && remoteEntity.identityKey !== action.remote.identityKey)) {
		throw new ContentProofError("proof_mismatch", "Rename terminal identity changed");
	}
	return { localEntity, remoteEntity, intendedContent: content };
}

async function proveAdmittedTerminal(
	action: SyncAction, ctx: ExecutionContext,
	entities: { localEntity?: FileEntity; remoteEntity?: FileEntity; intendedContent?: ArrayBuffer },
	completed: readonly CompletedAction[] = [],
): Promise<TerminalActionProof | undefined> {
	if (action.action === "cleanup" || action.action === "delete_local" || action.action === "delete_remote") return undefined;
	const localPath = action.localPath ?? (action.action === "rename_local" || action.action === "rename_remote" || action.action === "conflict"
		? action.path : action.local?.path ?? action.path);
	const remotePath = action.remotePath ?? action.path;
	const localEntity = isExactPath(entities.localEntity ?? null, localPath)
		? entities.localEntity! : await ctx.localFs.stat(localPath);
	const remoteEntity = isExactPath(entities.remoteEntity ?? null, remotePath)
		? entities.remoteEntity! : await ctx.remoteFs.stat(remotePath);
	if (!isExactPath(localEntity, localPath) || !isExactPath(remoteEntity, remotePath)) {
		throw new ContentProofError("proof_mismatch", "Terminal endpoints missing");
	}
	const identity = action.remoteIdentitySource?.identityKey ?? action.remote?.identityKey;
	if (identity && remoteEntity.identityKey !== identity) {
		throw new ContentProofError("proof_mismatch", "Terminal remote identity changed");
	}
	if (localEntity.isDirectory !== remoteEntity.isDirectory) {
		throw new ContentProofError("proof_mismatch", "Terminal endpoint kinds differ");
	}
	if ((action.action === "rename_local" || action.action === "rename_remote") && action.descendantRecords) {
		await proveFolderDescendants(action, ctx, completed);
	}
	if (!localEntity.isDirectory || !remoteEntity.isDirectory) {
		if (localEntity.size !== remoteEntity.size) throw new ContentProofError("proof_mismatch", "Terminal sizes differ");
		if (entities.intendedContent) {
			for (const [fs, entity] of [[ctx.localFs, localEntity], [ctx.remoteFs, remoteEntity]] as const) {
				if (!await bytesMatch(entities.intendedContent, entity) &&
					!buffersEqual(entities.intendedContent, await fs.read(entity.path))) {
					throw new ContentProofError("proof_mismatch", "Rename terminal bytes changed");
				}
			}
		} else if (!sameSynchronizedContent(localEntity, remoteEntity, action.baseline)) {
			const content = await ctx.localFs.read(localPath);
			if (!await bytesMatch(content, remoteEntity)) {
				if (!buffersEqual(content, await ctx.remoteFs.read(remotePath))) {
					throw new ContentProofError("proof_mismatch", "Terminal content differs");
				}
			}
		}
	}
	return Object.freeze({ [terminalActionProofBrand]: true as const, action, localEntity, remoteEntity,
		intendedContent: entities.intendedContent, verifiedOutputs: [] });
}

/** Prove the admitted suffix mapping against successful child receipts before bulk publication. */
async function proveFolderDescendants(action: RenameAction, ctx: ExecutionContext, completed: readonly CompletedAction[]) {
	const retainedPaths = new Set<string>();
	for (const { child, receipt } of orderedChildReceipts(action, completed)) {
		retainedPaths.add(child.newPath);
		const record = child.after ? receipt?.terminalRecord : child.source;
		const [local, remote] = await Promise.all([ctx.localFs.stat(child.newPath), ctx.remoteFs.stat(child.newPath)]);
		if (!record || !isExactPath(local, child.newPath) || !isExactPath(remote, child.newPath) ||
			local.isDirectory || remote.isDirectory ||
			(record.remoteIdentityKey && remote.identityKey !== record.remoteIdentityKey) ||
			hasChanged(local, record) || hasRemoteChanged(remote, record) || !sameSynchronizedContent(local, remote, record)) {
			throw new ContentProofError("proof_mismatch", `Folder descendant changed: ${child.newPath}`);
		}
		for (const output of receipt?.terminalProof?.verifiedOutputs ?? []) {
			for (const [side, fs] of [["local", ctx.localFs], ["remote", ctx.remoteFs]] as const) {
				const moved = action.action === `rename_${side}`;
				const path = moved && output.path.startsWith(action.oldPath + "/")
					? action.path + output.path.slice(action.oldPath.length) : output.path;
				const entity = await fs.stat(path);
				// A preservation address may resolve through a case alias on the
				// unmoved side. Its bytes, not caller spelling, are the obligation.
				if (!entity || entity.isDirectory ||
					(!await bytesMatch(output.sourceContent, entity) && !buffersEqual(output.sourceContent, await fs.read(path)))) {
					throw new ContentProofError("proof_mismatch", `Folder preservation output changed: ${path}`);
				}
			}
		}
	}
	for (const child of action.descendants ?? []) {
		if (retainedPaths.has(child.newPath)) continue;
		const [local, remote] = await Promise.all([ctx.localFs.stat(child.newPath), ctx.remoteFs.stat(child.newPath)]);
		if (local || remote) throw new ContentProofError("proof_mismatch", `Deleted folder descendant appeared: ${child.newPath}`);
	}
}

function isExactPath(entity: FileEntity | null, path: string): entity is FileEntity {
	return entity?.path === path && entity.pathAuthority === "actual_resolved";
}

function buffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) return false;
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	return a.every((value, index) => value === b[index]);
}

function verifiedConflictOutputs(
	action: SyncAction,
	resolution: ConflictResolutionResult,
): readonly VerifiedConflictOutput[] {
	const requiresCopies = resolution.action === "duplicated" && !!action.local ||
		!!action.remoteIdentitySource && action.remoteIdentitySource.path !== action.path || !!action.additionalRemote || !!action.additionalLocal ||
		!!action.local && action.local.path !== action.path || !!action.remote && action.remote.path !== action.path;
	const expected = action.remote && requiresCopies ? [
		{ role: "primary" as const, sourcePath: action.remotePath ?? action.remote.path },
		...(action.additionalRemote
			? [{ role: "additional" as const, sourcePath: action.additionalRemote.path }]
			: []),
		...(action.additionalLocal
			? [{ role: "local" as const, sourcePath: action.additionalLocal.path }] : []),
	] : [];
	const actual = resolution.verifiedOutputs;
	if (!actual || actual.length !== expected.length ||
		new Set(actual.map(({ path }) => path)).size !== actual.length ||
		actual.some((output, index) => output.role !== expected[index]?.role ||
			output.sourcePath !== expected[index]?.sourcePath)) {
		throw new ContentProofError(
			"proof_mismatch", `Conflict preservation coverage mismatch: ${action.path}`,
		);
	}
	return actual;
}

function makeTerminalProof(
	action: SyncAction,
	localEntity: FileEntity,
	remoteEntity: FileEntity,
	intendedContent: ArrayBuffer,
	verifiedOutputs: readonly VerifiedConflictOutput[],
): TerminalActionProof {
	return Object.freeze({
		[terminalActionProofBrand]: true as const,
		action,
		localEntity: Object.freeze({ ...localEntity }),
		remoteEntity: Object.freeze({ ...remoteEntity }),
		intendedContent: intendedContent.slice(0),
		verifiedOutputs,
	});
}

async function executePreparedConflictEffects(
	action: SyncAction,
	ctx: ExecutionContext,
	resolution: ConflictResolutionResult,
): Promise<{
	localEntity: FileEntity;
	remoteEntity: FileEntity;
	terminalProof: TerminalActionProof;
}> {
	const outputs = verifiedConflictOutputs(action, resolution);
	if (!resolution.targetContent) {
		throw new TerminalInvariantError(`Fresh resolver omitted target content: ${action.path}`);
	}
	const intended = resolution.targetContent.slice(0);
	const source = action.remoteIdentitySource;
	const rotationRequired = !!source && source.path !== action.path;
	const trackedSourceIdentity = source?.identityKey;
	// The source is an exact admitted current endpoint, never inferred from a
	// historical baseline or a prior attempt's decision classification.
	if (action.local) await unchangedEndpoint(ctx.localFs, action.local);
	if (action.remote) await unchangedEndpoint(ctx.remoteFs, action.remote);
	for (const [fs, entity, snapshot] of [
		[ctx.localFs, action.local, resolution.capturedInputs?.local],
		[ctx.remoteFs, action.remote, resolution.capturedInputs?.remote],
	] as const) {
		if (!entity) continue;
		if (!snapshot) throw new TerminalInvariantError(`Resolver omitted captured input: ${entity.path}`);
		await assertPreservedSourceUnchanged(fs, entity.path, entity.identityKey,
			{ sourcePath: snapshot.path, sourceEntity: snapshot.entity, sourceContent: snapshot.content });
	}
	const localTarget = action.localPath ?? action.path;
	const remoteTarget = action.remotePath ?? action.path;
	const localMove = action.local && action.local.path !== localTarget;
	if (localMove) {
		const occupant = await ctx.localFs.stat(localTarget);
		if (occupant && occupant.path !== action.local!.path) {
			throw new ContentProofError("proof_mismatch", `Conflict local destination changed: ${localTarget}`);
		}
	}

	const additionalOutput = outputs.find((output) => output.role === "additional");
	const localOutput = outputs.find((output) => output.role === "local");
	if (action.additionalLocal) {
		if (!localOutput) throw new TerminalInvariantError(`Local preservation proof missing: ${action.path}`);
		await assertPreservedSourceUnchanged(ctx.localFs, action.additionalLocal.path, action.additionalLocal.identityKey, localOutput);
	}
	if (action.additionalRemote) {
		if (!additionalOutput) throw new TerminalInvariantError(`Conflict omitted target snapshot: ${action.path}`);
		await assertPreservedSourceUnchanged(ctx.remoteFs, remoteTarget, action.additionalRemote.identityKey, additionalOutput);
	} else if ((rotationRequired || !action.remote) && await ctx.remoteFs.stat(remoteTarget)) {
		throw new ContentProofError(
			"proof_mismatch", `Conflict destination changed: ${remoteTarget}`,
		);
	}

	if (rotationRequired) {
		// Delete only the admitted, preserved occupant, never one discovered during execution.
		if (action.additionalRemote) await ctx.remoteFs.delete(action.path);
		await ctx.remoteFs.rename(source.path, action.path);
	}
	if (localMove) await ctx.localFs.rename(action.local!.path, localTarget);

	const mtime = resolution.targetMtime ?? action.local?.mtime ?? 0;
	await ctx.localFs.write(localTarget, intended.slice(0), mtime);
	await ctx.remoteFs.write(remoteTarget, intended.slice(0), mtime);
	const [localEntity, remoteEntity, sourceAfter] = await Promise.all([
		ctx.localFs.stat(localTarget), ctx.remoteFs.stat(remoteTarget),
		rotationRequired ? ctx.remoteFs.stat(source.path) : Promise.resolve(null),
	]);
	if (!localEntity || !remoteEntity || sourceAfter) {
		throw new ContentProofError("proof_mismatch", `Fresh conflict terminal bytes mismatch: ${action.path}`);
	}
	if (trackedSourceIdentity && remoteEntity.identityKey !== trackedSourceIdentity) {
		throw new ContentProofError("proof_mismatch", `Fresh conflict terminal identity mismatch: ${action.path}`);
	}
	await proveAdmittedTerminal(action, ctx, { localEntity, remoteEntity, intendedContent: intended });
	for (const output of outputs) {
		for (const fs of [ctx.localFs, ctx.remoteFs]) {
			const entity = await fs.stat(output.path);
			// The allocated address may resolve through an existing case-only parent alias.
			// Prove stored bytes here; only Admission's original endpoints govern topology.
			if (!entity || entity.isDirectory ||
				(!await bytesMatch(output.sourceContent, entity) && !buffersEqual(output.sourceContent, await fs.read(output.path)))) {
				throw new ContentProofError("proof_mismatch", `Conflict preservation output changed: ${output.path}`);
			}
		}
	}
	const terminalProof = makeTerminalProof(
		action, localEntity, remoteEntity, intended, outputs,
	);
	return { localEntity, remoteEntity, terminalProof };
}

async function assertPreservedSourceUnchanged(
	remoteFs: IFileSystem,
	path: string,
	expectedIdentity: string | undefined,
	output: Pick<VerifiedConflictOutput, "sourcePath" | "sourceEntity" | "sourceContent">,
): Promise<void> {
	const current = await remoteFs.stat(path);
	if (!current || output.sourcePath !== path ||
		current.identityKey !== expectedIdentity ||
		output.sourceEntity.identityKey !== expectedIdentity) {
		throw new ContentProofError("proof_mismatch", `Fresh conflict source changed: ${path}`);
	}
	if (!await bytesMatch(output.sourceContent, current) &&
		!buffersEqual(await remoteFs.read(path), output.sourceContent)) {
		throw new ContentProofError("proof_mismatch", `Fresh conflict source bytes changed: ${path}`);
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
		if (typeof start !== "string") {
			result.superseded.push(start);
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
			localPath: action.local?.path,
			remotePath: action.remote?.path,
			baseline: action.baseline,
			stateStore: action.baseline && (!action.baseline.remoteIdentityKey ||
				action.remote?.identityKey === action.baseline.remoteIdentityKey) ? ctx.committer.stateStore : undefined,
			logger: ctx.logger,
			remoteIdentitySource: action.remoteIdentitySource,
			additionalRemote: action.additionalRemote,
			additionalLocal: action.additionalLocal,
			baselinePath: action.baseline?.path,
		};

		// No in-cycle retry: conflict resolution (the `duplicate` strategy) is NOT
		// idempotent on replay — after a partial write, generateConflictPath would pick
		// a fresh `.conflict-N` name, orphaning the first backup. A rate-limited resolve
		// fails the action and re-resolves next cycle (it runs serially and never feeds
		// the transfer pool's AIMD).
		const execute = async () => {
			await checkPublicationInputs(action, ctx, result.succeeded);
			const resolution = await (ctx.conflictResolver ?? resolveConflict)(
				conflictCtx, ctx.conflictStrategy,
			);
			const { localEntity, remoteEntity, terminalProof } = await executePreparedConflictEffects(action, ctx, resolution);
			const terminalRecord = await commitAction(action, localEntity, remoteEntity, ctx.committer,
				terminalProof, result.succeeded);
			return { resolution, localEntity, remoteEntity, terminalProof, terminalRecord };
		};
		const mutationPaths = action.remoteIdentitySource
			? [action.path, action.remoteIdentitySource.path]
			: [action.path];
		const { resolution, localEntity, remoteEntity, terminalProof, terminalRecord } = ctx.mutationBarrier
			? await ctx.mutationBarrier.run(mutationPaths, execute)
			: await execute();

		result.conflicts.push({ action, resolution, localEntity, remoteEntity, terminalProof });
		result.succeeded.push({ action, localEntity, remoteEntity, terminalProof, terminalRecord });
	} catch (err) {
		if (err instanceof TerminalInvariantError) {
			ctx.onActionFatal?.(action, err);
			throw err;
		}
		if (err instanceof ContentProofError && err.kind === "proof_mismatch") {
			ctx.logger?.warn("executePlan: conflict blocked", { path: action.path, reason: err.message });
			result.blocked.push({ action, reason: err.message });
			return;
		}
		if (err instanceof ContentProofError && err.kind === "external_auth_failure") {
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
