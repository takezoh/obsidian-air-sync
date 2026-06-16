import type { FileEntity } from "../types";
import type { Logger } from "../../logging/logger";
import { INTERNAL_METADATA_PATH } from "../remote-vault-contract";

export interface FileChangeResult {
	oldPath: string | undefined;
	newPath: string | undefined;
	wasFolder: boolean;
	oldDescendants: string[];
}

/**
 * Backend-agnostic in-memory metadata cache for an id-addressed remote backend.
 *
 * Owns the data structures and algorithms shared by every such backend: the
 * path↔id maps, folder tracking, the parent→children index, tree mutation
 * (rename/move/delete-subtree), and parent-chain path resolution. None of that
 * is Google Drive-specific — Google Drive's only contribution is *reading fields off its own
 * file shape* and *projecting a `FileEntity`*. Concrete backends subclass this
 * and supply those four extractors plus `toEntity`; the multi-parent (Google Drive)
 * vs single-parent (Dropbox/pCloud) difference is absorbed by `extractParentIds`
 * returning an array — one element for single-parent backends.
 */
export abstract class AbstractMetadataCache<TFile> {
	/** Maps relative path → backend file metadata */
	private pathToFile = new Map<string, TFile>();
	/** Maps backend file ID → relative path */
	private idToPath = new Map<string, string>();
	/** Tracks which paths are folders */
	private folders = new Set<string>();
	/** Parent path → set of direct child paths (for O(k) child lookups) */
	private children = new Map<string, Set<string>>();

	private rootFolderId: string;
	protected logger?: Logger;

	constructor(rootFolderId: string, logger?: Logger) {
		this.rootFolderId = rootFolderId;
		this.logger = logger;
	}

	// ── Per-backend seams (the only Google Drive/Dropbox/pCloud-specific parts) ──

	/** Stable backend id for this entry (Google Drive `file.id`, pCloud `"d…"/"f…"`, …). */
	protected abstract extractId(file: TFile): string;
	/**
	 * Parent ids of this entry. Multi-parent backends (Google Drive) return all of them;
	 * single-parent backends return a one-element array. Empty ⇒ a root-level item.
	 */
	protected abstract extractParentIds(file: TFile): string[];
	/** The entry's own name (its last path segment). */
	protected abstract extractName(file: TFile): string;
	/** Whether the entry is a folder, by the backend's own signal (mimeType, `.tag`, …). */
	protected abstract isFolderEntry(file: TFile): boolean;
	/** Project cached metadata into a `FileEntity` (no download; `hash` stays ""). */
	abstract toEntity(path: string, file: TFile): FileEntity;

	// ── Query methods ──

	getFile(path: string): TFile | undefined { return this.pathToFile.get(path); }
	hasFile(path: string): boolean { return this.pathToFile.has(path); }
	isFolder(path: string): boolean { return this.folders.has(path); }
	getPathById(id: string): string | undefined { return this.idToPath.get(id); }
	hasId(id: string): boolean { return this.idToPath.has(id); }
	getChildren(path: string): ReadonlySet<string> | undefined { return this.children.get(path); }
	get size(): number { return this.pathToFile.size; }
	entries(): IterableIterator<[string, TFile]> { return this.pathToFile.entries(); }

	/** The backend id of the file currently cached at `path`, or undefined if none. */
	idAt(path: string): string | undefined {
		const file = this.pathToFile.get(path);
		return file === undefined ? undefined : this.extractId(file);
	}

	/** Snapshot the whole cache as an id→path map (used for a full-scan diff). */
	snapshotPathsById(): Map<string, string> {
		const byId = new Map<string, string>();
		for (const [path, file] of this.pathToFile) byId.set(this.extractId(file), path);
		return byId;
	}

	// ── Mutation methods ──

	/**
	 * Reserved backend paths (e.g. the metadata file) are never tracked by the
	 * cache, so they stay invisible to every cache-backed reader
	 * (list/stat/read/listDir/getChangedPaths). See fs/remote-vault-contract.ts.
	 */
	private isReserved(path: string): boolean {
		return path === INTERNAL_METADATA_PATH;
	}

	/** Add or update a file in the cache with full index maintenance */
	setFile(path: string, file: TFile): void {
		if (this.isReserved(path)) return;
		const isNew = !this.pathToFile.has(path);
		this.pathToFile.set(path, file);
		this.idToPath.set(this.extractId(file), path);
		if (this.isFolderEntry(file)) {
			this.folders.add(path);
		}
		if (isNew) this.addToIndex(path);
	}

