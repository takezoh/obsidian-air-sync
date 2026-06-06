import type { FileEntity } from "../types";
import type { PCloudEntry } from "./types";
import { pcloudEntryToEntity, withoutContents } from "./types";
import type { Logger } from "../../logging/logger";
import { INTERNAL_METADATA_PATH } from "../../sync/remote-vault";

export interface EntryChangeResult {
	oldPath: string | undefined;
	newPath: string | undefined;
	wasFolder: boolean;
	oldDescendants: string[];
}

/**
 * In-memory metadata cache for pCloud files.
 *
 * Maintains path↔id mappings (id = `"d<folderid>"`/`"f<fileid>"`), folder
 * tracking, and a parent→children index. Addressing is id-based because pCloud's
 * `diff` returns account-wide events whose metadata has no absolute path — a
 * delete is reverse-resolved through {@link getPathById}.
 */
export class PCloudMetadataCache {
	/** Maps relative path → pCloud entry */
	private pathToEntry = new Map<string, PCloudEntry>();
	/** Maps pCloud id ("d.."/"f..") → relative path */
	private idToPath = new Map<string, string>();
	/** Tracks which paths are folders */
	private folders = new Set<string>();
	/** Parent path → set of direct child paths */
	private children = new Map<string, Set<string>>();

	/** Numeric folder id of the sync root (the remote vault folder). */
	private rootFolderId: string;
	private logger?: Logger;

	constructor(rootFolderId: string, logger?: Logger) {
		this.rootFolderId = rootFolderId;
		this.logger = logger;
	}

	// ── Query methods ──

	getEntry(path: string): PCloudEntry | undefined { return this.pathToEntry.get(path); }
	hasEntry(path: string): boolean { return this.pathToEntry.has(path); }
	isFolder(path: string): boolean { return this.folders.has(path); }
	getPathById(id: string): string | undefined { return this.idToPath.get(id); }
	getChildren(path: string): ReadonlySet<string> | undefined { return this.children.get(path); }
	get size(): number { return this.pathToEntry.size; }
	entries(): IterableIterator<[string, PCloudEntry]> { return this.pathToEntry.entries(); }

	/** Build a FileEntity from cached metadata (no download). */
	entryToEntity(path: string, entry: PCloudEntry): FileEntity {
		return pcloudEntryToEntity(path, entry);
	}

	// ── Mutation methods ──

	/** Reserved backend paths are never tracked (see sync/remote-vault.ts). */
	private isReserved(path: string): boolean {
		return path === INTERNAL_METADATA_PATH;
	}

	/** Add or update an entry with full index maintenance. */
	setEntry(path: string, entry: PCloudEntry): void {
		if (this.isReserved(path)) return;
		const prev = this.pathToEntry.get(path);
		// Overwriting a path that was held by a DIFFERENT id must evict the old id
		// from idToPath. Otherwise a later delete event for the stale id would
		// reverse-resolve (getPathById) to this still-live path and removeTree() the
		// wrong entry — propagating a remote delete onto a file that still exists.
		if (prev && prev.id !== entry.id) this.idToPath.delete(prev.id);
		this.pathToEntry.set(path, withoutContents(entry));
		this.idToPath.set(entry.id, path);
		if (entry.isfolder) this.folders.add(path);
		else this.folders.delete(path);
		if (!prev) this.addToIndex(path);
	}

	/** Remove a single entry from all indices. */
	removeEntry(path: string): void {
		const entry = this.pathToEntry.get(path);
		if (entry) this.idToPath.delete(entry.id);
		this.removeFromIndex(path);
		this.pathToEntry.delete(path);
		this.folders.delete(path);
	}

	/** Bulk-load entries (e.g. restored from IndexedDB). */
	bulkLoad(items: Iterable<[string, PCloudEntry]>): void {
		for (const [path, entry] of items) {
			if (this.isReserved(path)) continue;
			this.pathToEntry.set(path, withoutContents(entry));
			this.idToPath.set(entry.id, path);
			if (entry.isfolder) this.folders.add(path);
		}
		for (const path of this.pathToEntry.keys()) {
			this.addToIndex(path);
		}
	}

	/** Snapshot all records for persistence. */
	exportRecords(): { path: string; file: PCloudEntry; isFolder: boolean }[] {
		return [...this.pathToEntry.entries()].map(([path, file]) => ({
			path,
			file,
			isFolder: this.folders.has(path),
		}));
	}

	/** Extract the parent path ("" for root-level items). */
	static parentPath(path: string): string {
		const i = path.lastIndexOf("/");
		return i === -1 ? "" : path.substring(0, i);
	}

