import type { FileEntity } from "../types";
import type { DropboxEntry } from "./types";
import { dropboxEntryToEntity } from "./types";
import type { Logger } from "../../logging/logger";
import { AbstractMetadataCache } from "../caching/metadata-cache";

/** Split a path into its non-empty segments. */
function segments(path: string): string[] {
	return path.split("/").filter(Boolean);
}

/**
 * Dropbox's metadata cache. All the data structures, the path↔id maps, the
 * children index, and tree mutation (rename/move/delete-subtree) live in
 * {@link AbstractMetadataCache}; this subclass supplies the two things that are
 * genuinely Dropbox-specific:
 *
 * - **Path resolution by relativizing `path_display`**, not by walking parent ids.
 *   Dropbox's delta carries each entry's absolute path, so paths are resolved
 *   against the vault root's CURRENT absolute path ({@link relativize}) rather than
 *   the base's id→parent-chain join. {@link buildFromFiles} is overridden for the
 *   same reason. This is why `extractParentIds` is empty — it would only be read by
 *   the base's id-chain resolver, which Dropbox never uses.
 * - **The relativize anchor**, refreshed each cycle from the stable folder id
 *   ({@link setRootPath}), so a remote move/rename of the vault folder relativizes
 *   correctly with no rebuild.
 */
export class DropboxMetadataCache extends AbstractMetadataCache<DropboxEntry> {
	/** Case-folded segments of the remote vault root (for relativizing absolute paths). */
	private rootSegmentsLower: string[];

	// rootPath is the relativize anchor (the vault root's absolute path) and is the
	// PRIMARY ctor arg. It is optional: DropboxFs constructs the cache before the vault's
	// absolute path is known (it addresses by id) and sets the anchor each cycle via
	// setRootPath; tests may pass a root up front. rootFolderId is the stable `id:…`,
	// passed only to satisfy the base ctor — Dropbox resolves paths by relativizing, not
	// by parent-id chains, so the base's id-chain resolver (which reads it) is never used.
	constructor(rootPath = "", logger?: Logger, rootFolderId = "") {
		super(rootFolderId, logger);
		this.rootSegmentsLower = segments(rootPath.toLowerCase());
	}

	// ── Per-backend seams ──

	// Cached file/folder entries always carry a stable Dropbox `id` ("id:…"); only a
	// `deleted` entry lacks one, and those are never cached. The `path_lower` fallback
	// keeps `extractId` total for the type's optionality — and it is functional, not a
	// dummy: a lowercased absolute path is itself a valid Dropbox address for
	// download/delete. Rename coalescing (delta) only reverse-looks-up by a real id.
	protected extractId(entry: DropboxEntry): string {
		return entry.id ?? entry.path_lower;
	}

	// Dropbox entries carry no parent id — paths come from relativizing `path_display`
	// (see buildFromFiles/relativize). Empty so the base's id-chain resolver, which
	// Dropbox never invokes, has nothing to walk.
	protected extractParentIds(): string[] {
		return [];
	}

	protected extractName(entry: DropboxEntry): string {
		return entry.name;
	}

	protected isFolderEntry(entry: DropboxEntry): boolean {
		return entry[".tag"] === "folder";
	}

	toEntity(path: string, entry: DropboxEntry): FileEntity {
		return dropboxEntryToEntity(path, entry);
	}

	// ── Dropbox-specific path resolution ──

	/**
	 * Re-anchor the cache to a new absolute root path (the vault folder's current
	 * location). Cache keys are sync-relative, so a remote move/rename of the root
	 * folder only requires updating the relativize anchor — no entry is rebuilt.
	 */
	setRootPath(rootPath: string): void {
		this.rootSegmentsLower = segments(rootPath.toLowerCase());
	}

	/**
	 * Resolve a Dropbox entry's absolute path to a sync-relative path, or null if it
	 * is outside the remote vault root. Matching is case-insensitive (via `path_lower`);
	 * the returned path preserves the user's casing (`path_display`). Returns `""` for
	 * the root folder itself.
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

	/**
	 * Add or update an entry at a KNOWN (already-relativized) path. Unlike the base
	 * `setFile` — which assumes a clean upsert — this evicts a different entry that
	 * occupies the path with no preceding `deleted` tombstone (a delta that didn't emit
	 * the delete first, or batched it out of order): its whole subtree if it was a
	 * folder, and its stale id mapping either way, so phantom descendants don't linger
	 * and the displaced id stops reverse-resolving to this live path.
	 */
	setEntry(path: string, entry: DropboxEntry): void {
		const prev = this.getFile(path);
		if (prev && this.extractId(prev) !== this.extractId(entry)) {
			if (this.isFolder(path)) this.removeTree(path);
			else this.removeEntry(path);
		}
		this.setFile(path, entry);
	}

	/**
	 * Build the cache from a flat list of recursive `list_folder` entries (Dropbox's
	 * full-scan shape), relativizing each `path_display` against the current root.
	 * Overrides the base id-chain build: Dropbox entries carry no parent id. Entries
	 * outside the root, the root itself, or `deleted` tombstones are skipped. The
	 * caller ({@link AbstractMetadataCache} consumers / `CachingRemoteFs.fullScan`)
	 * clears first, so this only upserts.
	 */
	buildFromFiles(entries: DropboxEntry[]): void {
		for (const entry of entries) {
			if (entry[".tag"] === "deleted") continue;
			const path = this.relativize(entry);
			if (path === null || path === "") continue;
			this.setEntry(path, entry);
		}
	}
}
