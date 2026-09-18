import type { RenamePair } from "../types";
import type { AbstractMetadataCache } from "./metadata-cache";
import { projectedIdentityKey } from "./metadata-cache";

/**
 * One normalized entry from a backend delta page. Each id-addressed backend maps
 * its own raw delta shape (Google Drive `changes`, OneDrive `/delta`) to this:
 *  - `file` present  ⇒ an upsert (add/modify/move) of that metadata;
 *  - `file` undefined ⇒ a tombstone (deletion) — `id` resolves the cached path.
 * A backend that wants to ignore a raw change (e.g. Google Drive's "no file and not
 * removed") simply omits it from the mapped array rather than emitting a tombstone.
 */
export interface IdDeltaEntry<TFile> {
	/** Backend id of the changed item (path lookup for sort + tombstone resolution). */
	id: string;
	/** Whether this entry is a folder — used only to order folders shallow-first. */
	isFolder: boolean;
	/** Upsert metadata, or undefined for a tombstone. */
	file: TFile | undefined;
}

/** Accumulates the paths a delta touched, for the caller to classify and buffer. */
export interface IdDeltaResult {
	changedPaths: Set<string>;
	renamedPaths: RenamePair[];
	count: number;
	/**
	 * Ids of folders that gained a cached path during THIS delta application — a
	 * folder whose old cached path was undefined and whose new one resolved. It
	 * covers never-tracked, evicted-then-reentered, trash-restored, and
	 * ancestor-chain entry alike, because all four look the same at apply time.
	 *
	 * A provider whose delta reports only the changed item (Google Drive) sends no
	 * change for that folder's unchanged descendants, so those descendants are facts
	 * this page cannot carry. The Google Drive backend re-lists these ids after its
	 * drain; OneDrive's delta is already complete and never reads the set.
	 *
	 * Per-call bookkeeping only: it is discarded with the call, never persisted,
	 * never copied into `IncrementalChangesResult`, and never read by the cache.
	 * Insertion order is first-entry order, and re-entry within one drain collapses
	 * to one element.
	 */
	enteredFolderIds: Set<string>;
}

export function createIdDeltaResult(): IdDeltaResult {
	return { changedPaths: new Set<string>(), renamedPaths: [], count: 0, enteredFolderIds: new Set<string>() };
}

/**
 * Apply one page of id-addressed delta entries to the cache, accumulating the
 * touched paths. Shared by every backend whose delta is keyed on a stable backend
 * id (Google Drive, OneDrive). The move/rename classification and subtree removal
 * are identical across those backends and live here; each backend keeps only its
 * own pagination/cursor/410 wrapper and the raw→{@link IdDeltaEntry} mapping.
 *
 * Folders are applied shallow-first (by cached path depth) so a child path resolves
 * against an already-placed parent. `entries` is sorted IN PLACE — callers pass a
 * fresh per-page array (the backend's raw→IdDeltaEntry mapping), so no copy is needed.
 */
export function applyIdDeltaPage<TFile>(
	cache: AbstractMetadataCache<TFile>,
	acc: IdDeltaResult,
	entries: IdDeltaEntry<TFile>[],
): void {
	entries.sort((a, b) => {
		const aFolder = a.isFolder ? 0 : 1;
		const bFolder = b.isFolder ? 0 : 1;
		if (aFolder !== bFolder) return aFolder - bFolder;
		if (aFolder === 0) {
			const aPath = cache.getPathById(a.id) ?? "";
			const bPath = cache.getPathById(b.id) ?? "";
			return aPath.split("/").length - bPath.split("/").length;
		}
		return 0;
	});
	acc.count += entries.length;
	for (const entry of entries) applyEntry(cache, acc, entry);
}

/** Apply a single normalized delta entry to the cache and accumulate its paths. */
function applyEntry<TFile>(
	cache: AbstractMetadataCache<TFile>,
	acc: IdDeltaResult,
	entry: IdDeltaEntry<TFile>,
): void {
	if (entry.file === undefined) {
		// Tombstone: remove the path + its subtree, recording every removed path.
		const path = cache.getPathById(entry.id);
		if (path) {
			const descendants = cache.collectDescendants(path);
			acc.changedPaths.add(path);
			for (const d of descendants) acc.changedPaths.add(d);
			cache.removeTree(path);
		}
		return;
	}

	const { oldPath, newPath, wasFolder, oldDescendants } = cache.applyFileChangeDetectMove(entry.file);

	// Moved outside the tracked root (parent no longer resolves) → surface as deleted.
	if (oldPath && !newPath) {
		acc.changedPaths.add(oldPath);
		for (const d of oldDescendants) acc.changedPaths.add(d);
		return;
	}
	if (!newPath) return;

	// This folder had no cached path immediately before its own mutation and has one
	// now: it entered the tracked root on THIS entry. Recording here (rather than
	// sampling `hasId` at page or drain start) is what catches a folder evicted
	// earlier in the same page by an ancestor's tombstone. `wasFolder` describes the
	// OLD path and is always false when `oldPath` is undefined, so it is never used.
	if (!oldPath && entry.isFolder) acc.enteredFolderIds.add(entry.id);

	acc.changedPaths.add(newPath);
	const moved = !!oldPath && oldPath !== newPath;
	if (moved) {
		acc.changedPaths.add(oldPath);
		for (const d of oldDescendants) acc.changedPaths.add(d);
		acc.renamedPaths.push({
			oldPath,
			newPath,
			isFolder: wasFolder || undefined,
			identityKey: projectedIdentityKey(cache, newPath),
		});
		// Folder move — also report the new descendant paths as updated.
		if (wasFolder) {
			for (const nd of cache.collectDescendants(newPath)) acc.changedPaths.add(nd);
		}
	}
}
