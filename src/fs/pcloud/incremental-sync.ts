import type { PCloudEntry, PCloudDiffEntry } from "./types";
import type { PCloudClient } from "./client";
import type { RenamePair } from "../types";
import type { Logger } from "../../logging/logger";
import type { AbstractMetadataCache } from "../caching/metadata-cache";
import type { IncrementalChangesResult } from "../caching/remote-fs";

/**
 * Context for incremental sync operations. Note there is no metadataStore here:
 * applying diff events mutates only the in-memory cache. Persisting the cache to
 * IndexedDB is deferred to the checkpoint commit (CachingRemoteFs.commitCheckpoint),
 * so the persisted cache never runs ahead of the committed delta cursor.
 */
export interface PCloudSyncContext {
	cache: AbstractMetadataCache<PCloudEntry>;
	client: PCloudClient;
	logger?: Logger;
}

const CREATE_OR_MODIFY = new Set(["createfile", "modifyfile", "createfolder", "modifyfolder"]);
const DELETE_EVENTS = new Set(["deletefile", "deletefolder"]);

interface DiffAccumulator {
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
 * The in-memory cache now reflects the changes; persistence to IndexedDB is the
 * caller's job at checkpoint commit (CachingRemoteFs.commitCheckpoint).
 */
export async function applyPCloudDiff(ctx: PCloudSyncContext, diffId: string): Promise<IncrementalChangesResult> {
	const acc: DiffAccumulator = { changedPaths: new Set<string>(), renamedPaths: [] };

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

	if (acc.changedPaths.size > 0) {
		ctx.logger?.info("pCloud diff applied", { changed: acc.changedPaths.size });
	}

	return {
		needsFullScan: false,
		newToken: cursor,
		changedPaths: acc.changedPaths,
		renamedPaths: acc.renamedPaths,
	};
}

/** Apply a single diff entry to the cache and accumulate the resulting paths. */
function applyDiffEntry(ctx: PCloudSyncContext, acc: DiffAccumulator, entry: PCloudDiffEntry): void {
	const meta = entry.metadata;
	if (!meta) return;

	if (DELETE_EVENTS.has(entry.event)) {
		const path = ctx.cache.getPathById(meta.id);
		if (!path) return;
		const descendants = ctx.cache.collectDescendants(path);
		acc.changedPaths.add(path);
		for (const d of descendants) acc.changedPaths.add(d);
		ctx.cache.removeTree(path);
		return;
	}

	if (!CREATE_OR_MODIFY.has(entry.event)) return; // share events, modifyuserinfo, …

	const { oldPath, newPath, wasFolder, oldDescendants } = ctx.cache.applyFileChangeDetectMove(meta);
	if (newPath) acc.changedPaths.add(newPath);

	const moved = oldPath && newPath && oldPath !== newPath;
	const movedOutOfRoot = oldPath && !newPath;
	if (moved || movedOutOfRoot) {
		acc.changedPaths.add(oldPath);
		for (const d of oldDescendants) acc.changedPaths.add(d);
	}
	if (moved) acc.renamedPaths.push({ oldPath, newPath, isFolder: wasFolder || undefined });

	// Folder move — the descendants now sit under new paths; report them too.
	if (moved && wasFolder && newPath) {
		for (const nd of ctx.cache.collectDescendants(newPath)) acc.changedPaths.add(nd);
	}
}
