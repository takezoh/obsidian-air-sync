import type { IFileSystem } from "../fs/interface";
import type { FileEntity, RemoteChecksum } from "../fs/types";
import type { SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";
import { getFileExtension } from "../utils/path";
import { isMergeEligible, threeWayMerge } from "./merge";

/** Internal strategy used by the low-level conflict resolver */
export type ResolverStrategy = "keep_newer" | "keep_local" | "keep_remote" | "duplicate" | "auto_merge";

export interface ConflictResolutionResult {
	/** The action that was taken */
	action: "kept_local" | "kept_remote" | "duplicated" | "merged";
	/** If a duplicate was created, its path */
	duplicatePath?: string;
	/** True if the merged result contains unresolved conflict markers */
	hasConflictMarkers?: boolean;
}

export interface ConflictContext {
	path: string;
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	local?: FileEntity;
	remote?: FileEntity;
	prevSync?: SyncRecord;
	stateStore?: SyncStateStore;
	logger?: Logger;
}

export type FallbackResolver = ResolverStrategy | (() => Promise<ResolverStrategy>);

export async function resolveWithStrategy(
	ctx: ConflictContext,
	strategy: ResolverStrategy,
	fallback?: FallbackResolver,
): Promise<ConflictResolutionResult> {
	const { path, localFs, remoteFs, local, remote } = ctx;

	switch (strategy) {
		case "keep_local":
			return keepLocal(path, localFs, remoteFs, local);

		case "keep_remote":
			return keepRemote(path, localFs, remoteFs, remote);

		case "keep_newer":
			return keepNewer(path, localFs, remoteFs, local, remote);

		case "duplicate":
			return duplicate(path, localFs, remoteFs, local, remote);

		case "auto_merge":
			return attemptThreeWayMerge(ctx, fallback ?? "keep_newer");
	}
}

async function keepLocal(
	path: string,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	local?: FileEntity
): Promise<ConflictResolutionResult> {
	if (local) {
		const content = await localFs.read(path);
		await remoteFs.write(path, content, local.mtime);
	} else {
		await remoteFs.delete(path);
	}
	return { action: "kept_local" };
}

async function keepRemote(
	path: string,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	remote?: FileEntity
): Promise<ConflictResolutionResult> {
	if (remote) {
		const content = await remoteFs.read(path);
		await localFs.write(path, content, remote.mtime);
	} else {
		await localFs.delete(path);
	}
	return { action: "kept_remote" };
}

async function keepNewer(
	path: string,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	local?: FileEntity,
	remote?: FileEntity,
): Promise<ConflictResolutionResult> {
	// If one side is deleted, the other side wins
	if (!local && remote) {
		return keepRemote(path, localFs, remoteFs, remote);
	}
	if (local && !remote) {
		return keepLocal(path, localFs, remoteFs, local);
	}
	if (!local && !remote) {
		return { action: "kept_local" };
	}

	// Both exist — compare mtime only when both are known (> 0)
	if (local!.mtime > 0 && remote!.mtime > 0) {
		if (local!.mtime > remote!.mtime) {
			return keepLocal(path, localFs, remoteFs, local);
		}
		if (local!.mtime < remote!.mtime) {
			return keepRemote(path, localFs, remoteFs, remote);
		}
	}
	// Same mtime or unknown mtime: compare by content hash — if identical, keep local; otherwise tieBreak.
	// Remote FileEntity.hash is "" for backends that don't compute it on list/stat (e.g. Google Drive);
	// fall back to remoteChecksum in that case.
	if (sameContent(local!, remote!)) {
		return keepLocal(path, localFs, remoteFs, local); // content identical
	}
	return duplicate(path, localFs, remoteFs, local, remote);
}

async function duplicate(
	path: string,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	local?: FileEntity,
	remote?: FileEntity
): Promise<ConflictResolutionResult> {
	// Delete-vs-modify: local deleted, remote has content → restore remote version locally
	if (!local && remote) {
		const remoteContent = await remoteFs.read(path);
		await localFs.write(path, remoteContent, remote.mtime);
		return { action: "duplicated" };
	}

	// Delete-vs-modify: remote deleted, local has content → restore local version remotely
	if (local && !remote) {
		const localContent = await localFs.read(path);
		await remoteFs.write(path, localContent, local.mtime);
		return { action: "duplicated" };
	}

	// Both deleted — nothing to do
	if (!local && !remote) {
		return { action: "kept_local" };
	}

	// Both exist: save remote as .conflict duplicate on both sides, keep local at original path
	const remoteContent = await remoteFs.read(path);
	const duplicatePath = await generateConflictPath(path, localFs, remoteFs);
	await localFs.write(duplicatePath, remoteContent, remote!.mtime);
	await remoteFs.write(duplicatePath, remoteContent, remote!.mtime);

	const localContent = await localFs.read(path);
	await remoteFs.write(path, localContent, local!.mtime);

	return { action: "duplicated", duplicatePath };
}

/** Generate a conflict file path with sequential numbering to avoid overwrites.
 *  e.g. "notes/file.conflict.md" → "notes/file.conflict-2.md" if the first exists.
 *  Checks all provided filesystems to prevent overwriting on any side.
 */
export async function generateConflictPath(
	path: string,
	...filesystems: IFileSystem[]
): Promise<string> {
	const existsOnAny = async (candidate: string): Promise<boolean> => {
		for (const fs of filesystems) {
			if (await fs.stat(candidate)) return true;
		}
		return false;
	};

	const candidate = insertConflictSuffix(path, 1);
	if (!(await existsOnAny(candidate))) return candidate;

	for (let i = 2; i <= 100; i++) {
		const numbered = insertConflictSuffix(path, i);
		if (!(await existsOnAny(numbered))) return numbered;
	}
	// Extremely unlikely; fall through with timestamp (still check for collision)
	const tsPath = insertConflictSuffix(path, Date.now());
	if (!(await existsOnAny(tsPath))) return tsPath;
	return insertConflictSuffix(path, `${Date.now()}-${Math.floor(Math.random() * 1000)}`);
}

function insertConflictSuffix(path: string, seq: number | string): string {
	const suffix = seq === 1 ? ".conflict" : `.conflict-${seq}`;
	const lastDot = path.lastIndexOf(".");
	if (lastDot === -1 || lastDot <= path.lastIndexOf("/")) {
		return `${path}${suffix}`;
	}
	return `${path.substring(0, lastDot)}${suffix}${path.substring(lastDot)}`;
}

async function attemptThreeWayMerge(
	ctx: ConflictContext,
	fallback: FallbackResolver = "keep_newer",
): Promise<ConflictResolutionResult> {
	const { path, localFs, remoteFs, local, remote, prevSync, stateStore, logger } = ctx;
	const tag = "auto_merge";

	logger?.debug(`${tag}: attempting 3-way merge`, { path });

	const resolveFallback = async (): Promise<ResolverStrategy> => {
		return typeof fallback === "function" ? await fallback() : fallback;
	};

	// Must have both sides present and a previous sync record
	if (!local || !remote || !prevSync) {
		const fb = await resolveFallback();
		logger?.warn(`${tag}: falling back — missing prerequisites`, {
			path,
			strategy: tag,
			reason: `missing: ${[!local && "local", !remote && "remote", !prevSync && "prevSync"].filter(Boolean).join(", ")}`,
			outcome: fb,
		});
		return resolveWithStrategy(ctx, fb);
	}

	// Retrieve the stored base content
	const prevSyncContent = stateStore ? await stateStore.getContent(path) : undefined;
	if (!prevSyncContent) {
		const fb = await resolveFallback();
		logger?.warn(`${tag}: falling back — no base content in state store`, {
			path,
			strategy: tag,
			reason: stateStore ? "base content not found in store" : "no state store provided",
			outcome: fb,
		});
		return resolveWithStrategy(ctx, fb);
	}

	if (!isMergeEligible(path, Math.max(local.size, remote.size))) {
		const fb = await resolveFallback();
		logger?.warn(`${tag}: falling back — file not eligible for merge`, {
			path,
			strategy: tag,
			reason: `not a mergeable text file (localSize=${local.size}, remoteSize=${remote.size})`,
			outcome: fb,
		});
		return resolveWithStrategy(ctx, fb);
	}

	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	const baseText = decoder.decode(prevSyncContent);
	const localContent = await localFs.read(path);
	const localText = decoder.decode(localContent);
	const remoteContent = await remoteFs.read(path);
	const remoteText = decoder.decode(remoteContent);

	let mergeResult;
	try {
		mergeResult = threeWayMerge(baseText, localText, remoteText);
	} catch (mergeErr) {
		const fb = await resolveFallback();
		logger?.warn(`${tag}: falling back — merge threw an exception`, {
			path,
			strategy: tag,
			reason: mergeErr instanceof Error ? mergeErr.message : String(mergeErr),
			outcome: fb,
		});
		return resolveWithStrategy(ctx, fb);
	}

	logger?.debug(`${tag}: merge complete`, {
		path,
		success: mergeResult.success,
		hasConflicts: mergeResult.hasConflicts,
		baseLines: baseText.split("\n").length,
		localLines: localText.split("\n").length,
		remoteLines: remoteText.split("\n").length,
		mergedLines: mergeResult.content.split("\n").length,
	});

	// For JSON/Canvas files, validate the merge result
	const ext = getFileExtension(path);
	if (ext === ".json" || ext === ".canvas") {
		if (mergeResult.hasConflicts || !isValidJson(mergeResult.content)) {
			logger?.warn(`${tag}: falling back — merged ${ext} is invalid`, {
				path,
				strategy: tag,
				reason: mergeResult.hasConflicts ? "merge produced conflict markers" : "merged content is not valid JSON",
				outcome: "duplicate",
			});
			return duplicate(path, localFs, remoteFs, local, remote);
		}
	}

	const mergedBuffer = encoder.encode(mergeResult.content).buffer.slice(0);

	// Write merged content to both sides (with rollback if remote fails)
	const now = Date.now();
	await localFs.write(path, mergedBuffer, now);
	try {
		await remoteFs.write(path, mergedBuffer, now);
	} catch (remoteWriteErr) {
		// Restore local to pre-merge state
		try {
			await localFs.write(path, encoder.encode(localText).buffer.slice(0), local.mtime);
		} catch (restoreErr) {
			logger?.error("Failed to restore local after merge failure", { path, error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) });
		}
		throw remoteWriteErr;
	}

	return {
		action: "merged",
		hasConflictMarkers: mergeResult.hasConflicts,
	};
}

/**
 * Reduce an entity to a comparable {algo, value} content key, or null if it has
 * none. A local `hash` is SHA-256; a remote backend that returns `hash: ""`
 * exposes its `remoteChecksum` (e.g. Drive md5) instead.
 */
function contentKey(e: FileEntity): RemoteChecksum | null {
	if (e.hash) return { algo: "sha256", value: e.hash };
	if (e.remoteChecksum) return e.remoteChecksum;
	return null;
}

/**
 * Returns true when two FileEntity objects provably represent identical content.
 * Only compares checksums of the SAME algorithm — a local SHA-256 hash and a
 * remote md5 are not comparable, so this returns false (the caller then
 * tie-breaks) rather than risk a cross-algorithm verdict.
 */
function sameContent(a: FileEntity, b: FileEntity): boolean {
	const ka = contentKey(a);
	const kb = contentKey(b);
	return ka !== null && kb !== null && ka.algo === kb.algo && ka.value === kb.value;
}

function isValidJson(content: string): boolean {
	try {
		JSON.parse(content);
		return true;
	} catch {
		return false;
	}
}
