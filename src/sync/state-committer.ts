import { errorMessage } from "../backend-api";
import type { FileEntity } from "../fs/types";
import type { SyncAction, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";
import { isMergeEligible } from "./merge";
import type { TerminalActionProof } from "./plan-executor";
import type { CompletedAction } from "./execution-result";
import { orderedChildReceipts } from "./execution-result";
import { sha256 } from "../utils/hash";

export interface StateCommitterContext {
	stateStore: SyncStateStore;
	localFs?: { read(path: string): Promise<ArrayBuffer> };
	enableThreeWayMerge?: boolean;
	logger?: Logger;
}

/** Publish an Admission-captured stale-record cleanup without creating file-delete authority. */
export async function commitExactCleanup(
	path: string,
	expected: SyncRecord,
	ctx: StateCommitterContext,
): Promise<void> {
	if (!await ctx.stateStore.compareAndDelete(path, expected)) {
		throw new Error(`SyncRecord changed before cleanup: ${path}`);
	}
}

/**
 * Build a SyncRecord from a local and remote FileEntity.
 * Centralised record construction for the sync pipeline.
 *
 * The record layer's identity floor lives here and not in any caller, because every
 * caller writes what it builds: an absent and an empty provider identity are one case
 * and both are refused before any store write. "" is a valid IndexedDB key, so folding
 * an absent identity to it would silently merge two distinct provider objects into one
 * baseline; no site may perform that fold to satisfy the required field.
 */
export function buildSyncRecord(local: FileEntity | undefined, remote: FileEntity | undefined, path: string): SyncRecord {
	const remoteIdentityKey = remote?.identityKey;
	if (!remoteIdentityKey) {
		throw new Error(
			`SyncRecord refused: remote entity carries no provider identity: ${remote?.path ?? "(no remote entity)"} at ${path}`,
		);
	}
	return {
		path,
		hash: local?.hash || remote?.hash || "",
		localMtime: local?.mtime ?? 0,
		remoteMtime: remote?.mtime ?? 0,
		localSize: local?.size ?? 0,
		remoteSize: remote?.size ?? 0,
		remoteChecksum: remote?.remoteChecksum,
		remoteIdentityKey,
		syncedAt: Date.now(),
	};
}

/**
 * Store the local content as a 3-way-merge base, when merge is enabled and the file
 * is eligible. Best-effort: a read/write failure is logged, not propagated — a missing
 * merge base only costs a future conflict resolution, never correctness.
 */
async function maybeStoreMergeBase(
	ctx: StateCommitterContext,
	record: SyncRecord,
	localEntity: FileEntity | undefined,
	provedContent?: ArrayBuffer,
): Promise<void> {
	const { path, localSize: size } = record;
	const { stateStore, localFs, enableThreeWayMerge, logger } = ctx;
	if (!(enableThreeWayMerge && localFs && localEntity && isMergeEligible(path, size))) return;
	try {
		// The record key follows the admitted topology, while the entity path is the
		// filesystem-resolved endpoint from which the successful bytes are readable.
		const content = provedContent?.slice(0) ?? await localFs.read(localEntity.path);
		// The local file may have changed after the admitted I/O. A CAS protects
		// the record, but only byte verification can bind this read to that record.
		if (!record.hash || content.byteLength !== record.localSize ||
			await sha256(content) !== record.hash) return;
		await stateStore.compareAndPutContent(record, content);
	} catch (err) {
		logger?.warn("Failed to store content for 3-way merge", {
			path,
			error: errorMessage(err),
		});
	}
}

/**
 * Commit the state change for a single successfully-executed action.
 *
 * - push/pull/match/conflict → upsert SyncRecord (+ optionally store merge-base content)
 * - delete_local/delete_remote → delete SyncRecord
 * - cleanup → delete SyncRecord
 *
 * Note: this function is only called for successful actions.
 * Failed actions are skipped by the caller; they will be re-detected on the next sync cycle.
 */
export async function commitAction(
	action: SyncAction,
	localEntity: FileEntity | undefined,
	remoteEntity: FileEntity | undefined,
	ctx: StateCommitterContext,
	proof?: TerminalActionProof,
	completed: readonly CompletedAction[] = [],
): Promise<SyncRecord | undefined> {
	const { path } = action;
	const { stateStore } = ctx;
	if ((action.action === "rename_local" || action.action === "rename_remote") && action.descendantRecords) {
		if (proof?.action !== action) throw new Error(`Folder terminal proof missing: ${path}`);
		const relocations = [...orderedChildReceipts(action, completed)].map(({ child: item, receipt }) => {
			const source = item.after ? receipt?.terminalRecord : item.source;
			if (!source) throw new Error(`Child terminal record missing: ${item.oldPath}`);
			return { source, destination: source.path === item.newPath ? source : item.destination,
				terminal: { ...source, path: item.newPath } };
		});
		if (!await stateStore.compareAndRewritePaths(relocations)) throw new Error(`Folder records changed before publication: ${path}`);
		return;
	}
	if (action.publication) {
		const { source, destination } = action.publication;
		if (action.action === "cleanup" || action.action === "delete_local" || action.action === "delete_remote") {
			if (!await stateStore.compareAndDelete(path, destination)) throw new Error(`SyncRecord changed before deletion: ${path}`);
			return;
		}
		const compound = action.action === "rename_local" || action.action === "rename_remote" ||
			(source !== undefined && source.path !== path);
		if (compound && proof?.action !== action) throw new Error(`Terminal publication proof missing: ${path}`);
		const record = buildSyncRecord(localEntity, remoteEntity, path);
		// The two captured expectations are already separate facts: `source` is the row
		// this publication continues and `destination` whatever holds the claimed
		// address. A relocation of one row and a replacement of another are the same
		// call; which one it is follows from the identities, not from a second method.
		const committed = await stateStore.compareAndPut(source, record, destination);
		if (!committed) throw new Error(`SyncRecord changed before terminal publication: ${path}`);
		await maybeStoreMergeBase(ctx, record, localEntity,
			proof?.action === action ? proof.intendedContent : undefined);
		return record;
	}
	throw new Error(`Admission publication inputs missing: ${path}`);
}
