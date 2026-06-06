import type { PCloudEntry, PCloudDiffEntry } from "./types";
import type { PCloudMetadataCache } from "./metadata-cache";
import type { PCloudClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { RenamePair } from "../../sync/types";
import type { Logger } from "../../logging/logger";

/** Context for incremental sync operations. */
export interface PCloudSyncContext {
	cache: PCloudMetadataCache;
	client: PCloudClient;
	metadataStore?: MetadataStore<PCloudEntry>;
	logger?: Logger;
}

export type PCloudDiffResult =
	| { needsFullScan: false; newDiffId: string; changedPaths: Set<string>; renamedPaths: RenamePair[] }
	| { needsFullScan: true; changedPaths: Set<string> };

/** A remote change delta in the shape the sync engine consumes. */
export interface RemoteDelta {
	modified: string[];
	deleted: string[];
	renamed: RenamePair[];
}

/** Split diff-changed paths into modified (still cached) vs deleted (gone). */
export function classifyChangedPaths(
	cache: PCloudMetadataCache,
	changedPaths: Set<string>,
	renamedPaths: RenamePair[],
): RemoteDelta {
	const modified: string[] = [];
	const deleted: string[] = [];
	for (const path of changedPaths) {
		if (cache.hasEntry(path)) modified.push(path);
		else deleted.push(path);
	}
	return { modified, deleted, renamed: renamedPaths };
}

/**
 * Diff a pre-scan snapshot (path-by-id) against the freshly-scanned cache.
 * Used when the diff cursor is lost (`reset`/expiry) and we re-scan to recover a
 * delta. Detects additions, renames, and deletions — but not in-place content
 * edits (same id, same path), which the next diff or WARM mode catches.
 */
export function computeFullScanDelta(
	oldPathById: Map<string, string>,
	cache: PCloudMetadataCache,
): RemoteDelta | null {
	if (oldPathById.size === 0) return null;
	const modified: string[] = [];
	const deleted: string[] = [];
	const renamed: RenamePair[] = [];
	const newIds = new Set<string>();
	for (const [newPath, entry] of cache.entries()) {
		newIds.add(entry.id);
		const oldPath = oldPathById.get(entry.id);
		if (!oldPath) modified.push(newPath);
		else if (oldPath !== newPath) {
			renamed.push({ oldPath, newPath, isFolder: cache.isFolder(newPath) || undefined });
			modified.push(newPath);
			deleted.push(oldPath);
		}
	}
	for (const [id, oldPath] of oldPathById) {
		if (!newIds.has(id)) deleted.push(oldPath);
	}
	return { modified, deleted, renamed };
}

const CREATE_OR_MODIFY = new Set(["createfile", "modifyfile", "createfolder", "modifyfolder"]);
const DELETE_EVENTS = new Set(["deletefile", "deletefolder"]);

interface DiffAccumulator {
	updatedRecords: { path: string; file: PCloudEntry; isFolder: boolean }[];
	deletedPaths: string[];
	changedPaths: Set<string>;
	renamedPaths: RenamePair[];
}

/**
 * Apply account-wide `diff` events since `diffId` to the metadata cache.
 *
 * pCloud `diff` is account-wide and its metadata carries no absolute path, so:
 * - events that don't resolve under the sync root (unrelated files) are ignored;
 * - deletes are reverse-resolved by id through the cache;
 * - rename/move appears as a `modify*` event whose `parentfolderid`/`name`
 *   changed — detected the same way as Drive's parents comparison.
 *
 * A `reset` event means the server wants clients to discard state → full rescan.
 */
export async function applyPCloudDiff(ctx: PCloudSyncContext, diffId: string): Promise<PCloudDiffResult> {
	const acc: DiffAccumulator = {
		updatedRecords: [],
		deletedPaths: [],
		changedPaths: new Set<string>(),
		renamedPaths: [],
	};

	// pCloud `diff` is a chronological event log keyed by ascending diffid; apply
	// entries in the order returned. Do NOT reorder (e.g. folders-first like Drive's
	// coalesced changes.list) — that would break create/delete causality. One call
	// may cap the events, so loop until a page comes back empty (drained); the guard
	// caps the pathological case where pCloud never advances the cursor.
	let cursor = diffId;
	for (let guard = 0; guard < 10_000; guard++) {
		const res = await ctx.client.listDiff(cursor);
		for (const entry of res.entries) {
			if (entry.event === "reset") {
				return { needsFullScan: true, changedPaths: new Set<string>() };
			}
			applyDiffEntry(ctx, acc, entry);
		}
		cursor = String(res.diffid);
		if (res.entries.length === 0) break;
	}

	if (acc.updatedRecords.length > 0 || acc.deletedPaths.length > 0) {
		ctx.logger?.info("pCloud diff applied", {
			updated: acc.updatedRecords.length,
			deleted: acc.deletedPaths.length,
		});
		await persistDiff(ctx, acc.updatedRecords, acc.deletedPaths);
	}

	return { needsFullScan: false, newDiffId: cursor, changedPaths: acc.changedPaths, renamedPaths: acc.renamedPaths };
}

/** Apply a single diff entry to the cache and accumulate the resulting paths. */
function applyDiffEntry(ctx: PCloudSyncContext, acc: DiffAccumulator, entry: PCloudDiffEntry): void {
	const meta = entry.metadata;
	if (!meta) return;

	if (DELETE_EVENTS.has(entry.event)) {
		const path = ctx.cache.getPathById(meta.id);
		if (!path) return;
		const descendants = ctx.cache.collectDescendants(path);
		acc.deletedPaths.push(path, ...descendants);
		acc.changedPaths.add(path);
		for (const d of descendants) acc.changedPaths.add(d);
		ctx.cache.removeTree(path);
		return;
	}

	if (!CREATE_OR_MODIFY.has(entry.event)) return; // share events, modifyuserinfo, …

	const { oldPath, newPath, wasFolder, oldDescendants } = ctx.cache.applyEntryDetectMove(meta);
	if (newPath) {
		acc.updatedRecords.push({ path: newPath, file: ctx.cache.getEntry(newPath) ?? meta, isFolder: meta.isfolder });
		acc.changedPaths.add(newPath);
	}

	const moved = oldPath && newPath && oldPath !== newPath;
	const movedOutOfRoot = oldPath && !newPath;
	if (moved || movedOutOfRoot) {
		acc.changedPaths.add(oldPath);
		acc.deletedPaths.push(oldPath);
		for (const d of oldDescendants) {
			acc.changedPaths.add(d);
			acc.deletedPaths.push(d);
		}
	}
	if (moved) acc.renamedPaths.push({ oldPath, newPath, isFolder: wasFolder || undefined });

	// Folder move — the descendants now sit under new paths; report them too.
	if (moved && wasFolder && newPath) {
		for (const nd of ctx.cache.collectDescendants(newPath)) {
			acc.changedPaths.add(nd);
			const e = ctx.cache.getEntry(nd);
			if (e) acc.updatedRecords.push({ path: nd, file: e, isFolder: e.isfolder });
			else ctx.logger?.warn("Descendant not found in cache after folder move", { path: nd });
		}
	}
}

/**
 * Persist the diff's file-map changes to IndexedDB. The diff cursor is NOT
 * stored here — it lives in settings.backendData and is committed only after a
 * fully-successful sync, so an interrupted cycle re-detects the gap next time.
 */
async function persistDiff(
	ctx: PCloudSyncContext,
	updated: { path: string; file: PCloudEntry; isFolder: boolean }[],
	deleted: string[],
): Promise<void> {
	if (!ctx.metadataStore) return;
	try {
		if (updated.length > 0) await ctx.metadataStore.putFiles(updated);
		if (deleted.length > 0) await ctx.metadataStore.deleteFiles(deleted);
	} catch (err) {
		ctx.logger?.warn("Failed to persist pCloud diff to IndexedDB", {
			message: err instanceof Error ? err.message : String(err),
		});
	}
}