	/** Remove a single entry from pathToFile/idToPath/folders and the children index */
	removeEntry(path: string): void {
		const file = this.pathToFile.get(path);
		if (file) this.idToPath.delete(this.extractId(file));
		this.removeFromIndex(path);
		this.pathToFile.delete(path);
		this.folders.delete(path);
	}

	/** Bulk-load files into the cache. Does NOT clear — callers clear() first when rebuilding. */
	bulkLoad(items: Iterable<[string, TFile]>): void {
		for (const [path, file] of items) {
			if (this.isReserved(path)) continue;
			this.pathToFile.set(path, file);
			this.idToPath.set(this.extractId(file), path);
			if (this.isFolderEntry(file)) {
				this.folders.add(path);
			}
		}
		for (const path of this.pathToFile.keys()) {
			this.addToIndex(path);
		}
	}

	/** Return a snapshot of all records for persistence */
	exportRecords(): { path: string; file: TFile; isFolder: boolean }[] {
		return [...this.pathToFile.entries()].map(([path, file]) => ({
			path,
			file,
			isFolder: this.folders.has(path),
		}));
	}

	/** Extract the parent path from a full path ("" for root-level items) */
	static parentPath(path: string): string {
		const i = path.lastIndexOf("/");
		return i === -1 ? "" : path.substring(0, i);
	}

	/** Clear all cached data */
	clear(): void {
		this.pathToFile.clear();
		this.idToPath.clear();
		this.folders.clear();
		this.children.clear();
	}

	/** Add a path to the children index */
	private addToIndex(path: string): void {
		const parent = AbstractMetadataCache.parentPath(path);
		let set = this.children.get(parent);
		if (!set) { set = new Set(); this.children.set(parent, set); }
		set.add(path);
	}

	/** Remove a path from the children index */
	private removeFromIndex(path: string): void {
		const parent = AbstractMetadataCache.parentPath(path);
		const set = this.children.get(parent);
		if (set) { set.delete(path); if (set.size === 0) this.children.delete(parent); }
	}

