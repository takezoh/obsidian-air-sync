import type { FileEntity } from "../types";
import type { IdentityAddressedRename } from "../interface";
import { FOLDER_MIME, toRemoteChecksum } from "./types";
import type { GoogleDriveFile } from "./types";
import type { GoogleDriveClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import { GoogleDriveMetadataCache } from "./metadata-cache";
import { applyIncrementalChanges } from "./incremental-sync";
import { INTERNAL_METADATA_PATH } from "../remote-vault-contract";
import { sha256 } from "../../utils/hash";
import { normalizeSyncPath, validateRename } from "../../utils/path";
import { CachingRemoteFs } from "../caching/remote-fs";
import type { IncrementalChangesResult } from "../caching/remote-fs";
import { resolveDetachedIdPath } from "../priority-observation";
import { inspectGoogleDriveFolder } from "./folder-usability";
import { isGoogleDriveTrashed } from "./types";

/**
 * IFileSystem implementation backed by Google Drive.
 *
 * The crash-safe cache/checkpoint machinery lives in {@link CachingRemoteFs}; this
 * subclass supplies the Google Drive-specific seams (changes.list delta, listAllFiles,
 * download/delete by id, root-liveness) and the mutating ops (write/mkdir/rename),
 * whose Google Drive API calls and multi-parent handling are backend-specific.
 */
export class GoogleDriveFs extends CachingRemoteFs<GoogleDriveFile> {
	readonly name = "googledrive";
	private client: GoogleDriveClient;

	constructor(client: GoogleDriveClient, rootFolderId: string, logger?: Logger, metadataStore?: MetadataStore<GoogleDriveFile>) {
		super(rootFolderId, new GoogleDriveMetadataCache(rootFolderId, logger), metadataStore, logger);
		this.client = client;
	}

	// ── Google Drive-specific seams ──

	protected getStartCursor(): Promise<string> {
		return this.client.getChangesStartToken();
	}

	protected fullList(): Promise<GoogleDriveFile[]> {
		return this.client.listAllFiles(this.rootFolderId);
	}

	protected async assertRootAlive(): Promise<void> {
		// A deleted/trashed remote root lists as empty (HTTP 200, not 404) — the same
		// shape as a genuinely empty folder. Confirm the root is still live before
		// accepting an empty listing: getFile throws (404) if it was permanently
		// deleted, and trashed===true means it was moved to Trash. Either way abort
		// this sync rather than nuking the local vault (the volume-based abort guard
		// was removed in favour of this root-liveness check). The classification is
		// the same shared seam every binding path uses.
		const inspection = await inspectGoogleDriveFolder(this.client, this.rootFolderId);
		if (inspection.usable) return;
		switch (inspection.problem) {
			case "trashed":
				throw new Error(`Remote vault folder is in Trash (id: ${this.rootFolderId})`);
			case "not_found":
			case "inaccessible":
				// Preserve the original error (status intact) so error classification and
				// the cold-reconcile abort behave exactly as before.
				throw inspection.cause;
			case "not_folder":
				// A file at the bound id lists as empty, so without this the cold
				// reconcile would read it as a genuinely empty remote and mass-delete the
				// local vault.
				throw new Error(`Remote vault folder is not a folder (id: ${this.rootFolderId})`);
			default: {
				const exhaustive: never = inspection;
				throw new Error(
					`Remote vault folder is unusable (id: ${this.rootFolderId}): ${String(exhaustive)}`,
				);
			}
		}
	}

	protected fetchChanges(cursor: string): Promise<IncrementalChangesResult> {
		return applyIncrementalChanges(
			{ cache: this.cache, client: this.client, logger: this.logger },
			cursor,
		);
	}

	protected async fetchCurrentFile(fileId: string): Promise<GoogleDriveFile | null> {
		try {
			const file = await this.client.getFile(fileId);
			return isGoogleDriveTrashed(file) ? null : file;
		} catch (err) {
			if (err && typeof err === "object" && "status" in err && err.status === 404) return null;
			throw err;
		}
	}

	protected async fetchCurrentPath(path: string): Promise<GoogleDriveFile[]> {
		let parentId = this.rootFolderId;
		const segments = path.split("/");
		for (const [index, segment] of segments.entries()) {
			const candidates = await this.client.listChildrenByName(parentId, segment);
			if (candidates.length !== 1 || index === segments.length - 1) return candidates;
			const parent = candidates[0]!;
			if (parent.mimeType !== FOLDER_MIME) return [];
			parentId = parent.id;
		}
		return [];
	}

	protected resolveDetachedPath(file: GoogleDriveFile): Promise<string | null> {
		return resolveDetachedIdPath(file, this.rootFolderId, (id) => this.fetchCurrentFile(id), {
			id: (entry) => entry.id,
			name: (entry) => entry.name,
			parents: (entry) => entry.parents,
			isFolder: (entry) => entry.mimeType === FOLDER_MIME,
		});
	}

	protected toDetachedEntity(path: string, file: GoogleDriveFile): FileEntity {
		return {
			path, pathAuthority: "actual_resolved", identityKey: file.id,
			isDirectory: file.mimeType === FOLDER_MIME,
			size: file.mimeType === FOLDER_MIME ? 0 : Number(file.size ?? 0),
			mtime: file.modifiedTime ? Date.parse(file.modifiedTime) || 0 : 0,
			hash: "", remoteChecksum: toRemoteChecksum(file),
			backendMeta: { googleDriveId: file.id, version: file.version },
		};
	}

	protected detachedVersionToken(file: GoogleDriveFile): string | null {
		if (file.mimeType === FOLDER_MIME) return null;
		if (!file.md5Checksum || !file.size || !/^\d+$/.test(file.size)) return null;
		return `googledrive:md5:${file.md5Checksum}:${file.size}`;
	}

	protected downloadFile(fileId: string): Promise<ArrayBuffer> {
		return this.client.downloadFile(fileId);
	}

	protected deleteRemote(fileId: string): Promise<void> {
		return this.client.deleteFile(fileId);
	}

	// ── Mutating ops (Google Drive API + multi-parent handling) ──

	async write(
		path: string,
		content: ArrayBuffer,
		mtime: number
	): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		if (path === INTERNAL_METADATA_PATH) {
			// The backend manages its metadata out-of-band; it must never be pushed
			// through the sync engine (the orchestrator excludes it too). Fail loudly
			// rather than fabricating a baseline for a file that never reached Google Drive.
			throw new Error(`Refusing to write reserved backend path: ${path}`);
		}
		const { result: googleDriveFile } = await this.withCacheMutex({
			operationName: "write",
			resolve: async () => {
				const fileName = path.split("/").pop()!;
				const parentPath = path.substring(0, path.lastIndexOf("/"));
				const parentId = parentPath
					? await this.ensureFolder(parentPath)
					: this.rootFolderId;
				const actualParent = parentId === this.rootFolderId
					? ""
					: this.cache.getPathById(parentId);
				if (actualParent === undefined) {
					throw new Error(`Cannot resolve provider parent for "${path}"`);
				}
				const targetPath = actualParent ? `${actualParent}/${fileName}` : fileName;
				if (this.cache.isFolder(targetPath)) {
					throw new Error(`Cannot write file: "${targetPath}" is an existing directory`);
				}
				const existingId = this.cache.idAt(targetPath);
				return { fileName, parentId, existingId, targetPath };
			},
			execute: (r) => this.client.uploadFile(
				r.fileName, r.parentId, content, "application/octet-stream", r.existingId, mtime
			),
			staleGuard: (r) => ({ path: r.targetPath, expectedId: r.existingId }),
			update: (r, result) => {
				if (!this.cache.applyFileChange(result)) {
					this.cache.setFile(r.targetPath, result, "requested_echo");
				}
			},
		});

		const hash = await sha256(content);
		return {
			path,
			pathAuthority: "requested_echo",
			identityKey: googleDriveFile.id,
			isDirectory: false,
			size: content.byteLength,
			mtime: googleDriveFile.modifiedTime
				? new Date(googleDriveFile.modifiedTime).getTime()
				: 0,
			hash,
			remoteChecksum: toRemoteChecksum(googleDriveFile),
			backendMeta: { googleDriveId: googleDriveFile.id, version: googleDriveFile.version },
		};
	}

	async mkdir(path: string): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const folderId = await this.ensureFolder(path);
			return {
				path,
				pathAuthority: "requested_echo",
				identityKey: folderId,
				isDirectory: true,
				size: 0,
				mtime: 0,
				hash: "",
				backendMeta: { googleDriveId: folderId },
			};
		});
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		oldPath = normalizeSyncPath(oldPath);
		newPath = normalizeSyncPath(newPath);
		validateRename(oldPath, newPath);
		await this.withCacheMutex({
			operationName: "rename",
			resolve: async () => {
				const googleDriveFile = this.cache.getFile(oldPath);
				if (!googleDriveFile)
					throw new Error(`File not found: ${oldPath}`);
				if (this.cache.hasFile(newPath))
					throw new Error(`Destination already exists: ${newPath}`);

				const oldName = oldPath.split("/").pop()!;
				const newName = newPath.split("/").pop()!;
				const oldParentPath = oldPath.substring(0, oldPath.lastIndexOf("/"));
				const newParentPath = newPath.substring(0, newPath.lastIndexOf("/"));

				const metadata: { name?: string } = {};
				if (oldName !== newName) metadata.name = newName;

				const addParents = oldParentPath === newParentPath ? undefined
					: newParentPath ? await this.ensureFolder(newParentPath) : this.rootFolderId;
				// A vault folder several Drive folders make up moves as one: every one of
				// them is renamed, each out of its own parent.
				const subjects = this.cache.isFolder(oldPath) ? this.cache.foldersAt(oldPath) : [googleDriveFile];
				const moves = subjects.map((subject) => ({
					fileId: subject.id,
					removeParents: addParents === undefined ? undefined
						: (subject.parents && subject.parents.length > 0
							? this.cache.findRelevantParentId(subject.parents, { has: (id: string) => this.cache.hasId(id) })
							: undefined)
							?? (oldParentPath
								? this.cache.getFile(oldParentPath)?.id ?? this.rootFolderId
								: this.rootFolderId),
				}));

				return {
					fileId: googleDriveFile.id,
					metadata,
					addParents,
					moves,
					wasFolder: this.cache.isFolder(oldPath),
				};
			},
			execute: async (r) => {
				const results = [];
				for (const move of r.moves) {
					results.push(await this.client.updateFileMetadata(
						move.fileId, r.metadata, r.addParents, move.removeParents,
					));
				}
				return results;
			},
			staleGuard: (r) => ({ path: oldPath, expectedId: r.fileId }),
			update: (r, results) => {
				// The shared stale-guard only validates the SOURCE (oldPath still resolves
				// to our file id). The destination is checked in resolve() (phase 1), but a
				// concurrent re-keyer could land a DIFFERENT file at newPath during the
				// phase-2 network op (run outside the mutex). Overwriting it via setFile
				// would strand that id in idToPath (and orphan its subtree, since setFile
				// only re-indexes a NEW path). Skip instead — symmetric with write()'s
				// new-path guard; the in-memory cursor advanced past it, so the next cycle
				// re-detects our rename. Like the shared guard, this is currently
				// unreachable (ADR 0001, T7: rename_remote runs serially in the structural
				// phase, and deltas never run during execute) — retained as defense-in-depth.
				const occupant = this.cache.getFile(newPath);
				if (occupant && !results.some((result) => result.id === occupant.id)) {
					this.logger?.warn("Skipping stale cache update for rename", { path: newPath });
					return;
				}
				this.cache.removeEntry(oldPath);
				for (const result of results) {
					if (!this.cache.applyFileChange(result)) {
						// A successful rename operation itself confirms its requested endpoint
						// when a sparse provider response omits parent-chain fields.
						this.cache.setFile(newPath, result, "actual_resolved");
					}
				}
				if (r.wasFolder) {
					this.cache.rewriteChildPaths(oldPath, newPath);
				}
			},
		});
	}

	/**
	 * Identity-addressed rename (see {@link IdentityAddressedRename}). Google Drive
	 * is the only backend that implements it, because it is the only one whose
	 * namespace can hold two live objects at one derived address.
	 *
	 * The subject is addressed by its Drive file id, so it works for an object the
	 * cache is deliberately not holding — which is the whole point. Nothing is
	 * written to the cache in advance: the `update` phase applies the file Drive
	 * returns, with provider authority, and writes nothing at all if Drive's answer
	 * does not resolve to a cache path.
	 */
	readonly identityRename: IdentityAddressedRename = {
		renameById: (identityKey, newPath) => this.renameById(identityKey, newPath),
	};

	private async renameById(identityKey: string, newPath: string): Promise<void> {
		const target = normalizeSyncPath(newPath);
		const newName = target.split("/").pop() ?? "";
		if (!identityKey || newName === "" || newName === "." || newName === "..") {
			throw new Error(`Invalid identity-addressed rename target: "${newPath}"`);
		}
		await this.withCacheMutex({
			operationName: "renameById",
			// Nothing is resolved through the cache: the id IS the address.
			resolve: () => ({ identityKey, newName, target }),
			execute: (r) => this.client.updateFileMetadata(r.identityKey, { name: r.newName }),
			// The subject has no cache path, so the only thing a concurrent writer
			// could have taken is the destination. `expectedId: undefined` skips the
			// cache write when the target address is occupied by then.
			staleGuard: (r) => ({ path: r.target, expectedId: undefined }),
			update: (_r, result) => {
				this.cache.applyFileChange(result);
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
			const requestedPath = currentPath ? `${currentPath}/${part}` : part;
			const matchingPaths = [...(this.cache.getChildren(currentPath) ?? [])].filter((candidate) => {
				const file = this.cache.getFile(candidate);
				return file?.name.toLowerCase() === part.toLowerCase();
			});
			if (matchingPaths.length > 1) {
				throw new Error(`Ambiguous provider folder for "${requestedPath}"`);
			}
			const cachedPath = matchingPaths[0] ?? requestedPath;
			const cached = this.cache.getFile(cachedPath);

			if (cached && this.cache.isFolder(cachedPath)) {
				parentId = cached.id;
			} else if (cached) {
				throw new Error(`Cannot create directory "${path}": "${cachedPath}" is a file`);
			} else {
				// Guard against Google Drive's same-name folder creation:
				// check Google Drive before creating a potentially duplicate folder
				const candidates = await this.client.listChildrenByName(parentId, part);
				// Same-named FOLDERS are one vault folder, so finding several is not an
				// ambiguity: they are all seated, and the representative — the smallest
				// id, as the cache chooses it — is where new content goes.
				const folders = candidates.filter((candidate) => candidate.mimeType === FOLDER_MIME)
					.sort((a, b) => (a.id < b.id ? -1 : 1));
				if (candidates.length > 1 && folders.length !== candidates.length) {
					throw new Error(`Ambiguous provider entry for "${requestedPath}"`);
				}
				const existing = folders[0] ?? candidates[0];
				if (existing?.mimeType === FOLDER_MIME) {
					for (const folder of folders) {
						// Only the representative may fall back to the requested spelling: an
						// echo never merges, so a second one would evict the first.
						if (!this.cache.applyFileChange(folder) && folder === existing) {
							this.cache.setFile(requestedPath, folder, "requested_echo");
						}
					}
					parentId = existing.id;
				} else if (existing) {
					throw new Error(`Cannot create directory "${path}": "${requestedPath}" is a file`);
				} else {
					const newFolder = await this.client.createFolder(
						part,
						parentId
					);
					if (!this.cache.applyFileChange(newFolder)) {
						this.cache.setFile(requestedPath, newFolder, "requested_echo");
					}
					parentId = newFolder.id;
				}
			}
			const resolved = this.cache.getPathById(parentId);
			if (!resolved) throw new Error(`Cannot resolve provider folder for "${requestedPath}"`);
			currentPath = resolved;
		}

		return parentId;
	}
}
