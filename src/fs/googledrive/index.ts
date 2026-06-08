import type { FileEntity } from "../types";
import { FOLDER_MIME, toRemoteChecksum } from "./types";
import type { DriveFile } from "./types";
import type { DriveClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import { DriveMetadataCache } from "./metadata-cache";
import { applyIncrementalChanges } from "./incremental-sync";
import { INTERNAL_METADATA_PATH } from "../remote-vault-contract";
import { sha256 } from "../../utils/hash";
import { CachingRemoteFs } from "../caching/remote-fs";
import type { IncrementalChangesResult } from "../caching/remote-fs";

/**
 * IFileSystem implementation backed by Google Drive.
 *
 * The crash-safe cache/checkpoint machinery lives in {@link CachingRemoteFs}; this
 * subclass supplies the Drive-specific seams (changes.list delta, listAllFiles,
 * download/delete by id, root-liveness) and the mutating ops (write/mkdir/rename),
 * whose Drive API calls and multi-parent handling are backend-specific.
 */
export class GoogleDriveFs extends CachingRemoteFs<DriveFile> {
	readonly name = "googledrive";
	private client: DriveClient;

	constructor(client: DriveClient, rootFolderId: string, logger?: Logger, metadataStore?: MetadataStore<DriveFile>) {
		super(rootFolderId, new DriveMetadataCache(rootFolderId, logger), metadataStore, logger);
		this.client = client;
	}

	// ── Drive-specific seams ──

	protected getStartCursor(): Promise<string> {
		return this.client.getChangesStartToken();
	}

	protected fullList(): Promise<DriveFile[]> {
		return this.client.listAllFiles(this.rootFolderId);
	}

	protected async assertRootAlive(): Promise<void> {
		// A deleted/trashed remote root lists as empty (HTTP 200, not 404) — the same
		// shape as a genuinely empty folder. Confirm the root is still live before
		// accepting an empty listing: getFile throws (404) if it was permanently
		// deleted, and trashed===true means it was moved to Trash. Either way abort
		// this sync rather than nuking the local vault (the volume-based abort guard
		// was removed in favour of this root-liveness check).
		const root = await this.client.getFile(this.rootFolderId);
		if (root.trashed) {
			throw new Error(`Remote vault folder is in Trash (id: ${this.rootFolderId})`);
		}
	}

	protected fetchChanges(cursor: string): Promise<IncrementalChangesResult> {
		return applyIncrementalChanges(
			{ cache: this.cache, client: this.client, logger: this.logger },
			cursor,
		);
	}

	protected downloadFile(fileId: string): Promise<ArrayBuffer> {
		return this.client.downloadFile(fileId);
	}

	protected deleteRemote(fileId: string): Promise<void> {
		return this.client.deleteFile(fileId);
	}

	// ── Mutating ops (Drive API + multi-parent handling) ──

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
}
