import type { FileEntity } from "../types";
import type { DropboxEntry } from "./types";
import { parseDropboxTime } from "./types";
import type { DropboxClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import { DropboxMetadataCache } from "./metadata-cache";
import { applyDropboxDelta } from "./incremental-sync";
import { INTERNAL_METADATA_PATH } from "../remote-vault-contract";
import { sha256 } from "../../utils/hash";
import { normalizeSyncPath, validateRename } from "../../utils/path";
import { CachingRemoteFs } from "../caching/remote-fs";
import type { IncrementalChangesResult } from "../caching/remote-fs";

/**
 * IFileSystem implementation backed by Dropbox (App Folder scope).
 *
 * The crash-safe cache/checkpoint machinery (ADR 0001) lives in
 * {@link CachingRemoteFs}; this subclass supplies the Dropbox-specific seams and
 * the mutating ops. Operations are addressed by the vault's stable folder id
 * (`id:<id>/<subpath>`), never an absolute path — so a remote move/rename of the
 * folder needs no migration. The folder's absolute path is resolved from the id
 * each cycle solely to relativize `list_folder`'s absolute results into
 * vault-relative keys ({@link refreshRootPath}).
 */
export class DropboxFs extends CachingRemoteFs<DropboxEntry> {
	readonly name = "dropbox";
	private client: DropboxClient;
	// The base stores the cache as AbstractMetadataCache; narrow it so the
	// Dropbox-specific seams (relativize/setRootPath/setEntry) are visible. The
	// runtime value IS a DropboxMetadataCache (passed to super below).
	protected declare cache: DropboxMetadataCache;

	constructor(client: DropboxClient, rootFolderId: string, logger?: Logger, metadataStore?: MetadataStore<DropboxEntry>) {
		// No root path up front: the vault is addressed purely by its stable folder id.
		// The cache's relativize anchor is set transiently each cycle from that id (via
		// refreshRootPath); rootFolderId is threaded only to satisfy the base ctor.
		super(rootFolderId, new DropboxMetadataCache("", logger, rootFolderId), metadataStore, logger);
		this.client = client;
	}

	/**
	 * The id-relative Dropbox address for a sync-relative path ("" → the vault root).
	 * Dropbox accepts `id:<folderid>/<subpath>`, so every operation addresses the vault
	 * by its stable folder id — location-independent, with no absolute path to resolve.
	 */
	private addr(relPath: string): string {
		return relPath ? `${this.rootFolderId}/${relPath}` : this.rootFolderId;
	}

	/**
	 * Re-anchor the cache's relativize root to the vault folder's CURRENT absolute path,
	 * resolved from its stable id. Operations address by id (location-independent), so
	 * this is needed ONLY to relativize list_folder's absolute `path_display` results
	 * into vault-relative keys — and tracks a remote move/rename for free. Also asserts
	 * the folder still exists. ~1 get_metadata/cycle.
	 */
	private async refreshRootPath(): Promise<void> {
		const meta = await this.client.getMetadata(this.rootFolderId);
		if (!meta.path_display) {
			throw new Error(`Dropbox vault folder ${this.rootFolderId} has no path (deleted?)`);
		}
		this.cache.setRootPath(meta.path_display);
	}

	// ── Dropbox-specific seams ──

	protected async getStartCursor(): Promise<string> {
		// fullScan calls getStartCursor BEFORE fullList, so set the relativize anchor
		// here (and assert liveness) before the listing is relativized in buildFromFiles.
		await this.refreshRootPath();
		return this.client.getLatestCursor(this.rootFolderId, true);
	}

	protected fullList(): Promise<DropboxEntry[]> {
		return this.client.listFolderAll(this.rootFolderId, true);
	}

	protected async assertRootAlive(): Promise<void> {
		// An empty listing is ambiguous (genuinely empty vault vs deleted/trashed root).
		// get_metadata throws `not_found` if the folder is gone, so an empty list of a
		// deleted root aborts here rather than letting a cold reconcile read every file
		// as remotely deleted and plan a mass delete_local.
		await this.client.getMetadata(this.rootFolderId);
	}

	protected async fetchChanges(cursor: string): Promise<IncrementalChangesResult> {
		// Re-anchor to the folder's current path before relativizing delta entries, so a
		// remote move/rename since last cycle (or since a cache restore, which does not
		// refresh the anchor) is tracked.
		await this.refreshRootPath();
		return applyDropboxDelta({ cache: this.cache, client: this.client, logger: this.logger }, cursor);
	}

	protected downloadFile(fileId: string): Promise<ArrayBuffer> {
		// fileId is the entry's stable id (`id:…`); Dropbox download accepts it directly,
		// so a download works regardless of where the vault folder currently lives.
		return this.client.download(fileId);
	}

	protected deleteRemote(fileId: string): Promise<void> {
		return this.client.deletePath(fileId);
	}

	// ── Mutating ops (Dropbox API; addressed by id-relative path) ──

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		if (path === INTERNAL_METADATA_PATH) {
			throw new Error(`Refusing to write reserved backend path: ${path}`);
		}
		const { result: entry } = await this.withCacheMutex({
			operationName: "write",
			resolve: async () => {
				if (this.cache.isFolder(path)) {
					throw new Error(`Cannot write file: "${path}" is an existing directory`);
				}
				const existingId = this.cache.idAt(path);
				await this.ensureFolder(DropboxMetadataCache.parentPath(path));
				return { existingId };
			},
			execute: () => this.client.upload(this.addr(path), content, mtime),
			staleGuard: (r) => ({ path, expectedId: r.existingId }),
			update: (_r, result) => { this.cache.setEntry(path, result); },
		});

		const hash = await sha256(content);
		return {
			path,
			isDirectory: false,
			size: content.byteLength,
			mtime: parseDropboxTime(entry.server_modified ?? entry.client_modified),
			hash,
			remoteChecksum: entry.content_hash ? { algo: "dropbox", value: entry.content_hash } : undefined,
			backendMeta: { dropboxId: entry.id, rev: entry.rev },
		};
	}

	async mkdir(path: string): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			await this.ensureFolder(path);
			const entry = this.cache.getFile(path);
			return { path, isDirectory: true, size: 0, mtime: 0, hash: "", backendMeta: { dropboxId: entry?.id } };
		});
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		oldPath = normalizeSyncPath(oldPath);
		newPath = normalizeSyncPath(newPath);
		validateRename(oldPath, newPath);
		await this.withCacheMutex({
			operationName: "rename",
			resolve: async () => {
				const entry = this.cache.getFile(oldPath);
				if (!entry) throw new Error(`File not found: ${oldPath}`);
				if (this.cache.hasFile(newPath)) throw new Error(`Destination already exists: ${newPath}`);
				await this.ensureFolder(DropboxMetadataCache.parentPath(newPath));
				return { expectedId: this.cache.idAt(oldPath), wasFolder: this.cache.isFolder(oldPath) };
			},
			execute: () => this.client.move(this.addr(oldPath), this.addr(newPath)),
			staleGuard: (r) => ({ path: oldPath, expectedId: r.expectedId }),
			update: (r, result) => {
				// The shared staleGuard only validates the SOURCE (oldPath still resolves to
				// our id). A concurrent re-keyer could land a DIFFERENT entry at newPath during
				// the phase-2 move (run outside the mutex); setEntry would evict and overwrite
				// it, dropping that change. Skip instead — symmetric with write()'s new-path
				// guard and GoogleDriveFs.rename; the in-memory cursor advanced past it, so the
				// next cycle re-detects our rename. Currently unreachable (ADR 0001, T7:
				// rename runs serially in Group B, deltas never run during execute) — retained
				// as defense-in-depth.
				const occupant = this.cache.getFile(newPath);
				if (occupant && occupant.id !== result.id) {
					this.logger?.warn("Skipping stale cache update for rename", { path: newPath });
					return;
				}
				this.cache.removeEntry(oldPath);
				// move_v2's metadata may arrive without a `.tag` discriminator; stamp it
				// from the known prior type so the cache keeps classifying a moved folder
				// as a folder (else a later write into it fails with "is a file").
				this.cache.setEntry(newPath, { ...result, ".tag": r.wasFolder ? "folder" : "file" });
				if (r.wasFolder) this.cache.rewriteChildPaths(oldPath, newPath);
			},
		});
	}

	/** Ensure a folder exists by path, creating parents as needed (idempotent). */
	private async ensureFolder(path: string): Promise<void> {
		if (!path || this.cache.isFolder(path)) return;
		const parts = path.split("/");
		let currentPath = "";
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			if (this.cache.isFolder(currentPath)) continue;
			if (this.cache.hasFile(currentPath)) {
				throw new Error(`Cannot create directory "${path}": "${currentPath}" is a file`);
			}
			const folder = await this.client.createFolder(this.addr(currentPath));
			this.cache.setEntry(currentPath, folder);
		}
	}
}
