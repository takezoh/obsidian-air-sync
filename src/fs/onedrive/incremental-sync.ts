import type { OneDriveItem } from "./types";
import { isFolderEntry, isGraphResyncError } from "./types";
import { LIST_PAGE_CAP, extractDeltaToken } from "./client";
import type { OneDriveClient } from "./client";
import type { RenamePair } from "../types";
import type { Logger } from "../../logging/logger";
import type { AbstractMetadataCache } from "../caching/metadata-cache";
import type { IncrementalChangesResult } from "../caching/remote-fs";

/**
 * Context for incremental sync. Note there is no metadataStore here: applying a
 * delta mutates only the in-memory cache. Persisting the cache to IndexedDB is
 * deferred to the checkpoint commit (CachingRemoteFs.commitCheckpoint), so the
 * persisted cache never runs ahead of the committed delta cursor (ADR 0001).
 */
export interface OneDriveSyncContext {
	cache: AbstractMetadataCache<OneDriveItem>;
	client: OneDriveClient;
	rootId: string;
	logger?: Logger;
}

interface DeltaAccumulator {
	changedPaths: Set<string>;
	renamedPaths: RenamePair[];
	count: number;
}

/**
 * Apply incremental changes from the Graph `/delta` API, draining `@odata.nextLink`
 * until the final page yields a `@odata.deltaLink` (the new cursor token). Updates
 * the metadata cache and returns the shared {@link IncrementalChangesResult} so
 * {@link CachingRemoteFs} can classify the changed paths into modified/deleted and
 * buffer them for the checkpoint commit.
 *
 * On HTTP 410 Gone (cursor expired, resync required) it returns `needsFullScan`,
 * mirroring Drive's 410 handling — the base then full-scans and diffs by id.
 */
export async function applyOneDriveDelta(ctx: OneDriveSyncContext, cursor: string): Promise<IncrementalChangesResult> {
	const acc: DeltaAccumulator = { changedPaths: new Set<string>(), renamedPaths: [], count: 0 };
	let newToken = cursor;
	let link = cursor;
	try {
		for (let guard = 0; ; guard++) {
			if (guard >= LIST_PAGE_CAP) {
				throw new Error(`applyOneDriveDelta: pagination exceeded ${LIST_PAGE_CAP} pages (server not clearing nextLink?)`);
			}
			const res = await ctx.client.fetchDelta(ctx.rootId, link);
			applyPage(ctx, acc, res.value);
			if (res["@odata.deltaLink"]) {
				newToken = extractDeltaToken(res["@odata.deltaLink"]);
				break;
			}
			const next = res["@odata.nextLink"];
			if (!next) break;
			link = next;
		}
	} catch (err) {
		if (isGraphResyncError(err)) {
			ctx.logger?.info("OneDrive delta token expired (410), falling back to full scan");
			return { needsFullScan: true, changedPaths: new Set<string>() };
		}
		throw err;
	}

	if (acc.count > 0) {
		ctx.logger?.info("OneDrive delta applied", { changeCount: acc.count });
	}
	return { needsFullScan: false, newToken, changedPaths: acc.changedPaths, renamedPaths: acc.renamedPaths };
}

/** Apply one delta page: folders shallow-first (so paths resolve), then each item. */
function applyPage(ctx: OneDriveSyncContext, acc: DeltaAccumulator, items: OneDriveItem[]): void {
	const sorted = [...items].sort((a, b) => {
		const aFolder = isFolderEntry(a) ? 0 : 1;
		const bFolder = isFolderEntry(b) ? 0 : 1;
		if (aFolder !== bFolder) return aFolder - bFolder;
		if (aFolder === 0) {
			const aPath = ctx.cache.getPathById(a.id) ?? "";
			const bPath = ctx.cache.getPathById(b.id) ?? "";
			return aPath.split("/").length - bPath.split("/").length;
		}
		return 0;
	});
	acc.count += sorted.length;
	for (const item of sorted) applyItem(ctx, acc, item);
}

/** Apply a single delta item to the cache and accumulate the resulting paths. */
function applyItem(ctx: OneDriveSyncContext, acc: DeltaAccumulator, item: OneDriveItem): void {
	const cache = ctx.cache;
	// The root item itself appears in the delta stream — never track it as a child.
	if (item.id === ctx.rootId) return;

	if (item.deleted) {
		const path = cache.getPathById(item.id);
		if (path) removeSubtree(cache, acc, path);
		return;
	}

	const { oldPath, newPath, wasFolder, oldDescendants } = cache.applyFileChangeDetectMove(item);

	// Moved outside the tracked root (parent no longer resolves) → surface as deleted.
	if (oldPath && !newPath) {
		acc.changedPaths.add(oldPath);
		for (const d of oldDescendants) acc.changedPaths.add(d);
		return;
	}
	if (!newPath) return;

	acc.changedPaths.add(newPath);
	const moved = !!oldPath && oldPath !== newPath;
	if (moved) {
		acc.changedPaths.add(oldPath);
		for (const d of oldDescendants) acc.changedPaths.add(d);
		acc.renamedPaths.push({ oldPath, newPath, isFolder: wasFolder || undefined });
		if (wasFolder) {
			for (const nd of cache.collectDescendants(newPath)) acc.changedPaths.add(nd);
		}
	}
}

/** Remove a path + its subtree, recording every removed path as changed. */
function removeSubtree(
	cache: AbstractMetadataCache<OneDriveItem>,
	acc: DeltaAccumulator,
	path: string,
): void {
	const descendants = cache.collectDescendants(path);
	acc.changedPaths.add(path);
	for (const d of descendants) acc.changedPaths.add(d);
	cache.removeTree(path);
}
