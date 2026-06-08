import type { IFileSystem } from "../interface";
import type { FileEntity } from "../types";
import { FOLDER_MIME, toRemoteChecksum } from "./types";
import type { DriveFile } from "./types";
import type { DriveClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import { DriveMetadataCache } from "./metadata-cache";
import { applyIncrementalChanges, commitDriveCache, CHANGES_CURSOR_KEY, snapshotPathsById, diffCacheByDriveId } from "./incremental-sync";
import { INTERNAL_METADATA_PATH } from "../../sync/remote-vault";
import { sha256 } from "../../utils/hash";
import { AsyncMutex } from "../../queue/async-queue";

import type { RenamePair } from "../../sync/types";

interface RemoteDelta {
	modified: string[];
	deleted: string[];
	renamed: RenamePair[];
}

/**
 * IFileSystem implementation backed by Google Drive.
 * Caches Drive file metadata (path↔ID, modifiedTime, size) to avoid
 * downloading file content during list()/stat(). Uses changes.list
 * for incremental sync after the initial full scan.
 */
export class GoogleDriveFs implements IFileSystem {
	readonly name = "googledrive";
	private client: DriveClient;
	private rootFolderId: string;
	private cache: DriveMetadataCache;

	private initialized = false;
	private cacheMutex = new AsyncMutex();
	private metadataStore?: MetadataStore<DriveFile>;
	private logger?: Logger;

	/** Latest changes start page token (for incremental sync) */
	private _changesPageToken: string | null = null;

	/**
	 * Cache changes not yet flushed to IndexedDB — persistence is deferred to the
	 * checkpoint commit ({@link commitCheckpoint}) so the persisted cache never runs
	 * ahead of the committed cursor (a crash would otherwise drop a deletion the
	 * replay can't re-detect). `pendingFullPersist` supersedes it after a full scan.
	 */
	private touchedPaths = new Set<string>();
	private pendingFullPersist = false;

	constructor(client: DriveClient, rootFolderId: string, logger?: Logger, metadataStore?: MetadataStore<DriveFile>) {
		this.client = client;
		this.rootFolderId = rootFolderId;
		this.logger = logger;
		this.metadataStore = metadataStore;
		this.cache = new DriveMetadataCache(rootFolderId, logger);
	}

	/** Get the current changes page token to persist between sessions */
	get changesPageToken(): string | null {
		return this._changesPageToken;
	}

	/** Set a previously saved changes page token for incremental sync */
	set changesPageToken(token: string | null) {
		this._changesPageToken = token;
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
			const currentId = this.cache.getFile(path)?.id;
			// Guard the phase-3 cache write against a concurrent delta that touched
			// this path while the network op (phase 2) ran:
			//  - expectedId set (operating on a known file): skip if the path now
			//    resolves to a different id — it was replaced/moved out from under us.
			//  - expectedId undefined (creating a NEW path): skip if the path is now
			//    occupied at all. A concurrent delta created it, and overwriting would
			//    drop that change; the in-memory cursor already advanced past it, so the
			//    next cycle re-detects our write — no data loss.
			const stale = expectedId === undefined ? currentId !== undefined : currentId !== expectedId;
			if (stale) {
				this.logger?.warn(`Skipping stale cache update for ${opts.operationName}`, { path });
				return;
			}
			opts.update(resolved, result);
		});
		return { resolved, result };
	}

	/** Full scan to build the metadata cache */
	private async fullScan(): Promise<void> {
		this.cache.clear();

		// Get starting page token BEFORE listing to not miss concurrent changes
		this._changesPageToken = await this.client.getChangesStartToken();

		const allFiles = await this.client.listAllFiles(this.rootFolderId);
		// A deleted/trashed remote root lists as empty (HTTP 200, not 404) — the same
		// shape as a genuinely empty folder. Trusting that blindly would make the cold
		// reconcile read "every synced file was remotely deleted" and plan a mass
		// delete_local (the volume-based abort guard was removed). Before accepting an
		// empty listing, confirm the root is still live: getFile throws (404) if it was
		// permanently deleted, and trashed===true means it was moved to Trash. Either way
		// abort this sync rather than nuking the local vault.
		if (allFiles.length === 0) {
			const root = await this.client.getFile(this.rootFolderId);
			if (root.trashed) {
				throw new Error(`Remote vault folder is in Trash (id: ${this.rootFolderId})`);
			}
		}
		this.cache.buildFromFiles(allFiles);

		this.initialized = true;
		// Whole cache rebuilt → flush it all at the next commit (not just touched paths).
		this.touchedPaths.clear();
		this.pendingFullPersist = true;
		this.logger?.info("Full scan completed", { fileCount: this.cache.size });
	}

	/**
	 * Ensure the metadata cache is initialized. Returns true when a prior checkpoint
	 * (file map + delta cursor) was restored from IndexedDB and warrants an
	 * incremental replay; false after a fresh full scan (the cursor was just
	 * acquired, so there is nothing newer to fetch yet).
	 */
	private async ensureInitialized(): Promise<boolean> {
		if (this.initialized) return true;
		if (await this.loadFromCache()) return true;
		await this.fullScan();
		return false;
	}

	/**
	 * Restore the file map AND the delta cursor from IndexedDB. They are committed
	 * together in one transaction (see commitDriveCache / ADR 0001), so the **cursor's
	 * presence** is the checkpoint signal — restore whenever it is present, even if the
	 * file map is empty (a vault that legitimately synced down to zero files is a valid
	 * checkpoint, and this keys identically to {@link hasCheckpoint}). No cursor means
	 * no usable checkpoint; the caller full-scans (losing the cursor is safe — a cold
	 * reconcile re-derives everything from the SyncRecord baseline).
	 */
	private async loadFromCache(): Promise<boolean> {
		if (!this.metadataStore) return false;
		try {
			await this.metadataStore.open();
			const { files, meta } = await this.metadataStore.loadAll();
			const cursor = meta.get(CHANGES_CURSOR_KEY);
			if (!cursor) return false;

			this.cache.clear();
			this.cache.bulkLoad(files.map((r) => [r.path, r.file]));
			this._changesPageToken = cursor;
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
	 * Flush the file map AND the delta cursor to IndexedDB, atomically, after a
	 * clean cycle. Because both commit in one transaction (see commitDriveCache /
	 * ADR 0001), the persisted cache can never run ahead of — nor behind — the
	 * committed cursor: a failed flush lands neither, and on the next run the replay
	 * re-detects any un-flushed work. The buffer is cleared only after success (a
	 * throw propagates and retains it for the next clean cycle's retry).
	 */
	async commitCheckpoint(): Promise<void> {
		const store = this.metadataStore;
		if (!store) return;
		await this.cacheMutex.run(async () => {
			await commitDriveCache(store, this.cache, this.touchedPaths, this.pendingFullPersist, this._changesPageToken);
			this.pendingFullPersist = false;
			this.touchedPaths.clear();
		});
	}

	/**
	 * Whether a committed delta checkpoint exists. The orchestrator uses this to
	 * force a cold reconcile when there is none (first sync, or after a rescan).
	 * Reads the in-memory cursor once initialized, otherwise peeks the IDB store —
	 * the cursor is co-located with the cache, so its presence is the checkpoint.
	 */
	async hasCheckpoint(): Promise<boolean> {
		if (this.initialized) return !!this._changesPageToken;
		if (!this.metadataStore) return false;
		try {
			await this.metadataStore.open();
			return !!(await this.metadataStore.getMeta(CHANGES_CURSOR_KEY));
		} catch {
			return false;
		}
	}

	/**
	 * Discard the committed checkpoint (cursor + cache) so the next sync cold-
	 * reconciles. Used by the Rescan action and an identity change. Losing the
	 * checkpoint is safe — a cold full list × SyncRecord baseline join re-derives
	 * every change (ADR 0001). Runs under `cacheMutex` (like every other mutator of
	 * the cache/cursor/buffer state) so it can't corrupt a concurrent op; the IDB
	 * clear runs first, so if it throws the in-memory state stays consistent with the
	 * (un-cleared) store rather than being half-wiped.
	 */
	async resetCheckpoint(): Promise<void> {
		await this.cacheMutex.run(async () => {
			if (this.metadataStore) {
				await this.metadataStore.open();
				await this.metadataStore.clear();
			}
			this._changesPageToken = null;
			this.cache.clear();
			this.initialized = false;
			this.touchedPaths.clear();
			this.pendingFullPersist = false;
		});
	}

	/** Apply incremental changes from the current cursor (caller ensured init + holds mutex). */
	private async _applyIncrementalChanges(): Promise<RemoteDelta | null> {
		if (!this._changesPageToken) return null;

		const result = await applyIncrementalChanges(
			{
				cache: this.cache,
				client: this.client,
				logger: this.logger,
			},
			this._changesPageToken,
		);

		if (result.needsFullScan) {
			// Cursor expired (410): snapshot-diff a fresh full scan for the delta.
			return this.fullScanWithDelta();
		}

		this._changesPageToken = result.newToken;
		// Buffer changed paths for the checkpoint commit (persisted only on a clean cycle).
		for (const path of result.changedPaths) this.touchedPaths.add(path);

		const modified: string[] = [];
		const deleted: string[] = [];
		for (const path of result.changedPaths) {
			// removeTree() was already called during applyIncrementalChanges(), so
			// deleted paths will correctly be absent from cache here. Edge case: if a
			// path was removed as a descendant of a deleted folder but a new file with
			// the same path was added in the same batch, it would be misclassified as
			// modified. This is unlikely in practice and does not cause data loss.
			if (this.cache.hasFile(path)) {
				modified.push(path);
			} else {
				deleted.push(path);
			}
		}
		return { modified, deleted, renamed: result.renamedPaths };
	}

	/**
	 * Full scan with delta computation (the 410 cursor-expiry fallback): snapshot
	 * old paths-by-id, perform a fresh full scan, then diff old vs new by Drive id
	 * (see diffCacheByDriveId). Returns null on the initial sync (no prior snapshot).
	 */
	private async fullScanWithDelta(): Promise<RemoteDelta | null> {
		// Snapshot before fullScan() overwrites the cache (only reached on 410, when
		// the cache is already populated).
		const oldPathById = snapshotPathsById(this.cache);
		await this.fullScan();
		if (oldPathById.size === 0) return null; // initial sync — no delta
		return diffCacheByDriveId(oldPathById, this.cache, this.logger);
	}

	/**
	 * Return paths changed since the last committed cursor. Returns null on the
	 * initial sync (a fresh full scan just captured "now", so there is no delta).
	 */
	async getChangedPaths(): Promise<{ modified: string[]; deleted: string[]; renamed?: { oldPath: string; newPath: string }[] } | null> {
		return this.cacheMutex.run(async () => {
			const replay = await this.ensureInitialized();
			return replay ? this._applyIncrementalChanges() : null;
		});
	}

	async list(): Promise<FileEntity[]> {
		return this.cacheMutex.run(async () => {
			// A fresh full scan captures "now"; a restored cursor warrants a replay.
			if (await this.ensureInitialized()) {
				await this._applyIncrementalChanges();
			}

			const entities: FileEntity[] = [];
			for (const [path, driveFile] of this.cache.entries()) {
				entities.push(this.cache.toEntity(path, driveFile));
			}
			return entities;
		});
	}

	/**
	 * Return cached metadata for a path.
	 * hash is always "" — the sync engine should use remoteChecksum
	 * for content-change detection rather than relying on hash.
	 *
	 * Does not call applyIncrementalChanges here because list() already
	 * applies incremental changes before returning the full file list.
	 * stat() is only called after list() has refreshed the cache.
	 */
	async stat(path: string): Promise<FileEntity | null> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();

			const driveFile = this.cache.getFile(path);
			if (!driveFile) return null;

			return this.cache.toEntity(path, driveFile);
		});
	}

	/**
	 * Download file content from Drive.
	 * Like stat(), does not call applyIncrementalChanges — the cache is
	 * kept fresh by list() which is always called first in the sync cycle.
	 */
	async read(path: string): Promise<ArrayBuffer> {
		// Phase 1: resolve fileId under mutex
		const fileId = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const driveFile = this.cache.getFile(path);
			if (!driveFile) {
				throw new Error(`File not found on Drive: ${path}`);
			}
			return driveFile.id;
		});

		// Phase 2: download outside mutex (network I/O)
		return this.client.downloadFile(fileId);
	}

	async write(
		path: string,
		content: ArrayBuffer,
		mtime: number
	): Promise<FileEntity> {
		if (path === INTERNAL_METADATA_PATH) {
			// The backend manages its metadata out-of-band; it must never be pushed
			// through the sync engine (the orchestrator excludes it too). Fail loudly
			// rather than fabricating a baseline for a file that never reached Drive.
			throw new Error(`Refusing to write reserved backend path: ${path}`);
		}
		const { result: driveFile } = await this.withCacheMutex({
			operationName: "write",
			resolve: async () => {
				const existingFile = this.cache.getFile(path);
				const existingId = existingFile?.id;
				const fileName = path.split("/").pop()!;
				const parentPath = path.substring(0, path.lastIndexOf("/"));
				const parentId = parentPath
					? await this.ensureFolder(parentPath)
					: this.rootFolderId;
				return { fileName, parentId, existingId };
			},
			execute: (r) => this.client.uploadFile(
				r.fileName, r.parentId, content, "application/octet-stream", r.existingId, mtime
			),
			staleGuard: (r) => ({ path, expectedId: r.existingId }),
			update: (_r, result) => { this.cache.setFile(path, result); },
		});

		const hash = await sha256(content);
		return {
			path,
			isDirectory: false,
			size: content.byteLength,
			mtime: driveFile.modifiedTime
				? new Date(driveFile.modifiedTime).getTime()
				: 0,
			hash,
			remoteChecksum: toRemoteChecksum(driveFile),
			backendMeta: { driveId: driveFile.id },
		};
	}

	async mkdir(path: string): Promise<FileEntity> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const folderId = await this.ensureFolder(path);
			return {
				path,
				isDirectory: true,
				size: 0,
				mtime: 0,
				hash: "",
				backendMeta: { driveId: folderId },
			};
		});
	}

	async listDir(path: string): Promise<FileEntity[]> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const kids = this.cache.getChildren(path);
			if (!kids) return [];
			const entities: FileEntity[] = [];
			for (const childPath of kids) {
				const driveFile = this.cache.getFile(childPath);
				if (driveFile) {
					entities.push(this.cache.toEntity(childPath, driveFile));
				}
			}
			return entities;
		});
	}

	async delete(path: string): Promise<void> {
		// Phase 1: resolve fileId under mutex
		const fileId = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const driveFile = this.cache.getFile(path);
			if (!driveFile) return null;
			return driveFile.id;
		});

		if (!fileId) return;

		// Phase 2: API delete outside mutex (network I/O)
		await this.client.deleteFile(fileId);

		// Phase 3: update cache under mutex with ID guard
		// (applyIncrementalChanges may have updated the cache during phase 2)
		await this.cacheMutex.run(() => {
			if (this.cache.getFile(path)?.id === fileId) {
				this.cache.removeTree(path);
			} else {
				this.logger?.warn("Skipping stale cache update for delete", { path });
			}
		});
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		await this.withCacheMutex({
			operationName: "rename",
			resolve: async () => {
				const driveFile = this.cache.getFile(oldPath);
				if (!driveFile)
					throw new Error(`File not found: ${oldPath}`);
				if (this.cache.hasFile(newPath))
					throw new Error(`Destination already exists: ${newPath}`);

				const oldName = oldPath.split("/").pop()!;
				const newName = newPath.split("/").pop()!;
				const oldParentPath = oldPath.substring(0, oldPath.lastIndexOf("/"));
				const newParentPath = newPath.substring(0, newPath.lastIndexOf("/"));

				const metadata: { name?: string } = {};
				if (oldName !== newName) metadata.name = newName;

				let addParents: string | undefined;
				let removeParents: string | undefined;
				if (oldParentPath !== newParentPath) {
					addParents = newParentPath
						? await this.ensureFolder(newParentPath)
						: this.rootFolderId;
					removeParents = (driveFile.parents && driveFile.parents.length > 0
						? this.cache.findRelevantParentId(driveFile.parents, { has: (id: string) => this.cache.hasId(id) })
						: undefined)
						?? (oldParentPath
							? this.cache.getFile(oldParentPath)?.id ?? this.rootFolderId
							: this.rootFolderId);
				}

				return {
					fileId: driveFile.id,
					metadata,
					addParents,
					removeParents,
					wasFolder: this.cache.isFolder(oldPath),
				};
			},
			execute: (r) => this.client.updateFileMetadata(
				r.fileId, r.metadata, r.addParents, r.removeParents
			),
			staleGuard: (r) => ({ path: oldPath, expectedId: r.fileId }),
			update: (r, result) => {
				// The shared stale-guard only validates the SOURCE (oldPath still resolves
				// to our file id). The destination is checked in resolve() (phase 1), but a
				// concurrent delta can land a DIFFERENT file at newPath during the phase-2
				// network op (run outside the mutex). Overwriting it via setFile would strand
				// that delta's id in idToPath (and orphan its subtree, since setFile only
				// re-indexes a NEW path). Skip instead — symmetric with write()'s new-path
				// guard; the in-memory cursor advanced past the delta, so the next cycle
				// re-detects our rename.
				const occupant = this.cache.getFile(newPath);
				if (occupant && occupant.id !== result.id) {
					this.logger?.warn("Skipping stale cache update for rename", { path: newPath });
					return;
				}
				this.cache.removeEntry(oldPath);
				this.cache.setFile(newPath, result);
				if (r.wasFolder) {
					this.cache.rewriteChildPaths(oldPath, newPath);
				}
			},
		});
	}

	/** Ensure a folder exists by path, creating parents as needed */
	private async ensureFolder(path: string): Promise<string> {
		const existing = this.cache.getFile(path);
		if (existing && this.cache.isFolder(path)) {
			return existing.id;
		}

		const parts = path.split("/");
		let currentPath = "";
		let parentId = this.rootFolderId;

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const cached = this.cache.getFile(currentPath);

			if (cached && this.cache.isFolder(currentPath)) {
				parentId = cached.id;
			} else if (cached) {
				throw new Error(`Cannot create directory "${path}": "${currentPath}" is a file`);
			} else {
				// Guard against Google Drive's same-name folder creation:
				// check Drive before creating a potentially duplicate folder
				const existing = await this.client.findChildByName(parentId, part, FOLDER_MIME);
				if (existing) {
					this.cache.setFile(currentPath, existing);
					parentId = existing.id;
				} else {
					const newFolder = await this.client.createFolder(
						part,
						parentId
					);
					this.cache.setFile(currentPath, newFolder);
					parentId = newFolder.id;
				}
			}
		}

		return parentId;
	}

	/** Close the metadata store (call on plugin unload) */
	async close(): Promise<void> {
		await this.metadataStore?.close();
	}
}
