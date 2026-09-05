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

/**
 * Build a SyncRecord from a local and remote FileEntity.
 * Centralised record construction for the sync pipeline.
 */
export function buildSyncRecord(local: FileEntity | undefined, remote: FileEntity | undefined, path: string): SyncRecord {
	return {
		path,
		hash: local?.hash || remote?.hash || "",
		localMtime: local?.mtime ?? 0,
		remoteMtime: remote?.mtime ?? 0,
		localSize: local?.size ?? 0,
		remoteSize: remote?.size ?? 0,
		remoteChecksum: remote?.remoteChecksum,
		remoteIdentityKey: remote?.identityKey,
		backendMeta: remote?.backendMeta,
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
): Promise<void> {
	const { path, localSize: size } = record;
	const { stateStore, localFs, enableThreeWayMerge, logger } = ctx;
	if (!(enableThreeWayMerge && localFs && localEntity && isMergeEligible(path, size))) return;
	try {
		// The record key follows the admitted topology, while the entity path is the
		// filesystem-resolved endpoint from which the successful bytes are readable.
		const content = await localFs.read(localEntity.path);
		// The local file may have changed after the admitted I/O. A CAS protects
		// the record, but only byte verification can bind this read to that record.
		if (!record.hash || content.byteLength !== record.localSize ||
			await sha256(content) !== record.hash) return;
		await stateStore.compareAndPutContent(record, content);
	} catch (err) {
		logger?.warn("Failed to store content for 3-way merge", {
			path,
			error: err instanceof Error ? err.message : String(err),
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
		const committed = source && source.path !== path
			? await stateStore.compareAndMove(source, record, destination)
			: await stateStore.compareAndPut(destination, record);
		if (!committed) throw new Error(`SyncRecord changed before terminal publication: ${path}`);
		await maybeStoreMergeBase(ctx, record, localEntity);
		return record;
	}
	throw new Error(`Admission publication inputs missing: ${path}`);
}
