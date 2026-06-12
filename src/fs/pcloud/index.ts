import type { FileEntity } from "../types";
import type { PCloudEntry } from "./types";
import { parsePCloudTime, PCloudApiError, PCLOUD_FULL_ACCESS_REQUIRED } from "./types";
import type { PCloudClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import { PCloudMetadataCache, flattenPCloudListing } from "./metadata-cache";
import { applyPCloudDiff } from "./incremental-sync";
import { INTERNAL_METADATA_PATH } from "../remote-vault-contract";
import { sha256 } from "../../utils/hash";
import { normalizeSyncPath, validateRename } from "../../utils/path";
import { CachingRemoteFs } from "../caching/remote-fs";
import type { IncrementalChangesResult } from "../caching/remote-fs";

/** A file's pCloud numeric id ("fileid"/"folderid"), used for API addressing. */
function numericIdOf(entry: PCloudEntry): string {
	return String(entry.isfolder ? entry.folderid : entry.fileid);
}

/**
 * True when an error is pCloud's "this method needs a full-access app" (result 2096).
 * The account-wide `diff` feed raises it for a "Specific folder only" app, so both
 * entry points to `diff` (getStartCursor's baseline and fetchChanges' replay) treat
 * it as "no delta available → fall back to a full-scan reconcile".
 */
function isFullAccessRequired(err: unknown): boolean {
	return err instanceof PCloudApiError && err.result === PCLOUD_FULL_ACCESS_REQUIRED;
}

/**
 * IFileSystem implementation backed by pCloud.
 *
 * The crash-safe cache/checkpoint machinery lives in {@link CachingRemoteFs}; this
 * subclass supplies the pCloud-specific seams (the account-wide `diff` delta, a
 * recursive listfolder, download/delete by id, root-liveness) and the mutating ops
 * (write/mkdir/rename), whose pCloud API calls are backend-specific. After the
 * initial recursive listfolder it tracks remote changes via the `diff` feed.
 */
export class PCloudFs extends CachingRemoteFs<PCloudEntry> {
	readonly name = "pcloud";
	private client: PCloudClient;

	constructor(client: PCloudClient, rootFolderId: string, logger?: Logger, metadataStore?: MetadataStore<PCloudEntry>) {
		super(rootFolderId, new PCloudMetadataCache(rootFolderId, logger), metadataStore, logger);
		this.client = client;
	}

	// ── pCloud-specific seams ──

	protected async getStartCursor(): Promise<string> {
		// The account-wide `diff` feed is only available to "full access" pCloud apps;
		// a "Specific folder only" app gets result 2096. When that happens there is no
		// usable delta, so return an EMPTY cursor: the base treats that as "no checkpoint"
		// (hasCheckpoint() === false), and the orchestrator cold-reconciles every cycle via
		// the recursive listfolder (which a folder-scoped app CAN call) — fetchChanges()
		// is then never reached (the empty-cursor guard in _applyIncrementalChanges short-
		// circuits it). Full-access apps (and the crash-safety contract's fake) get a real
		// cursor and keep the incremental `diff` path.
		try {
			return await this.client.getDiffBaseline();
		} catch (err) {
			if (isFullAccessRequired(err)) {
				this.logger?.info("pCloud diff unavailable (folder-scoped app); reconciling by full scan each cycle");
				return "";
			}
			throw err;
		}
	}

	protected async fullList(): Promise<PCloudEntry[]> {
		const root = await this.client.listFolder(this.rootFolderId, true);
		return flattenPCloudListing(root);
	}

	protected assertRootAlive(): Promise<void> {
		// No network check needed. pCloud's listfolder throws (result 2005, "Directory
		// does not exist") when the root is gone, so the recursive fullList() that the
		// base runs immediately before this already proved the root is alive — an empty
		// result is therefore a genuinely empty folder, not a deleted root, and a cold
		// reconcile won't read every file as remotely deleted and nuke the local vault.
		// (Drive needs a real call here because its listing returns empty/200 for a
		// trashed root; pCloud's listfolder does not — it errors.)
		return Promise.resolve();
	}

	protected async fetchChanges(cursor: string): Promise<IncrementalChangesResult> {
		// The incremental `diff` delta — reached only for a full-access app (or the
		// crash-safety contract's fake), since getStartCursor() returns "" for a
		// folder-scoped app and the empty-cursor guard then skips this.
		try {
			return await applyPCloudDiff({ cache: this.cache, client: this.client, logger: this.logger }, cursor);
		} catch (err) {
			if (isFullAccessRequired(err)) {
				// A full-access app was downgraded to "Specific folder only" mid-life: a real
				// cursor was restored from IDB, but `diff` now 2096s. Force a full scan — the
				// ensuing fullScan()→getStartCursor() returns "" and the FS drops to a
				// cold-reconcile from here on (no stuck retry loop).
				this.logger?.info("pCloud diff became unavailable (folder-scoped); forcing a full scan");
				return { needsFullScan: true, changedPaths: new Set<string>() };
			}
			throw err;
		}
	}

	protected downloadFile(fileId: string): Promise<ArrayBuffer> {
		// The base resolves the cache id ("f<fileid>"); pCloud's API addresses by the
		// bare numeric fileid.
		return this.client.downloadFile(fileId.slice(1));
	}

	protected deleteRemote(id: string): Promise<void> {
		// The cache id encodes the type: "d…" folder, "f…" file; the API takes the
		// bare numeric id.
		const numericId = id.slice(1);
		return id.charAt(0) === "d"
			? this.client.deleteFolderRecursive(numericId)
			: this.client.deleteFile(numericId);
	}

	// ── Mutating ops (pCloud API) ──

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		if (path === INTERNAL_METADATA_PATH) {
			// The backend manages its metadata out-of-band; it must never be pushed
			// through the sync engine (the orchestrator excludes it too).
			throw new Error(`Refusing to write reserved backend path: ${path}`);
		}
		const { result: entry } = await this.withCacheMutex({
			operationName: "write",
			resolve: async () => {
				if (this.cache.isFolder(path)) {
					throw new Error(`Cannot write file: "${path}" is an existing directory`);
				}
				const existing = this.cache.getFile(path);
				const fileName = path.split("/").pop()!;
				const parentPath = path.substring(0, path.lastIndexOf("/"));
				const parentId = parentPath ? await this.ensureFolder(parentPath) : this.rootFolderId;
				return { fileName, parentId, existingId: existing?.id };
			},
			execute: (r) => this.client.uploadFile(r.parentId, r.fileName, content, mtime),
			staleGuard: (r) => ({ path, expectedId: r.existingId }),
			update: (_r, result) => { this.cache.setFile(path, result); },
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
		path = normalizeSyncPath(path);
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const folderId = await this.ensureFolder(path);
			return { path, isDirectory: true, size: 0, mtime: 0, hash: "", backendMeta: { pcloudId: "d" + folderId } };
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
				// The shared stale-guard only validates the SOURCE (oldPath still resolves
				// to our id). A concurrent delta can land a DIFFERENT entry at newPath during
				// the phase-2 network op; overwriting it would strand that delta's id. Skip
				// instead — symmetric with write()'s new-path guard; the next cycle re-detects.
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

	/** Ensure a folder exists by path, creating parents as needed (idempotent). */
	private async ensureFolder(path: string): Promise<string> {
		const existing = this.cache.getFile(path);
		if (existing && this.cache.isFolder(path)) return String(existing.folderid);

		const parts = path.split("/");
		let currentPath = "";
		let parentId = this.rootFolderId;
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const cached = this.cache.getFile(currentPath);
			if (cached && this.cache.isFolder(currentPath)) {
				parentId = String(cached.folderid);
			} else if (cached) {
				throw new Error(`Cannot create directory "${path}": "${currentPath}" is a file`);
			} else {
				const folder = await this.client.createFolderIfNotExists(parentId, part);
				this.cache.setFile(currentPath, folder);
				parentId = String(folder.folderid);
			}
		}
		return parentId;
	}
}
