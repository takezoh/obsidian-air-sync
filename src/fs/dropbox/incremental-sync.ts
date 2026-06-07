import type { DropboxEntry } from "./types";
import { isDropboxResetError } from "./types";
import type { DropboxMetadataCache } from "./metadata-cache";
import type { DropboxClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { RenamePair } from "../../sync/types";
import type { Logger } from "../../logging/logger";
import { INTERNAL_METADATA_PATH } from "../../sync/remote-vault";

/**
 * Context for incremental sync operations. Note there is no metadataStore here:
 * applying a delta mutates only the in-memory cache. Persisting the cache to
 * IndexedDB is deferred to the checkpoint commit (DropboxFs.commitCheckpoint),
 * so the persisted cache never runs ahead of the committed delta cursor.
 */
export interface DropboxSyncContext {
	cache: DropboxMetadataCache;
	client: DropboxClient;
	logger?: Logger;
}

export type DropboxDeltaResult =
	| { needsFullScan: false; newCursor: string; changedPaths: Set<string>; renamedPaths: RenamePair[] }
	| { needsFullScan: true; changedPaths: Set<string> };

/** A remote change delta in the shape the sync engine consumes. */
export interface RemoteDelta {
	modified: string[];
	deleted: string[];
	renamed: RenamePair[];
}

interface DeltaAccumulator {
	changedPaths: Set<string>;
	renamedPaths: RenamePair[];
}

/** Split delta-changed paths into modified (still cached) vs deleted (gone). */
export function classifyChangedPaths(
	cache: DropboxMetadataCache,
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
 * Used when the cursor is lost (`reset`) and we re-scan to recover a delta.
 * Detects additions, renames, and deletions — but not in-place content edits
 * (same id, same path), which the next delta or WARM mode catches.
 */
export function computeFullScanDelta(
	oldPathById: Map<string, string>,
	cache: DropboxMetadataCache,
): RemoteDelta | null {
	if (oldPathById.size === 0) return null;
	const modified: string[] = [];
	const deleted: string[] = [];
	const renamed: RenamePair[] = [];
	const newIds = new Set<string>();
	for (const [newPath, entry] of cache.entries()) {
		if (!entry.id) continue;
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

/**
 * Apply `list_folder/continue` entries to the cache, following Dropbox's
 * official local-cache sync algorithm: process entries in order; `file`/`folder`
 * upsert at their (relativized) path; `deleted` removes the subtree at its path.
 *
 * Rename/move appears as `deleted(old)`+`file/folder(new)` sharing a stable id.
 * When the add is seen while the old path is still cached, it is coalesced into a
 * {@link RenamePair} (folders also rewrite child paths) and the trailing stale
 * `deleted(old)` becomes a no-op (the path is already gone). If the delete is
 * seen first, this degrades to delete+add — correct, but re-downloads.
 */
export async function applyDropboxDelta(ctx: DropboxSyncContext, cursor: string): Promise<DropboxDeltaResult> {
	const acc: DeltaAccumulator = {
		changedPaths: new Set<string>(),
		renamedPaths: [],
	};

	let cur = cursor;
	// One call may cap the entries; drain until `has_more` is false. The guard
	// caps the pathological case where Dropbox never clears `has_more`.
	for (let guard = 0; guard < 10_000; guard++) {
		let res;
		try {
			res = await ctx.client.listFolderContinue(cur);
		} catch (err) {
			if (isDropboxResetError(err)) return { needsFullScan: true, changedPaths: new Set<string>() };
			throw err;
		}
		for (const entry of res.entries) applyDeltaEntry(ctx, acc, entry);
		cur = res.cursor;
		if (!res.has_more) break;
	}

	if (acc.changedPaths.size > 0) {
		ctx.logger?.info("Dropbox delta applied", { changed: acc.changedPaths.size });
	}
	// The in-memory cache now reflects the delta; persistence to IndexedDB is the
	// caller's job at checkpoint commit (see DropboxFs.commitCheckpoint).
	return { needsFullScan: false, newCursor: cur, changedPaths: acc.changedPaths, renamedPaths: acc.renamedPaths };
}

/** Apply a single delta entry to the cache and accumulate the resulting paths. */
function applyDeltaEntry(ctx: DropboxSyncContext, acc: DeltaAccumulator, entry: DropboxEntry): void {
	const cache = ctx.cache;
	const path = cache.relativize(entry);

	// Untrackable destination: outside the vault root, the root folder itself, or
	// the reserved backend metadata path. These are never cached, so never build a
	// record from them (recordAt would deref an absent entry). If a previously
	// tracked entry MOVED here (same id), surface its disappearance from the old
	// location and drop it; otherwise ignore.
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
		if (!cache.hasEntry(path)) return; // already gone (or coalesced into a rename) → ignore
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

/**
 * Flush the metadata cache to IndexedDB at a checkpoint commit. `fullPersist`
 * rewrites the whole map (after a full scan); otherwise the touched paths are
 * reconciled against the live cache — present → upsert, absent → delete. The
 * reconcile reads the final cache state, so it is order-independent and correct
 * even when `touched` spans several earlier failed cycles.
 */
export async function commitDropboxCache(
	store: MetadataStore<DropboxEntry>,
	cache: DropboxMetadataCache,
	touched: Set<string>,
	fullPersist: boolean,
): Promise<void> {
	await store.open();
	if (fullPersist) {
		await store.saveAll(cache.exportRecords(), new Map());
		return;
	}
	const updated: { path: string; file: DropboxEntry; isFolder: boolean }[] = [];
	const deleted: string[] = [];
	for (const path of touched) {
		const entry = cache.getEntry(path);
		if (entry) updated.push({ path, file: entry, isFolder: cache.isFolder(path) });
		else deleted.push(path);
	}
	if (updated.length > 0) await store.putFiles(updated);
	if (deleted.length > 0) await store.deleteFiles(deleted);
}
