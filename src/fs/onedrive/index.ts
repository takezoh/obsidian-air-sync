import type { FileEntity } from "../types";
import { toRemoteChecksum, itemMtime, GraphApiError } from "./types";
import type { OneDriveItem } from "./types";
import type { OneDriveClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import { OneDriveMetadataCache } from "./metadata-cache";
import { applyOneDriveDelta } from "./incremental-sync";
import { INTERNAL_METADATA_PATH } from "../remote-vault-contract";
import { sha256 } from "../../utils/hash";
import { normalizeSyncPath, validateRename } from "../../utils/path";
import { CachingRemoteFs } from "../caching/remote-fs";
import type { IncrementalChangesResult } from "../caching/remote-fs";

/**
 * IFileSystem implementation backed by OneDrive (Microsoft Graph, App Folder scope).
 *
 * The crash-safe cache/checkpoint machinery (ADR 0001) lives in
 * {@link CachingRemoteFs}; this subclass supplies the OneDrive-specific seams
 * (the `/delta` cursor, full enumeration, download/delete by id, root-liveness) and
 * the mutating ops (write/mkdir/rename). Items are addressed by their stable
 * driveItem id, exactly like Google Drive — a remote move/rename of the vault
 * folder needs no migration because the id is the binding.
 */
export class OneDriveFs extends CachingRemoteFs<OneDriveItem> {
	readonly name = "onedrive";
	private client: OneDriveClient;

	constructor(client: OneDriveClient, rootFolderId: string, logger?: Logger, metadataStore?: MetadataStore<OneDriveItem>) {
		super(rootFolderId, new OneDriveMetadataCache(rootFolderId, logger), metadataStore, logger);
		this.client = client;
	}

	// ── OneDrive-specific seams ──

	protected getStartCursor(): Promise<string> {
		return this.client.getStartCursor(this.rootFolderId);
	}

	protected fullList(): Promise<OneDriveItem[]> {
		return this.client.fullList(this.rootFolderId);
	}

	protected async assertRootAlive(): Promise<void> {
		// An empty full enumeration is ambiguous (genuinely empty vault vs deleted
		// root), so confirm the root still exists before the base reconciles an empty
		// list — otherwise a cold reconcile would read every file as remotely deleted
		// and plan a mass delete_local. A deleted/recycled folder makes getItem 404
		// (→ GraphApiError); translate that to the descriptive message. (Graph's
		// `deleted` facet only appears on /delta tombstones, never on a direct item
		// GET, so there is nothing to inspect on a successful response.)
		try {
			await this.client.getItem(this.rootFolderId);
		} catch (err) {
			if (err instanceof GraphApiError && err.status === 404) {
				throw new Error(`Remote vault folder was deleted (id: ${this.rootFolderId})`);
			}
			throw err;
		}
	}

	protected fetchChanges(cursor: string): Promise<IncrementalChangesResult> {
		return applyOneDriveDelta(
			{ cache: this.cache, client: this.client, rootId: this.rootFolderId, logger: this.logger },
			cursor,
		);
	}

	protected downloadFile(fileId: string): Promise<ArrayBuffer> {
		return this.client.download(fileId);
	}

	protected deleteRemote(fileId: string): Promise<void> {
		return this.client.deleteItem(fileId);
	}

	// ── Mutating ops (Graph API; addressed by id) ──

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		if (path === INTERNAL_METADATA_PATH) {
			throw new Error(`Refusing to write reserved backend path: ${path}`);
		}
		const { result: item } = await this.withCacheMutex({
			operationName: "write",
			resolve: async () => {
				if (this.cache.isFolder(path)) {
					throw new Error(`Cannot write file: "${path}" is an existing directory`);
				}
				const existingId = this.cache.idAt(path);
				const fileName = path.split("/").pop()!;
				const parentPath = OneDriveMetadataCache.parentPath(path);
				const parentId = parentPath ? await this.ensureFolder(parentPath) : this.rootFolderId;
				return { fileName, parentId, existingId };
			},
			execute: (r) => this.client.upload(r.parentId, r.fileName, content, mtime),
			staleGuard: (r) => ({ path, expectedId: r.existingId }),
			update: (_r, result) => { this.cache.setFile(path, result); },
		});

		const hash = await sha256(content);
		return {
			path,
			isDirectory: false,
			size: content.byteLength,
			mtime: itemMtime(item),
			hash,
			remoteChecksum: toRemoteChecksum(item),
			backendMeta: { oneDriveId: item.id },
		};
	}

	async mkdir(path: string): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const folderId = await this.ensureFolder(path);
			return { path, isDirectory: true, size: 0, mtime: 0, hash: "", backendMeta: { oneDriveId: folderId } };
		});
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		oldPath = normalizeSyncPath(oldPath);
		newPath = normalizeSyncPath(newPath);
		validateRename(oldPath, newPath);
		await this.withCacheMutex({
			operationName: "rename",
			resolve: async () => {
				const item = this.cache.getFile(oldPath);
				if (!item) throw new Error(`File not found: ${oldPath}`);
				if (this.cache.hasFile(newPath)) throw new Error(`Destination already exists: ${newPath}`);

				const oldName = oldPath.split("/").pop()!;
				const newName = newPath.split("/").pop()!;
				const oldParentPath = OneDriveMetadataCache.parentPath(oldPath);
				const newParentPath = OneDriveMetadataCache.parentPath(newPath);

				const name = oldName !== newName ? newName : undefined;
				let newParentId: string | undefined;
				if (oldParentPath !== newParentPath) {
					newParentId = newParentPath ? await this.ensureFolder(newParentPath) : this.rootFolderId;
				}
				return { id: item.id, name, newParentId, wasFolder: this.cache.isFolder(oldPath) };
			},
			execute: (r) => this.client.move(r.id, r.name, r.newParentId),
			staleGuard: (r) => ({ path: oldPath, expectedId: r.id }),
			update: (r, result) => {
				// Mirror GoogleDriveFs.rename: the shared stale-guard validates only the
				// SOURCE; skip if a concurrent op landed a different item at newPath during
				// the phase-2 network call (currently unreachable per ADR 0001 — kept as
				// defense-in-depth).
				const occupant = this.cache.getFile(newPath);
				if (occupant && occupant.id !== result.id) {
					this.logger?.warn("Skipping stale cache update for rename", { path: newPath });
					return;
				}
				this.cache.removeEntry(oldPath);
				this.cache.setFile(newPath, result);
				if (r.wasFolder) this.cache.rewriteChildPaths(oldPath, newPath);
			},
		});
	}

	/** Ensure a folder exists by path, creating parents as needed. Returns its id. */
	private async ensureFolder(path: string): Promise<string> {
		const existing = this.cache.getFile(path);
		if (existing && this.cache.isFolder(path)) return existing.id;

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
				const folder = await this.client.createFolder(parentId, part);
				this.cache.setFile(currentPath, folder);
				parentId = folder.id;
			}
		}
		return parentId;
	}
}
