import type { FileEntity } from "../types";
import type { DropboxEntry } from "./types";
import { DropboxApiError, parseDropboxTime } from "./types";
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

function isCaseOnlyRename(oldPath: string, newPath: string): boolean {
	return oldPath !== newPath && oldPath.toLowerCase() === newPath.toLowerCase();
}

/** Deterministic only to make collision checks stable within one invocation. */
function caseRenameTempPath(path: string, identity: string): string {
	let hash = 0x811c9dc5;
	for (const char of identity) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	const parent = DropboxMetadataCache.parentPath(path);
	const name = `.airsync-case-rename-${(hash >>> 0).toString(16).padStart(8, "0")}`;
	return parent ? `${parent}/${name}` : name;
}

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

	protected async fetchCurrentFile(fileId: string): Promise<DropboxEntry | null> {
		return this.getOptionalMetadata(fileId);
	}

	protected async fetchCurrentPath(path: string): Promise<DropboxEntry[]> {
		const entry = await this.getOptionalMetadata(this.addr(path));
		return entry ? [entry] : [];
	}

	protected async resolveDetachedPath(file: DropboxEntry): Promise<string | null> {
		const root = await this.getOptionalMetadata(this.rootFolderId);
		if (!root?.id || root.id !== this.rootFolderId || !root.path_display) return null;
		if (!file.id || !file.path_display) return null;
		const rootPath = root.path_display.replace(/\/$/, "");
		if (!file.path_display.startsWith(`${rootPath}/`)) return null;
		return file.path_display.slice(rootPath.length + 1);
	}

	protected toDetachedEntity(path: string, file: DropboxEntry): FileEntity {
		return {
			path, pathAuthority: "actual_resolved", identityKey: file.id,
			isDirectory: file[".tag"] === "folder", size: file[".tag"] === "folder" ? 0 : file.size ?? 0,
			mtime: parseDropboxTime(file.server_modified ?? file.client_modified), hash: "",
			remoteChecksum: file.content_hash ? { algo: "dropbox", value: file.content_hash } : undefined,
			backendMeta: { dropboxId: file.id, rev: file.rev },
		};
	}

	protected detachedVersionToken(file: DropboxEntry): string | null {
		if (!file.id || !file.rev || !file.content_hash || !Number.isFinite(file.size)) return null;
		return `dropbox:${file.rev}`;
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
				const requestedParent = DropboxMetadataCache.parentPath(path);
				await this.ensureFolder(requestedParent);
				const actualParent = requestedParent
					? this.cache.findPathIgnoringCase(requestedParent)
					: "";
				if (actualParent === undefined) {
					throw new Error(`Cannot resolve provider parent for "${path}"`);
				}
				const leaf = path.split("/").pop()!;
				const candidate = actualParent ? `${actualParent}/${leaf}` : leaf;
				const targetPath = this.cache.findPathIgnoringCase(candidate) ?? candidate;
				if (this.cache.isFolder(targetPath)) {
					throw new Error(`Cannot write file: "${targetPath}" is an existing directory`);
				}
				return { existingId: this.cache.idAt(targetPath), targetPath };
			},
			execute: (r) => this.client.upload(this.addr(r.targetPath), content, mtime),
			staleGuard: (r) => ({ path: r.targetPath, expectedId: r.existingId }),
			update: (r, result) => {
				if (!this.cache.setResolvedEntry(result)) {
					this.cache.setEntry(r.targetPath, result, "requested_echo");
				}
			},
		});

		const hash = await sha256(content);
		return {
			path,
			pathAuthority: "requested_echo",
			identityKey: entry.id,
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
			return {
				path,
				pathAuthority: "requested_echo",
				identityKey: entry?.id,
				isDirectory: true,
				size: 0,
				mtime: 0,
				hash: "",
				backendMeta: { dropboxId: entry?.id },
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
				const entry = this.cache.getFile(oldPath);
				if (!entry) throw new Error(`File not found: ${oldPath}`);
				if (this.cache.hasFile(newPath)) throw new Error(`Destination already exists: ${newPath}`);
				await this.ensureFolder(DropboxMetadataCache.parentPath(newPath));
				const expectedId = this.cache.idAt(oldPath);
				return {
					expectedId,
					wasFolder: this.cache.isFolder(oldPath),
					caseOnlyTempPath: expectedId && isCaseOnlyRename(oldPath, newPath)
						? caseRenameTempPath(oldPath, expectedId)
						: undefined,
				};
			},
			execute: (r) => r.caseOnlyTempPath
				? this.moveCaseOnly(oldPath, newPath, r.caseOnlyTempPath, r.expectedId!)
				: this.client.move(this.addr(oldPath), this.addr(newPath)),
			staleGuard: (r) => ({ path: oldPath, expectedId: r.expectedId }),
			update: (r, result) => {
				// The shared staleGuard only validates the SOURCE (oldPath still resolves to
				// our id). A concurrent re-keyer could land a DIFFERENT entry at newPath during
				// the phase-2 move (run outside the mutex); setEntry would evict and overwrite
				// it, dropping that change. Skip instead — symmetric with write()'s new-path
				// guard and GoogleDriveFs.rename; the in-memory cursor advanced past it, so the
				// next cycle re-detects our rename. Currently unreachable (ADR 0001, T7:
				// rename runs serially in the structural phase, deltas never run during
				// execute) — retained as defense-in-depth.
				const occupant = this.cache.getFile(newPath);
				if (occupant && occupant.id !== result.id) {
					this.logger?.warn("Skipping stale cache update for rename", { path: newPath });
					return;
				}
				this.cache.removeEntry(oldPath);
				// move_v2's metadata may arrive without a `.tag` discriminator; stamp it
				// from the known prior type so the cache keeps classifying a moved folder
				// as a folder (else a later write into it fails with "is a file").
				const moved = {
					...result, ".tag": r.wasFolder ? "folder" : "file",
				} satisfies DropboxEntry;
				if (!this.cache.setResolvedEntry(moved)) {
					this.cache.setEntry(newPath, moved, "actual_resolved");
				}
				if (r.wasFolder) this.cache.rewriteChildPaths(oldPath, newPath);
			},
		});
	}

	/** Dropbox move_v2 does not support case-only renames; settle both legs here. */
	private async moveCaseOnly(
		oldPath: string,
		newPath: string,
		tempPath: string,
		expectedId: string,
	): Promise<DropboxEntry> {
		const existingTemp = await this.getOptionalMetadata(this.addr(tempPath));
		if (existingTemp) {
			throw new Error(`Dropbox case-only rename temporary path is occupied: ${tempPath}`);
		}
		const destination = await this.getOptionalMetadata(this.addr(newPath));
		if (destination && (destination.id !== expectedId ||
			this.cache.relativize(destination) === newPath)) {
			throw new Error(`Dropbox case-only rename destination is occupied: ${newPath}`);
		}

		try {
			await this.client.move(this.addr(oldPath), this.addr(tempPath));
		} catch (err) {
			const settled = await this.caseRenameEndpoint(expectedId, oldPath, newPath, tempPath);
			if (settled?.path === newPath) return settled.entry;
			if (settled?.path !== tempPath) throw err;
		}

		try {
			return await this.client.move(this.addr(tempPath), this.addr(newPath));
		} catch (err) {
			const settled = await this.caseRenameEndpoint(expectedId, oldPath, newPath, tempPath);
			if (settled?.path === newPath) return settled.entry;
			if (settled?.path === oldPath) throw err;
			if (settled?.path !== tempPath) {
				throw new Error("Dropbox case-only rename endpoint is indeterminate", { cause: err });
			}
			try {
				await this.client.move(this.addr(tempPath), this.addr(oldPath));
			} catch (rollbackErr) {
				const afterRollback = await this.caseRenameEndpoint(expectedId, oldPath, newPath, tempPath);
				if (afterRollback?.path === oldPath) throw err;
				throw new Error(
					`Dropbox case-only rename failed and rollback failed: ` +
					`${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
					{ cause: err },
				);
			}
			const restored = await this.caseRenameEndpoint(expectedId, oldPath, newPath, tempPath);
			if (restored?.path !== oldPath) {
				throw new Error("Dropbox case-only rename rollback could not be verified", { cause: err });
			}
			throw err;
		}
	}

	private async caseRenameEndpoint(
		expectedId: string,
		...paths: string[]
	): Promise<{ path: string; entry: DropboxEntry } | null> {
		for (const path of paths) {
			const entry = await this.getOptionalMetadata(this.addr(path));
			if (entry?.id === expectedId && this.cache.relativize(entry) === path) {
				return { path, entry };
			}
		}
		return null;
	}

	private async getOptionalMetadata(path: string): Promise<DropboxEntry | null> {
		try {
			return await this.client.getMetadata(path);
		} catch (err) {
			if (err instanceof DropboxApiError && err.summary.includes("not_found")) return null;
			throw err;
		}
	}

	/** Ensure a folder exists by path, creating parents as needed (idempotent). */
	private async ensureFolder(path: string): Promise<void> {
		if (!path) return;
		const existingPath = this.cache.findPathIgnoringCase(path);
		if (existingPath && this.cache.isFolder(existingPath)) return;
		const parts = path.split("/");
		let currentPath = "";
		for (const part of parts) {
			const requestedPath = currentPath ? `${currentPath}/${part}` : part;
			const cachedPath = this.cache.findPathIgnoringCase(requestedPath) ?? requestedPath;
			if (this.cache.isFolder(cachedPath)) {
				currentPath = cachedPath;
				continue;
			}
			if (this.cache.hasFile(cachedPath)) {
				throw new Error(`Cannot create directory "${path}": "${cachedPath}" is a file`);
			}
			const folder = await this.client.createFolder(this.addr(requestedPath));
			const resolved = this.cache.setResolvedEntry(folder);
			if (resolved) {
				currentPath = resolved;
			} else {
				this.cache.setEntry(requestedPath, folder, "requested_echo");
				currentPath = requestedPath;
			}
		}
	}
}
