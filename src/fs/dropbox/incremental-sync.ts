import type { DropboxEntry } from "./types";
import { isDropboxResetError } from "./types";
import { segments } from "./metadata-cache";
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
 * Apply `list_folder/continue` entries to the cache. `file`/`folder` upsert at their
 * (relativized) path; `deleted` removes the subtree at its path. Returns the shared
 * {@link IncrementalChangesResult} so {@link CachingRemoteFs} can classify the changed
 * paths into modified/deleted itself (`hasFile` join) and buffer them for the checkpoint
 * commit.
 *
 * **Order-independent (ADR 0006).** A rename/move appears as `deleted(old)`+`file/folder(new)`
 * sharing a stable id, but Dropbox does NOT guarantee the add precedes the delete. We
 * therefore drain the whole delta, then apply **upserts before deletes**: the move is
 * coalesced into a {@link RenamePair} via the still-present `id→path` mapping
 * (`getPathById`), and the trailing `deleted(old)` is a no-op (the path was vacated).
 * Were the delete processed first, `removeTree` would drop the id mapping and the rename
 * would degrade to delete+add of the whole subtree (the reported Dropbox folder-rename
 * bug). This mirrors the id-addressed backends' `applyIdDeltaPage` (folders
 * shallow-first); see {@link applyEntries} for the delete-then-recreate guard.
 */
export async function applyDropboxDelta(ctx: DropboxSyncContext, cursor: string): Promise<IncrementalChangesResult> {
	const acc: DeltaAccumulator = {
		changedPaths: new Set<string>(),
		renamedPaths: [],
	};

	// Drain ALL pages before applying: a rename's deleted(old) and add(new) can land on
	// different pages, so the upserts-before-deletes reorder must span the whole delta,
	// not one page. One call may cap the entries; drain until `has_more` is false. The
	// guard caps the pathological case where Dropbox never clears `has_more` — throw
	// rather than silently truncating (a partial delta could drop remote changes).
	const entries: DropboxEntry[] = [];
	let cur = cursor;
	let drained = false;
	for (let guard = 0; guard < LIST_PAGE_CAP; guard++) {
		let res;
		try {
			res = await ctx.client.listFolderContinue(cur);
		} catch (err) {
			if (isDropboxResetError(err)) return { needsFullScan: true, changedPaths: new Set<string>() };
			throw err;
		}
		for (const entry of res.entries) entries.push(entry);
		cur = res.cursor;
		if (!res.has_more) { drained = true; break; }
	}
	if (!drained) {
		throw new Error(`applyDropboxDelta: delta pagination exceeded ${LIST_PAGE_CAP} pages (server not clearing has_more?)`);
	}

	applyEntries(ctx, acc, entries);

	if (acc.changedPaths.size > 0) {
		ctx.logger?.info("Dropbox delta applied", { changed: acc.changedPaths.size });
	}
	// The in-memory cache now reflects the delta; persistence to IndexedDB is the
	// base's job at checkpoint commit (see CachingRemoteFs.commitCheckpoint).
	return { needsFullScan: false, newToken: cur, changedPaths: acc.changedPaths, renamedPaths: acc.renamedPaths };
}

/** A delta entry paired with its relativized vault path (null = outside the root). */
interface PathedEntry {
	entry: DropboxEntry;
	path: string | null;
}

/** True for a path that the cache cannot track (outside root, root itself, reserved). */
function isUntrackable(path: string | null): boolean {
	return path === null || path === "" || path === INTERNAL_METADATA_PATH;
}

/**
 * Apply a fully-drained delta order-independently (ADR 0006): all upserts first, then all
 * deletes. Upserts are sorted folders-then-shallow-first (parity with the id-addressed
 * backends' `applyIdDeltaPage`) so a child resolves against an already-placed/renamed parent
 * and a nested folder rename coalesces to one pair. A `deleted` is then a no-op unless its
 * path still holds an entry — and even then it is **skipped when that path was (re)written
 * by an upsert in this same delta** (`upsertedPaths`): the path was reclaimed as a rename
 * target, or this is a delete-then-recreate-at-the-same-path with a *different* id (the
 * upsert already evicted the old occupant). Removing it would drop the live file. The guard
 * keys on PATH, not id, because Dropbox `deleted` tombstones carry no id and an upsert's
 * `id` is itself optional.
 */