	clear(): void {
		this.pathToEntry.clear();
		this.idToPath.clear();
		this.folders.clear();
		this.children.clear();
	}

	private addToIndex(path: string): void {
		const parent = PCloudMetadataCache.parentPath(path);
		let set = this.children.get(parent);
		if (!set) { set = new Set(); this.children.set(parent, set); }
		set.add(path);
	}

	private removeFromIndex(path: string): void {
		const parent = PCloudMetadataCache.parentPath(path);
		const set = this.children.get(parent);
		if (set) { set.delete(path); if (set.size === 0) this.children.delete(parent); }
	}

	/** Collect all descendant paths via the children index. */
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
	 * Build the cache from a recursive listfolder response (the root folder
	 * entry with nested `contents`). Paths are relative to the sync root.
	 */
	buildFromListFolder(root: PCloudEntry): void {
		this.clear();
		const walk = (entry: PCloudEntry, prefix: string): void => {
			for (const child of entry.contents ?? []) {
				const path = prefix ? `${prefix}/${child.name}` : child.name;
				this.setEntry(path, child);
				if (child.isfolder) walk(child, path);
			}
		};
		walk(root, "");
	}

	/** Resolve an entry's relative path against the existing cache, or null. */
	resolvePathFromCache(entry: PCloudEntry): string | null {
		const parentId = entry.parentfolderid;
		if (parentId == null) return null;
		if (String(parentId) === this.rootFolderId) return entry.name;
		const parentPath = this.idToPath.get("d" + parentId);
		if (parentPath == null) return null;
		return `${parentPath}/${entry.name}`;
	}

	/** Rewrite all cached child paths when a folder is renamed/moved. */
	rewriteChildPaths(oldPath: string, newPath: string): void {
		const oldPrefix = oldPath + "/";
		const descendants = this.collectDescendants(oldPath);
		for (const childPath of descendants) {
			const childEntry = this.pathToEntry.get(childPath);
			if (!childEntry) continue;
			const newChildPath = newPath + "/" + childPath.substring(oldPrefix.length);
			this.removeFromIndex(childPath);
			this.pathToEntry.delete(childPath);
			this.pathToEntry.set(newChildPath, childEntry);
			this.idToPath.set(childEntry.id, newChildPath);
			this.addToIndex(newChildPath);
			if (this.folders.delete(childPath)) this.folders.add(newChildPath);
		}
	}

	/** Remove an entry and all its descendants. */
	removeTree(path: string): void {
		const entry = this.pathToEntry.get(path);
		if (entry) this.idToPath.delete(entry.id);
		this.removeFromIndex(path);
		this.pathToEntry.delete(path);
		this.folders.delete(path);

		const descendants = this.collectDescendants(path);
		for (const p of descendants) {
			const e = this.pathToEntry.get(p);
			if (e) this.idToPath.delete(e.id);
			this.removeFromIndex(p);
			this.pathToEntry.delete(p);
			this.folders.delete(p);
		}
		this.children.delete(path);
	}

	/** Apply a change and report move/rename info (old path captured first). */
	applyEntryDetectMove(entry: PCloudEntry): EntryChangeResult {
		const oldPath = this.getPathById(entry.id);
		const wasFolder = oldPath ? this.isFolder(oldPath) : false;
		const oldDescendants = oldPath && wasFolder ? this.collectDescendants(oldPath) : [];
		this.applyEntryChange(entry);
		const newPath = this.getPathById(entry.id);
		return { oldPath, newPath, wasFolder, oldDescendants };
	}

	/** Apply a single entry change to the cache. */
	applyEntryChange(entry: PCloudEntry): void {
		const path = this.resolvePathFromCache(entry);
		const oldPath = this.idToPath.get(entry.id);

		// Can't resolve (moved outside root / unknown parent) or moved onto the
		// reserved metadata path → drop any stale entry and stop.
		if (path == null || this.isReserved(path)) {
			if (oldPath) this.removeTree(oldPath);
			return;
		}

		// Rename/move: detach the old mapping (rewriting children for folders).
		if (oldPath && oldPath !== path) {
			const wasFolder = this.folders.has(oldPath);
			this.removeFromIndex(oldPath);
			this.pathToEntry.delete(oldPath);
			this.idToPath.delete(entry.id);
			this.folders.delete(oldPath);
			if (wasFolder) this.rewriteChildPaths(oldPath, path);
		}

		this.setEntry(path, entry);
	}
}
