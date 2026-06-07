import type { IFileSystem } from "../interface";
import type { FileEntity } from "../types";
import type { DropboxEntry } from "./types";
import { parseDropboxTime } from "./types";
import type { DropboxClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import type { RenamePair } from "../../sync/types";
import { DropboxMetadataCache } from "./metadata-cache";
import {
	applyDropboxDelta,
	classifyChangedPaths,
	commitDropboxCache,
	computeFullScanDelta,
	type RemoteDelta,
} from "./incremental-sync";
import { INTERNAL_METADATA_PATH } from "../../sync/remote-vault";
import { sha256 } from "../../utils/hash";
import { validateRename } from "../../utils/path";
import { AsyncMutex } from "../../queue/async-queue";

/**
 * IFileSystem implementation backed by Dropbox (App Folder scope).
 *
 * Operations are addressed by the vault's stable folder id (`id:<id>/<subpath>`),
 * never an absolute path — so a remote move/rename of the folder needs no
 * migration. The cache stores Dropbox metadata (path, mtime, size, `content_hash`)
 * so list()/stat() never download. After the initial recursive `list_folder` it
 * tracks remote changes incrementally via `list_folder/continue` + a cursor rooted
 * at the same folder id. The folder's absolute path is resolved from the id each
 * cycle solely to relativize `list_folder`'s absolute results into vault-relative keys.
 */
export class DropboxFs implements IFileSystem {
	readonly name = "dropbox";
	private cache: DropboxMetadataCache;
	private initialized = false;
	private cacheMutex = new AsyncMutex();

	/** Latest `list_folder` delta cursor (for incremental sync). */
	private _cursor: string | null = null;

	/**
	 * Cache changes not yet flushed to IndexedDB — persistence is deferred to the
	 * checkpoint commit ({@link commitCheckpoint}) so the persisted cache never runs
	 * ahead of the committed cursor (a crash would otherwise drop a deletion the
	 * replay can't re-detect). `pendingFullPersist` supersedes it after a full scan.
	 */
	private touchedPaths = new Set<string>();
	private pendingFullPersist = false;

	constructor(
		private client: DropboxClient,
		private rootFolderId: string,
		private logger?: Logger,
		private metadataStore?: MetadataStore<DropboxEntry>,
	) {
		// No root path: the vault is addressed purely by its stable folder id. The
		// cache's relativize anchor is set transiently each cycle from that id.
		this.cache = new DropboxMetadataCache(undefined, logger);
	}

	get cursor(): string | null {
		return this._cursor;
	}

	set cursor(value: string | null) {
		this._cursor = value;
	}

	/**
	 * The id-relative Dropbox address for a sync-relative path ("" → the vault
	 * root). Dropbox accepts `id:<folderid>/<subpath>`, so every operation
	 * addresses the vault by its stable folder id — location-independent, with no
	 * absolute path to resolve, store, or keep in sync.
	 */
	private addr(relPath: string): string {
		return relPath ? `${this.rootFolderId}/${relPath}` : this.rootFolderId;
	}

	/** The stable id-rooted address (`id:…`) used for cursor capture and listing. */
	private get cursorRoot(): string {
		return this.rootFolderId;
	}

	/**
	 * Re-anchor the cache's relativize root to the vault folder's CURRENT absolute
	 * path, resolved from its stable id. Operations address by id (location-
	 * independent), so this is needed ONLY to relativize list_folder's absolute
	 * `path_display` results into vault-relative keys — and tracks a remote move/
	 * rename for free. Also asserts the folder still exists. ~1 get_metadata/cycle.
	 */
	private async refreshRootPath(): Promise<void> {
		const meta = await this.client.getMetadata(this.rootFolderId);
		if (!meta.path_display) {
			throw new Error(`Dropbox vault folder ${this.rootFolderId} has no path (deleted?)`);
		}
		this.cache.setRootPath(meta.path_display);
	}

	private async withCacheMutex<TResolved, TResult>(opts: {
		resolve: () => Promise<TResolved> | TResolved;
		execute: (resolved: TResolved) => Promise<TResult>;
		update: (resolved: TResolved, result: TResult) => void;
		staleGuard: (resolved: TResolved) => { path: string; expectedId: string | undefined };
		operationName: string;
	}): Promise<{ resolved: TResolved; result: TResult }> {
		const resolved = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			return opts.resolve();
		});
		const result = await opts.execute(resolved);
		await this.cacheMutex.run(() => {
			const { path, expectedId } = opts.staleGuard(resolved);
			if (expectedId && this.cache.getEntry(path)?.id !== expectedId) {
				this.logger?.warn(`Skipping stale cache update for ${opts.operationName}`, { path });
				return;
			}
			opts.update(resolved, result);
		});
		return { resolved, result };
	}

	/** Full scan: capture the delta cursor BEFORE listing so no change is missed. */
	private async fullScan(): Promise<void> {
		this.cache.clear();
		// Resolve the current root path from the stable id so listing + relativize
		// target the folder wherever it now lives. Both list and cursor use the id.
		await this.refreshRootPath();
		this._cursor = await this.client.getLatestCursor(this.cursorRoot, true);
		const entries = await this.client.listFolderAll(this.cursorRoot, true);
		this.cache.buildFromEntries(entries);
		this.initialized = true;
		// Whole cache rebuilt → flush it all at the next commit (not just touched paths).
		this.touchedPaths.clear();
		this.pendingFullPersist = true;
		this.logger?.info("Full scan completed", { fileCount: this.cache.size });
	}

	/**
	 * Ensure the cache is initialized. Returns true when the cursor is a prior
	 * checkpoint warranting an incremental replay; false after a fresh full scan.
	 */
	private async ensureInitialized(): Promise<boolean> {
		if (this.initialized) return true;
		if (this._cursor) {
			if (await this.loadFromCache()) {
				// loadFromCache restores relative keys but NOT the cache's relativize
				// anchor; set it from the id before any applyDelta relativizes new delta
				// entries (list() reaches applyDelta without its own refreshRootPath).
				await this.refreshRootPath();
				return true;
			}
			const keep = this._cursor;
			await this.fullScan();
			this._cursor = keep;
			return true;
		}
		await this.fullScan();
		return false;
	}

	/** Restore the file map from IndexedDB, or false to trigger a full scan. */
	private async loadFromCache(): Promise<boolean> {
		if (!this.metadataStore || !this._cursor) return false;
		try {
			await this.metadataStore.open();
			const { files } = await this.metadataStore.loadAll();
			if (files.length === 0) return false;
			this.cache.clear();
			this.cache.bulkLoad(files.map((r) => [r.path, r.file]));
			this.initialized = true;
			this.logger?.info("Cache loaded from IndexedDB", { fileCount: files.length });
			return true;
		} catch (err) {
			this.logger?.warn("Failed to load cache from IndexedDB, will full scan", {
				message: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	/**
	 * Flush the cache to IndexedDB. Called only after a clean cycle, before the
	 * cursor commits (see IBackendProvider.commitCheckpoint), so the persisted cache
	 * tracks the committed cursor and never runs ahead of it.
	 */
	async commitCheckpoint(): Promise<void> {
		const store = this.metadataStore;
		if (!store) return;
		await this.cacheMutex.run(async () => {
			try {
				await commitDropboxCache(store, this.cache, this.touchedPaths, this.pendingFullPersist);
			} catch (err) {
				this.logger?.warn("Failed to persist checkpoint to IndexedDB", {
					message: err instanceof Error ? err.message : String(err),
				});
			}
			this.pendingFullPersist = false;
			this.touchedPaths.clear();
		});
	}

	/** Apply delta from the current cursor (caller ensured init + holds mutex). */
	private async applyDelta(): Promise<RemoteDelta | null> {
		if (!this._cursor) return null;
		const result = await applyDropboxDelta(
			{ cache: this.cache, client: this.client, logger: this.logger },
			this._cursor,
		);
		if (result.needsFullScan) return this.fullScanWithDelta();
		this._cursor = result.newCursor;
		// Buffer changed paths for the checkpoint commit (persisted only on a clean cycle).
		for (const p of result.changedPaths) this.touchedPaths.add(p);
		return classifyChangedPaths(this.cache, result.changedPaths, result.renamedPaths);
	}

	/** On a lost cursor (reset): snapshot-diff a fresh full scan. */
	private async fullScanWithDelta(): Promise<RemoteDelta | null> {
		const oldPathById = new Map<string, string>();
		for (const [path, entry] of this.cache.entries()) {
			if (entry.id) oldPathById.set(entry.id, path);
		}
		await this.fullScan();
		return computeFullScanDelta(oldPathById, this.cache);
	}

	async getChangedPaths(): Promise<{ modified: string[]; deleted: string[]; renamed?: RenamePair[] } | null> {
		return this.cacheMutex.run(async () => {
			const replay = await this.ensureInitialized();
			if (!replay) return null;
			// Re-anchor to the folder's current path before relativizing delta entries,
			// so a remote move/rename since last cycle is tracked. (fullScan, the other
			// entry point, refreshes internally.) list() runs after this within the
			// cycle and reuses the same anchor.
			await this.refreshRootPath();
			return this.applyDelta();
		});
	}

	async list(): Promise<FileEntity[]> {
		return this.cacheMutex.run(async () => {
			if (await this.ensureInitialized()) await this.applyDelta();
			const entities: FileEntity[] = [];
			for (const [path, entry] of this.cache.entries()) {
				entities.push(this.cache.entryToEntity(path, entry));
			}
			return entities;
		});
	}

	async stat(path: string): Promise<FileEntity | null> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const entry = this.cache.getEntry(path);
			return entry ? this.cache.entryToEntity(path, entry) : null;
		});
	}

	async read(path: string): Promise<ArrayBuffer> {
		// Download by the file's stable id, not its path — works regardless of where
		// the vault folder currently lives (id addressing is location-independent).
		const fileRef = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const entry = this.cache.getEntry(path);
			if (!entry || entry[".tag"] === "folder") throw new Error(`File not found on Dropbox: ${path}`);
			return entry.id ?? this.addr(path);
		});
		return this.client.download(fileRef);
	}

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		if (path === INTERNAL_METADATA_PATH) {
			throw new Error(`Refusing to write reserved backend path: ${path}`);
		}
		const { result: entry } = await this.withCacheMutex({
			operationName: "write",
			resolve: async () => {
				const existing = this.cache.getEntry(path);
				await this.ensureFolder(DropboxMetadataCache.parentPath(path));
				return { existingId: existing?.id };
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
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			await this.ensureFolder(path);
			const entry = this.cache.getEntry(path);
			return { path, isDirectory: true, size: 0, mtime: 0, hash: "", backendMeta: { dropboxId: entry?.id } };
		});
	}

	async listDir(path: string): Promise<FileEntity[]> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const kids = this.cache.getChildren(path);
			if (!kids) return [];
			const entities: FileEntity[] = [];
			for (const childPath of kids) {
				const entry = this.cache.getEntry(childPath);
				if (entry) entities.push(this.cache.entryToEntity(childPath, entry));
			}
			return entities;
		});
	}

	async delete(path: string): Promise<void> {
		const target = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const entry = this.cache.getEntry(path);
			return entry ? { id: entry.id } : null;
		});
		if (!target) return;

		// Delete by the stable id (location-independent); fall back to path if absent.
		await this.client.deletePath(target.id ?? this.addr(path));

		await this.cacheMutex.run(() => {
			if (this.cache.getEntry(path)?.id === target.id) this.cache.removeTree(path);
			else this.logger?.warn("Skipping stale cache update for delete", { path });
		});
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		validateRename(oldPath, newPath);
		await this.withCacheMutex({
			operationName: "rename",
			resolve: async () => {
				const entry = this.cache.getEntry(oldPath);
				if (!entry) throw new Error(`File not found: ${oldPath}`);
				if (this.cache.hasEntry(newPath)) throw new Error(`Destination already exists: ${newPath}`);
				await this.ensureFolder(DropboxMetadataCache.parentPath(newPath));
				return { id: entry.id, wasFolder: entry[".tag"] === "folder" };
			},
			execute: () => this.client.move(this.addr(oldPath), this.addr(newPath)),
			staleGuard: (r) => ({ path: oldPath, expectedId: r.id }),
			update: (r, result) => {
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
			if (this.cache.hasEntry(currentPath)) {
				throw new Error(`Cannot create directory "${path}": "${currentPath}" is a file`);
			}
			const folder = await this.client.createFolder(this.addr(currentPath));
			this.cache.setEntry(currentPath, folder);
		}
	}

	async close(): Promise<void> {
		await this.metadataStore?.close();
	}
}
