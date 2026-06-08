import type { DropboxEntry } from "./types";
import { isDropboxResetError } from "./types";
import type { DropboxMetadataCache } from "./metadata-cache";
import { LIST_PAGE_CAP } from "./client";
import type { DropboxClient } from "./client";
import type { RenamePair } from "../types";
import type { Logger } from "../../logging/logger";
import type { IncrementalChangesResult } from "../caching/remote-fs";
import { INTERNAL_METADATA_PATH } from "../remote-vault-contract";

/**
 * Context for incremental sync operations. Note there is no metadataStore here:
 * applying a delta mutates only the in-memory cache. Persisting the cache to
 * IndexedDB is deferred to the checkpoint commit (CachingRemoteFs.commitCheckpoint),
 * so the persisted cache never runs ahead of the committed delta cursor (ADR 0001).
 */
export interface DropboxSyncContext {
	cache: DropboxMetadataCache;
	client: DropboxClient;
	logger?: Logger;
}

interface DeltaAccumulator {
	changedPaths: Set<string>;
	renamedPaths: RenamePair[];
}

/**
 * Apply `list_folder/continue` entries to the cache, following Dropbox's official
 * local-cache sync algorithm: process entries in order; `file`/`folder` upsert at
 * their (relativized) path; `deleted` removes the subtree at its path. Returns the
 * shared {@link IncrementalChangesResult} so {@link CachingRemoteFs} can classify
 * the changed paths into modified/deleted itself (`hasFile` join) and buffer them
 * for the checkpoint commit.
 *
 * Rename/move appears as `deleted(old)`+`file/folder(new)` sharing a stable id.
 * When the add is seen while the old path is still cached, it is coalesced into a
 * {@link RenamePair} (folders also rewrite child paths) and the trailing stale
 * `deleted(old)` becomes a no-op (the path is already gone). If the delete is
 * seen first, this degrades to delete+add — correct, but re-downloads.
 */
export async function applyDropboxDelta(ctx: DropboxSyncContext, cursor: string): Promise<IncrementalChangesResult> {
	const acc: DeltaAccumulator = {
		changedPaths: new Set<string>(),
		renamedPaths: [],
	};

	let cur = cursor;
	// One call may cap the entries; drain until `has_more` is false. The guard caps
	// the pathological case where Dropbox never clears `has_more` — throw rather than
	// silently truncating (a partial delta could drop or mis-order remote changes).
	let drained = false;
	for (let guard = 0; guard < LIST_PAGE_CAP; guard++) {
		let res;
		try {
			res = await ctx.client.listFolderContinue(cur);
		} catch (err) {
			if (isDropboxResetError(err)) return { needsFullScan: true, changedPaths: new Set<string>() };
			throw err;
		}
		for (const entry of res.entries) applyDeltaEntry(ctx, acc, entry);
		cur = res.cursor;
		if (!res.has_more) { drained = true; break; }
	}
	if (!drained) {
		throw new Error(`applyDropboxDelta: delta pagination exceeded ${LIST_PAGE_CAP} pages (server not clearing has_more?)`);
	}

	if (acc.changedPaths.size > 0) {
		ctx.logger?.info("Dropbox delta applied", { changed: acc.changedPaths.size });
	}
	// The in-memory cache now reflects the delta; persistence to IndexedDB is the
	// base's job at checkpoint commit (see CachingRemoteFs.commitCheckpoint).
	return { needsFullScan: false, newToken: cur, changedPaths: acc.changedPaths, renamedPaths: acc.renamedPaths };
}

/** Apply a single delta entry to the cache and accumulate the resulting paths. */
function applyDeltaEntry(ctx: DropboxSyncContext, acc: DeltaAccumulator, entry: DropboxEntry): void {
	const cache = ctx.cache;
	const path = cache.relativize(entry);

	// Untrackable destination: outside the vault root, the root folder itself, or
	// the reserved backend metadata path. These are never cached, so never build a
	// record from them. If a previously tracked entry MOVED here (same id), surface
	// its disappearance from the old location and drop it; otherwise ignore.
	if (path === null || path === "" || path === INTERNAL_METADATA_PATH) {
		const oldPath = entry.id ? cache.getPathById(entry.id) : undefined;
		if (oldPath !== undefined) {
			for (const p of [oldPath, ...cache.collectDescendants(oldPath)]) {
				acc.changedPaths.add(p);
			}
			cache.removeTree(oldPath);
		}
		return;
	}

	if (entry[".tag"] === "deleted") {
		if (!cache.hasFile(path)) return; // already gone (or coalesced into a rename) → ignore
		const descendants = cache.collectDescendants(path);
		for (const p of [path, ...descendants]) {
			acc.changedPaths.add(p);
		}
		cache.removeTree(path);
		return;
	}

	const oldPath = entry.id ? cache.getPathById(entry.id) : undefined;
	if (oldPath !== undefined && oldPath !== path) {
		applyRename(cache, acc, entry, oldPath, path);
		return;
	}

	// New file/folder, or in-place modify (same path).
	cache.setEntry(path, entry);
	acc.changedPaths.add(path);
}

/** Coalesce a `deleted(old)`+`file/folder(new)` pair (same id) into a rename. */
function applyRename(
	cache: DropboxMetadataCache,
	acc: DeltaAccumulator,
	entry: DropboxEntry,
	oldPath: string,
	newPath: string,
): void {
	const wasFolder = cache.isFolder(oldPath);
	const oldDescendants = wasFolder ? cache.collectDescendants(oldPath) : [];

	cache.removeEntry(oldPath);
	cache.setEntry(newPath, entry);
	if (wasFolder) cache.rewriteChildPaths(oldPath, newPath);

	acc.renamedPaths.push({ oldPath, newPath, isFolder: wasFolder || undefined });
	acc.changedPaths.add(newPath);
	acc.changedPaths.add(oldPath);
	for (const d of oldDescendants) {
		acc.changedPaths.add(d);
	}
	if (wasFolder) {
		for (const nd of cache.collectDescendants(newPath)) {
			acc.changedPaths.add(nd);
		}
	}
}
