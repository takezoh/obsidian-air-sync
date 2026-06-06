import type { IFileSystem } from "../interface";
import type { FileEntity } from "../types";
import type { PCloudEntry } from "./types";
import { parsePCloudTime } from "./types";
import type { PCloudClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import type { RenamePair } from "../../sync/types";
import { PCloudMetadataCache } from "./metadata-cache";
import {
	applyPCloudDiff,
	classifyChangedPaths,
	computeFullScanDelta,
	type RemoteDelta,
} from "./incremental-sync";
import { INTERNAL_METADATA_PATH } from "../../sync/remote-vault";
import { sha256 } from "../../utils/hash";
import { validateRename } from "../../utils/path";
import { AsyncMutex } from "../../queue/async-queue";

/** A file's pCloud numeric id ("fileid"/"folderid"), used for API addressing. */
function numericIdOf(entry: PCloudEntry): string {
	return String(entry.isfolder ? entry.folderid : entry.fileid);
}

/**
 * IFileSystem implementation backed by pCloud.
 *
 * Caches pCloud metadata (path↔id, modified, size, content hash) so list()/stat()
 * never download content. After the initial recursive listfolder it tracks remote
 * changes incrementally via the account-wide `diff` feed.
 */
export class PCloudFs implements IFileSystem {
	readonly name = "pcloud";
	private cache: PCloudMetadataCache;
	private initialized = false;
	private cacheMutex = new AsyncMutex();

	/** Latest diff cursor (for incremental sync). */
	private _diffId: string | null = null;

	constructor(
		private client: PCloudClient,
		private rootFolderId: string,
		private logger?: Logger,
		private metadataStore?: MetadataStore<PCloudEntry>,
	) {
		this.cache = new PCloudMetadataCache(rootFolderId, logger);
	}

	get diffId(): string | null {
		return this._diffId;
	}

	set diffId(id: string | null) {
		this._diffId = id;
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

	/** Full scan: capture the diff baseline BEFORE listing to not miss changes. */
	private async fullScan(): Promise<void> {
		this.cache.clear();
		this._diffId = await this.client.getDiffBaseline();
		const root = await this.client.listFolder(this.rootFolderId, true);
		this.cache.buildFromListFolder(root);
		this.initialized = true;
		this.logger?.info("Full scan completed", { fileCount: this.cache.size });
		void this.persistCache();
	}

	/**
	 * Ensure the cache is initialized. Returns true when the cursor is a prior
	 * checkpoint warranting an incremental replay; false after a fresh full scan.
	 */
	private async ensureInitialized(): Promise<boolean> {
		if (this.initialized) return true;
		if (this._diffId) {
			if (await this.loadFromCache()) return true;
			const keep = this._diffId;
			await this.fullScan();
			this._diffId = keep;
			return true;
		}
		await this.fullScan();
		return false;
	}

	/** Restore the file map from IndexedDB, or false to trigger a full scan. */
	private async loadFromCache(): Promise<boolean> {
		if (!this.metadataStore || !this._diffId) return false;
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

	/** Persist the file map. The diff cursor is committed via backendData, not here. */
	private async persistCache(): Promise<void> {
		if (!this.metadataStore) return;
		try {
			await this.metadataStore.open();
			await this.metadataStore.saveAll(this.cache.exportRecords(), new Map());
		} catch (err) {
			this.logger?.warn("Failed to persist cache to IndexedDB", {
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/** Apply diff from the current cursor (caller ensured init + holds mutex). */
	private async applyDiff(): Promise<RemoteDelta | null> {
		if (!this._diffId) return null;
		const result = await applyPCloudDiff(
			{ cache: this.cache, client: this.client, metadataStore: this.metadataStore, logger: this.logger },
			this._diffId,
		);
		if (result.needsFullScan) return this.fullScanWithDelta();
		this._diffId = result.newDiffId;
		return classifyChangedPaths(this.cache, result.changedPaths, result.renamedPaths);
	}

	/** On a lost cursor (reset/expiry): snapshot-diff a fresh full scan. */
	private async fullScanWithDelta(): Promise<RemoteDelta | null> {
		const oldPathById = new Map<string, string>();
		for (const [path, entry] of this.cache.entries()) oldPathById.set(entry.id, path);
		await this.fullScan();
		return computeFullScanDelta(oldPathById, this.cache);
	}

	async getChangedPaths(): Promise<{ modified: string[]; deleted: string[]; renamed?: RenamePair[] } | null> {
		return this.cacheMutex.run(async () => {
			const replay = await this.ensureInitialized();
			return replay ? this.applyDiff() : null;
		});
	}

	async list(): Promise<FileEntity[]> {
		return this.cacheMutex.run(async () => {
			if (await this.ensureInitialized()) await this.applyDiff();
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
		const fileId = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const entry = this.cache.getEntry(path);
			if (!entry || entry.isfolder) throw new Error(`File not found on pCloud: ${path}`);
			return numericIdOf(entry);
		});
		return this.client.downloadFile(fileId);
	}

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		if (path === INTERNAL_METADATA_PATH) {
			throw new Error(`Refusing to write reserved backend path: ${path}`);
		}
		const { result: entry } = await this.withCacheMutex({
			operationName: "write",
			resolve: async () => {
				const existing = this.cache.getEntry(path);
				const fileName = path.split("/").pop()!;
				const parentPath = path.substring(0, path.lastIndexOf("/"));
				const parentId = parentPath ? await this.ensureFolder(parentPath) : this.rootFolderId;
				return { fileName, parentId, existingId: existing?.id };
			},
			execute: (r) => this.client.uploadFile(r.parentId, r.fileName, content, mtime),
			staleGuard: (r) => ({ path, expectedId: r.existingId }),
			update: (_r, result) => { this.cache.setEntry(path, result); },
		});

		const hash = await sha256(content);
		return {
			path,
			isDirectory: false,
			size: content.byteLength,
			mtime: parsePCloudTime(entry.modified),
			hash,
			remoteChecksum: entry.hash != null ? { algo: "opaque", value: String(entry.hash) } : undefined,
			backendMeta: { pcloudId: entry.id },
		};
	}

	async mkdir(path: string): Promise<FileEntity> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const folderId = await this.ensureFolder(path);
			return { path, isDirectory: true, size: 0, mtime: 0, hash: "", backendMeta: { pcloudId: "d" + folderId } };
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
			return entry ? { id: entry.id, isFolder: entry.isfolder, numericId: numericIdOf(entry) } : null;
		});
		if (!target) return;

		if (target.isFolder) await this.client.deleteFolderRecursive(target.numericId);
		else await this.client.deleteFile(target.numericId);

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

				const oldName = oldPath.split("/").pop()!;
				const newName = newPath.split("/").pop()!;
				const oldParent = PCloudMetadataCache.parentPath(oldPath);
				const newParent = PCloudMetadataCache.parentPath(newPath);

				let toFolderId: string | undefined;
				if (oldParent !== newParent) {
					toFolderId = newParent ? await this.ensureFolder(newParent) : this.rootFolderId;
				}
				return {
					id: entry.id,
					numericId: numericIdOf(entry),
					wasFolder: entry.isfolder,
					toName: oldName !== newName ? newName : undefined,
					toFolderId,
				};
			},
			execute: (r) => r.wasFolder
				? this.client.renameFolder(r.numericId, r.toName, r.toFolderId)
				: this.client.renameFile(r.numericId, r.toName, r.toFolderId),
			staleGuard: (r) => ({ path: oldPath, expectedId: r.id }),
			update: (r, result) => {
				this.cache.removeEntry(oldPath);
				this.cache.setEntry(newPath, result);
				if (r.wasFolder) this.cache.rewriteChildPaths(oldPath, newPath);
			},
		});
	}

	/** Ensure a folder exists by path, creating parents as needed (idempotent). */
	private async ensureFolder(path: string): Promise<string> {
		const existing = this.cache.getEntry(path);
		if (existing && this.cache.isFolder(path)) return String(existing.folderid);

		const parts = path.split("/");
		let currentPath = "";
		let parentId = this.rootFolderId;
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const cached = this.cache.getEntry(currentPath);
			if (cached && this.cache.isFolder(currentPath)) {
				parentId = String(cached.folderid);
			} else if (cached) {
				throw new Error(`Cannot create directory "${path}": "${currentPath}" is a file`);
			} else {
				const folder = await this.client.createFolderIfNotExists(parentId, part);
				this.cache.setEntry(currentPath, folder);
				parentId = String(folder.folderid);
			}
		}
		return parentId;
	}

	async close(): Promise<void> {
		await this.metadataStore?.close();
	}
}
