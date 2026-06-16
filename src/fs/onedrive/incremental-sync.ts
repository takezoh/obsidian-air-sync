import type { OneDriveItem } from "./types";
import { isFolderEntry, isGraphResyncError } from "./types";
import { LIST_PAGE_CAP, extractDeltaToken } from "./client";
import type { OneDriveClient } from "./client";
import type { Logger } from "../../logging/logger";
import type { AbstractMetadataCache } from "../caching/metadata-cache";
import type { IncrementalChangesResult } from "../caching/remote-fs";
import { applyIdDeltaPage, createIdDeltaResult, type IdDeltaEntry } from "../caching/id-delta";

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

/**
 * Apply incremental changes from the Graph `/delta` API, draining `@odata.nextLink`
 * until the final page yields a `@odata.deltaLink` (the new cursor token). Updates
 * the metadata cache and returns the shared {@link IncrementalChangesResult} so
 * {@link CachingRemoteFs} can classify the changed paths into modified/deleted and
 * buffer them for the checkpoint commit. The per-page apply (folder ordering, move
 * classification, subtree removal) is the shared {@link applyIdDeltaPage}.
 *
 * On HTTP 410 Gone (cursor expired, resync required) it returns `needsFullScan`,
 * mirroring Google Drive's 410 handling — the base then full-scans and diffs by id.
 */
export async function applyOneDriveDelta(ctx: OneDriveSyncContext, cursor: string): Promise<IncrementalChangesResult> {
	const acc = createIdDeltaResult();
	let newToken = cursor;
	let link = cursor;
	try {
		for (let guard = 0; ; guard++) {
			if (guard >= LIST_PAGE_CAP) {
				throw new Error(`applyOneDriveDelta: pagination exceeded ${LIST_PAGE_CAP} pages (server not clearing nextLink?)`);
			}
			const res = await ctx.client.fetchDelta(ctx.rootId, link);
			applyIdDeltaPage(ctx.cache, acc, toEntries(ctx.rootId, res.value));
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

/** Map a Graph delta page to normalized entries (a `deleted` facet ⇒ tombstone). */
function toEntries(rootId: string, items: OneDriveItem[]): IdDeltaEntry<OneDriveItem>[] {
	const entries: IdDeltaEntry<OneDriveItem>[] = [];
	for (const item of items) {
		// The root item itself appears in the delta stream — never track it as a child.
		if (item.id === rootId) continue;
		entries.push({ id: item.id, isFolder: isFolderEntry(item), file: item.deleted ? undefined : item });
	}
	return entries;
}
