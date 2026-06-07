import type { FileEntity } from "../types";
import type { DropboxEntry } from "./types";
import { dropboxEntryToEntity, isFolderEntry } from "./types";
import type { Logger } from "../../logging/logger";
import { INTERNAL_METADATA_PATH } from "../../sync/remote-vault";

/** Split a path into its non-empty segments. */
function segments(path: string): string[] {
	return path.split("/").filter(Boolean);
}

/**
 * In-memory metadata cache for Dropbox files, keyed by sync-relative path.
 *
 * Dropbox addresses by path and its delta carries absolute paths (even for
 * deletes), so the cache is path-primary — simpler than pCloud's id-reverse
 * lookup. An `idToPath` side index is kept only to coalesce a Dropbox
 * `deleted`+`file` pair (same stable `id`, different path) back into a rename.
 */
export class DropboxMetadataCache {
	/** Maps relative path → Dropbox entry */
	private pathToEntry = new Map<string, DropboxEntry>();
	/** Maps Dropbox id ("id:…") → relative path (rename detection) */
	private idToPath = new Map<string, string>();
	/** Tracks which paths are folders */
	private folders = new Set<string>();
	/** Parent path → set of direct child paths */
	private children = new Map<string, Set<string>>();

	/** Case-folded segments of the remote vault root (for relativizing absolute paths). */
	private rootSegmentsLower: string[];
	private logger?: Logger;

	// rootPath is optional: DropboxFs constructs the cache before the vault's
	// absolute path is known (it addresses by id) and sets the relativize anchor
	// each cycle via setRootPath. Tests may pass a root up front for convenience.
	constructor(rootPath = "", logger?: Logger) {
		this.rootSegmentsLower = segments(rootPath.toLowerCase());
		this.logger = logger;
	}

	/**
	 * Re-anchor the cache to a new absolute root path (the vault folder's current
	 * location). Cache keys are sync-relative, so a remote move/rename of the root
	 * folder only requires updating the relativize anchor — no entry is rebuilt.
	 */
	setRootPath(rootPath: string): void {
		this.rootSegmentsLower = segments(rootPath.toLowerCase());
	}

	// ── Query methods ──

	getEntry(path: string): DropboxEntry | undefined { return this.pathToEntry.get(path); }
	hasEntry(path: string): boolean { return this.pathToEntry.has(path); }
	isFolder(path: string): boolean { return this.folders.has(path); }
	getPathById(id: string): string | undefined { return this.idToPath.get(id); }
	getChildren(path: string): ReadonlySet<string> | undefined { return this.children.get(path); }
	get size(): number { return this.pathToEntry.size; }
	entries(): IterableIterator<[string, DropboxEntry]> { return this.pathToEntry.entries(); }

	/** Build a FileEntity from cached metadata (no download). */
	entryToEntity(path: string, entry: DropboxEntry): FileEntity {
		return dropboxEntryToEntity(path, entry);
	}

	/**
	 * Resolve a Dropbox entry's absolute path to a sync-relative path, or null if
	 * it is outside the remote vault root. Matching is case-insensitive (via
	 * `path_lower`); the returned path preserves the user's casing (`path_display`).
	 * Returns `""` for the root folder itself.
	 *
	 * The anchor is the CURRENT root path, refreshed from the stable folder id each
	 * sync cycle ({@link setRootPath}, driven by `DropboxFs.refreshRootPath`), so a
	 * remote move/rename of the vault folder relativizes correctly without a rebuild.
	 */
	relativize(entry: { path_lower: string; path_display: string }): string | null {
		const lower = segments(entry.path_lower);
		const display = segments(entry.path_display);
		if (lower.length < this.rootSegmentsLower.length) return null;
		for (let i = 0; i < this.rootSegmentsLower.length; i++) {
			if (lower[i] !== this.rootSegmentsLower[i]) return null;
		}
		return display.slice(this.rootSegmentsLower.length).join("/");
	}

	// ── Mutation methods ──

	/** Reserved backend paths are never tracked (see sync/remote-vault.ts). */
	private isReserved(path: string): boolean {
		return path === INTERNAL_METADATA_PATH;
	}

	/** Add or update an entry with full index maintenance. */
	setEntry(path: string, entry: DropboxEntry): void {
		if (this.isReserved(path)) return;
		let prev = this.pathToEntry.get(path);
		// A different entry now occupies this path with no preceding `deleted` tombstone
		// (the provider didn't emit the delete first, or batched out of order). If the
		// displaced entry was a folder, evict its whole cached subtree first so stale
		// descendants don't linger as phantom paths.
		if (prev && prev.id !== entry.id && this.folders.has(path)) {
			this.removeTree(path); // clears prev + its subtree + idToPath + children index
			prev = undefined;
		}
		// Overwriting a path held by a DIFFERENT id must evict the stale id from
		// idToPath, or a later delete for that id would reverse-resolve to this
		// still-live path and removeTree the wrong entry.
		if (prev && prev.id && prev.id !== entry.id) this.idToPath.delete(prev.id);
		this.pathToEntry.set(path, entry);
		if (entry.id) this.idToPath.set(entry.id, path);
		if (isFolderEntry(entry)) this.folders.add(path);
		else this.folders.delete(path);
		if (!prev) this.addToIndex(path);
	}

	/** Remove a single entry from all indices. */
	removeEntry(path: string): void {
		const entry = this.pathToEntry.get(path);
		if (entry?.id) this.idToPath.delete(entry.id);
		this.removeFromIndex(path);
		this.pathToEntry.delete(path);
		this.folders.delete(path);
	}

	/** Bulk-load entries (e.g. restored from IndexedDB). */
	bulkLoad(items: Iterable<[string, DropboxEntry]>): void {
		for (const [path, entry] of items) {
			if (this.isReserved(path)) continue;
			this.pathToEntry.set(path, entry);
			if (entry.id) this.idToPath.set(entry.id, path);
			if (isFolderEntry(entry)) this.folders.add(path);
		}
		for (const path of this.pathToEntry.keys()) {
			this.addToIndex(path);
		}
	}

	/** Snapshot all records for persistence. */
	exportRecords(): { path: string; file: DropboxEntry; isFolder: boolean }[] {
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
		const parent = DropboxMetadataCache.parentPath(path);
		let set = this.children.get(parent);
		if (!set) { set = new Set(); this.children.set(parent, set); }
		set.add(path);
	}

	private removeFromIndex(path: string): void {
		const parent = DropboxMetadataCache.parentPath(path);
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
	 * Build the cache from a flat list of recursive `list_folder` entries.
	 * Entries outside the root (or that fail to relativize) are skipped.
	 */
	buildFromEntries(entries: Iterable<DropboxEntry>): void {
		this.clear();
		for (const entry of entries) {
			if (entry[".tag"] === "deleted") continue;
			const path = this.relativize(entry);
			if (path === null || path === "") continue;
			this.setEntry(path, entry);
		}
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
			if (childEntry.id) this.idToPath.set(childEntry.id, newChildPath);
			this.addToIndex(newChildPath);
			if (this.folders.delete(childPath)) this.folders.add(newChildPath);
		}
	}

	/** Remove an entry and all its descendants. */
	removeTree(path: string): void {
		const descendants = this.collectDescendants(path);
		for (const p of [path, ...descendants]) {
			const e = this.pathToEntry.get(p);
			if (e?.id) this.idToPath.delete(e.id);
			this.removeFromIndex(p);
			this.pathToEntry.delete(p);
			this.folders.delete(p);
		}
		this.children.delete(path);
	}
}