function applyEntries(ctx: DropboxSyncContext, acc: DeltaAccumulator, entries: DropboxEntry[]): void {
	const cache = ctx.cache;
	const upserts: PathedEntry[] = [];
	const deletes: PathedEntry[] = [];
	for (const entry of entries) {
		const target = entry[".tag"] === "deleted" ? deletes : upserts;
		target.push({ entry, path: cache.relativize(entry) });
	}

	// Folders before files, then shallow-first by path depth — so a parent folder's
	// rename is applied (rewriting child paths) before any child entry is processed.
	upserts.sort((a, b) => {
		const aFolder = a.entry[".tag"] === "folder" ? 0 : 1;
		const bFolder = b.entry[".tag"] === "folder" ? 0 : 1;
		if (aFolder !== bFolder) return aFolder - bFolder;
		return depthOf(a.path) - depthOf(b.path);
	});

	const upsertedPaths = new Set<string>();
	for (const u of upserts) if (!isUntrackable(u.path)) upsertedPaths.add(u.path!);

	for (const u of upserts) applyUpsertEntry(ctx, acc, u.entry, u.path);
	for (const d of deletes) applyDeleteEntry(ctx, acc, d.entry, d.path, upsertedPaths);
}

/** Depth (non-empty segment count) of a relativized path; an untrackable path sorts first. */
function depthOf(path: string | null): number {
	return path === null ? 0 : segments(path).length;
}

/** Apply a single `file`/`folder` upsert to the cache and accumulate the resulting paths. */
function applyUpsertEntry(ctx: DropboxSyncContext, acc: DeltaAccumulator, entry: DropboxEntry, path: string | null): void {
	const cache = ctx.cache;

	// Untrackable destination: outside the vault root, the root folder itself, or
	// the reserved backend metadata path. These are never cached, so never build a
	// record from them. If a previously tracked entry MOVED here (same id), surface
	// its disappearance from the old location and drop it; otherwise ignore.
	if (isUntrackable(path)) {
		const oldPath = entry.id ? cache.getPathById(entry.id) : undefined;
		if (oldPath !== undefined) {
			for (const p of [oldPath, ...cache.collectDescendants(oldPath)]) {
				acc.changedPaths.add(p);
			}
			cache.removeTree(oldPath);
		}
		return;
	}

	const oldPath = entry.id ? cache.getPathById(entry.id) : undefined;
	if (oldPath !== undefined && oldPath !== path) {
		applyRename(cache, acc, entry, oldPath, path!);
		return;
	}

	// New path or in-place modify. When a DIFFERENT entry currently occupies `path`
	// (delete-then-recreate at the same path with a new id), `setEntry` evicts its whole
	// subtree but reports nothing — record the displaced descendants here, or they vanish
	// from the cache without ever being classified as deletions. A truly new path (no
	// occupant) or a same-id in-place modify (oldPath === path) leaves this an empty no-op.
	if (oldPath === undefined) {
		for (const d of cache.collectDescendants(path!)) acc.changedPaths.add(d);
	}
	cache.setEntry(path!, entry);
	acc.changedPaths.add(path!);
}

/** Apply a single `deleted` tombstone, guarded against a path reclaimed by an upsert. */
function applyDeleteEntry(
	ctx: DropboxSyncContext,
	acc: DeltaAccumulator,
	entry: DropboxEntry,
	path: string | null,
	upsertedPaths: ReadonlySet<string>,
): void {
	const cache = ctx.cache;
	if (isUntrackable(path)) return;
	if (!cache.hasFile(path!)) return; // already gone (e.g. vacated by a rename) → ignore

	// Stale tombstone: this path was (re)written by an upsert in the same delta (rename
	// target, or same-path recreate with a different id). The upsert is authoritative;
	// removing the subtree would drop the live file. See applyEntries / ADR 0006.
	if (upsertedPaths.has(path!)) return;

	const descendants = cache.collectDescendants(path!);
	for (const p of [path!, ...descendants]) {
		acc.changedPaths.add(p);
	}
	cache.removeTree(path!);
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

	// A DIFFERENT entry already occupying newPath (the moved id is at oldPath, so any
	// occupant here is some other id) is evicted by setEntry → removeTree without
	// reporting. Capture its displaced descendants so they surface as deletions rather
	// than vanish from the cache unclassified — the rename-branch twin of the recreate
	// handling in applyUpsertEntry (ADR 0006). The occupant's own path is reported below.
	const displaced = cache.hasFile(newPath) ? cache.collectDescendants(newPath) : [];

	cache.removeEntry(oldPath);
	cache.setEntry(newPath, entry);
	if (wasFolder) cache.rewriteChildPaths(oldPath, newPath);

	acc.renamedPaths.push({ oldPath, newPath, isFolder: wasFolder || undefined });
	acc.changedPaths.add(newPath);
	acc.changedPaths.add(oldPath);
	for (const d of oldDescendants) {
		acc.changedPaths.add(d);
	}
	for (const d of displaced) {
		acc.changedPaths.add(d);
	}
	if (wasFolder) {
		for (const nd of cache.collectDescendants(newPath)) {
			acc.changedPaths.add(nd);
		}
	}
}
