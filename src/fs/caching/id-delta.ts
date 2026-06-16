import type { RenamePair } from "../types";
import type { AbstractMetadataCache } from "./metadata-cache";

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
}

export function createIdDeltaResult(): IdDeltaResult {
	return { changedPaths: new Set<string>(), renamedPaths: [], count: 0 };
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

	acc.changedPaths.add(newPath);
	const moved = !!oldPath && oldPath !== newPath;
	if (moved) {
		acc.changedPaths.add(oldPath);
		for (const d of oldDescendants) acc.changedPaths.add(d);
		acc.renamedPaths.push({ oldPath, newPath, isFolder: wasFolder || undefined });
		// Folder move — also report the new descendant paths as updated.
		if (wasFolder) {
			for (const nd of cache.collectDescendants(newPath)) acc.changedPaths.add(nd);
		}
	}
}