	/** Collect all descendant paths via the children index */
	collectDescendants(path: string): string[] {
		const result: string[] = [];
		const stack = [path];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			const kids = this.children.get(cur);
			if (kids) for (const c of kids) { result.push(c); stack.push(c); }
		}
		return result;
	}

	/**
	 * Find the parent ID that belongs to the sync root tree.
	 * Prefers rootFolderId, then falls back to any parent known in knownIds.
	 */
	findRelevantParentId(
		parents: string[],
		knownIds: { has(id: string): boolean }
	): string | undefined {
		if (parents.includes(this.rootFolderId)) return this.rootFolderId;
		for (const pid of parents) {
			if (knownIds.has(pid)) return pid;
		}
		return undefined;
	}

	/**
	 * Build the cache from a flat list of files (as returned by a full list).
	 * Resolves paths with memoization and bulk-loads into the cache.
	 */
	buildFromFiles(files: TFile[]): void {
		const byId = new Map<string, TFile>();
		for (const file of files) {
			byId.set(this.extractId(file), file);
		}

		const resolvedPaths = new Map<string, string>();
		const resolved: [string, TFile][] = [];
		for (const file of files) {
			const path = this.resolveFilePathCached(file, byId, resolvedPaths, new Set());
			resolved.push([path, file]);
		}

		this.bulkLoad(resolved);
	}

	/** Resolve a file's relative path using the existing cache */
	resolvePathFromCache(file: TFile): string | null {
		const parents = this.extractParentIds(file);
		if (parents.length === 0) return null;

		const parentId = this.findRelevantParentId(parents, this.idToPath);
		if (!parentId) return null;
		if (parentId === this.rootFolderId) {
			return this.extractName(file);
		}

		const parentPath = this.idToPath.get(parentId);
		if (!parentPath) return null;

		return `${parentPath}/${this.extractName(file)}`;
	}

	/**
	 * Resolve a file's path with memoization.
	 * Already-resolved ancestor paths are reused, cutting complexity from O(n×d) to O(n).
	 */
	resolveFilePathCached(
		file: TFile,
		byId: Map<string, TFile>,
		resolvedPaths: Map<string, string>,
		visiting: Set<string>
	): string {
		const id = this.extractId(file);
		const name = this.extractName(file);
		const cached = resolvedPaths.get(id);
		if (cached !== undefined) return cached;

		if (visiting.has(id)) {
			this.logger?.warn("Circular parent reference detected, truncating path", { fileName: name, fileId: id });
			resolvedPaths.set(id, name);
			return name;
		}

		const parents = this.extractParentIds(file);
		if (parents.length === 0) {
			resolvedPaths.set(id, name);
			return name;
		}

		const parentId = this.findRelevantParentId(parents, byId);
		if (!parentId || parentId === this.rootFolderId || parentId === id) {
			if (parentId === id) {
				this.logger?.warn("Circular parent reference detected, truncating path", { fileName: name, fileId: id });
			}
			resolvedPaths.set(id, name);
			return name;
		}

		const parent = byId.get(parentId);
		if (!parent) {
			resolvedPaths.set(id, name);
			return name;
		}

		visiting.add(id);
		const parentPath = this.resolveFilePathCached(parent, byId, resolvedPaths, visiting);
		visiting.delete(id);

		const fullPath = `${parentPath}/${name}`;
		resolvedPaths.set(id, fullPath);
		return fullPath;
	}

	/** Rewrite all cached child paths when a folder is renamed/moved */
	rewriteChildPaths(oldPath: string, newPath: string): void {
		const oldPrefix = oldPath + "/";
		const descendants = this.collectDescendants(oldPath);
		for (const childPath of descendants) {
			const childFile = this.pathToFile.get(childPath);
			if (!childFile) continue;
			const newChildPath = newPath + "/" + childPath.substring(oldPrefix.length);
			this.removeFromIndex(childPath);
			this.pathToFile.delete(childPath);
			this.pathToFile.set(newChildPath, childFile);
			this.idToPath.set(this.extractId(childFile), newChildPath);
			this.addToIndex(newChildPath);
			if (this.folders.delete(childPath)) {
				this.folders.add(newChildPath);
			}
		}
	}

	/** Remove an entry and all its descendants from the cache */
	removeTree(path: string): void {
		// Collect descendants before mutating; removeEntry only touches the parent's
		// child-set, not `path`'s own children entry, so the snapshot stays complete.
		const descendants = this.collectDescendants(path);
		this.removeEntry(path);
		for (const p of descendants) {
			this.removeEntry(p);
		}
		// Drop `path`'s own children-index entry (removeEntry only clears its membership
		// in the parent's set).
		this.children.delete(path);
	}

	/**
	 * Apply a file change and return move/rename information.
	 * Captures the old path before cache mutation for move detection.
	 */
	applyFileChangeDetectMove(file: TFile): FileChangeResult {
		const oldPath = this.getPathById(this.extractId(file));
		const wasFolder = oldPath ? this.isFolder(oldPath) : false;
		const oldDescendants = (oldPath && wasFolder)
			? this.collectDescendants(oldPath) : [];
		this.applyFileChange(file);
		const newPath = this.getPathById(this.extractId(file));
		return { oldPath, newPath, wasFolder, oldDescendants };
	}

	/** Apply a single file change to the metadata cache */
	applyFileChange(file: TFile): void {
		const id = this.extractId(file);
		const path = this.resolvePathFromCache(file);
		const oldPath = this.idToPath.get(id);

		if (!path) {
			// Can't resolve path (moved outside root or parent unknown).
			// Remove stale cache entry if one exists.
			if (oldPath) {
				this.removeTree(oldPath);
			}
			return;
		}

		// The backend's own metadata file is never tracked. If a previously-tracked
		// file was moved onto this reserved path, drop its stale entry too.
		if (this.isReserved(path)) {
			if (oldPath) this.removeTree(oldPath);
			return;
		}

		// A different entry already occupies this path with no preceding `deleted`
		// tombstone (the provider didn't emit the delete first, or batched them out
		// of order). Evict it — and, if it was a folder, its whole cached subtree —
		// so stale descendants don't linger as phantom paths, and idToPath doesn't
		// keep pointing the displaced id at this path.
		const occupant = this.pathToFile.get(path);
		if (occupant && this.extractId(occupant) !== id) {
			this.removeTree(path);
		}

		// Remove old mapping if ID was at a different path (rename/move)
		if (oldPath && oldPath !== path) {
			const wasFolder = this.folders.has(oldPath);
			this.removeFromIndex(oldPath);
			this.pathToFile.delete(oldPath);
			this.idToPath.delete(id);
			this.folders.delete(oldPath);
			if (wasFolder) {
				this.rewriteChildPaths(oldPath, path);
			}
		}

		this.pathToFile.set(path, file);
		this.idToPath.set(id, path);
		this.addToIndex(path);
		if (this.isFolderEntry(file)) {
			this.folders.add(path);
		} else {
			this.folders.delete(path);
		}
	}
}
