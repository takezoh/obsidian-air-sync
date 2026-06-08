import type { IFileSystem } from "../interface";
import type { FileEntity } from "../types";
import type { RenamePair } from "../../sync/types";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import { AsyncMutex } from "../../queue/async-queue";
import type { AbstractMetadataCache } from "./metadata-cache";

/** A remote delta: paths added/modified, deleted, and renamed since the last cursor. */
export interface RemoteDelta {
	modified: string[];
	deleted: string[];
	renamed: RenamePair[];
}

/** Result of fetching one batch of incremental changes from a backend's delta API. */
export type IncrementalChangesResult =
	| { needsFullScan: false; newToken: string; changedPaths: Set<string>; renamedPaths: RenamePair[] }
	| { needsFullScan: true; changedPaths: Set<string> };

/**
 * IndexedDB meta key under which the delta cursor is persisted, ALONGSIDE the
 * file map and in the SAME transaction (see {@link CachingRemoteFs.commitCheckpoint}).
 * Co-locating the cursor with the cache is what makes the checkpoint atomic — there
 * is no separate settings write that a crash could leave out of step with the cache.
 * The literal value is part of the persisted schema; do not change it.
 */
const CURSOR_META_KEY = "changesStartPageToken";

/**
 * Shared base for an id-addressed remote backend with an incremental delta cursor
 * and a crash-safe, co-located metadata checkpoint (ADR 0001).
 *
 * Owns every part that is identical across Drive/Dropbox/pCloud: the cache mutex
 * and its three-phase `withCacheMutex` protocol, full-scan / cursor-restore / fresh
 * lifecycle, the atomic checkpoint commit (cache + cursor in one transaction),
 * incremental-replay buffering, the 410-style full-scan-and-diff-by-id fallback,
 * and the read-only ops (list/stat/listDir/read/delete) that just walk the cache.
 *
 * A concrete backend supplies the small set of seams below — how to capture a
 * start cursor, list everything, fetch a delta page, download/delete by id, and
 * confirm the root is alive — plus the mutating ops (write/mkdir/rename) whose
 * remote API calls are backend-specific. Its metadata cache (a subclass of
 * {@link AbstractMetadataCache}) supplies field extraction and `FileEntity`
 * projection.
 */
export abstract class CachingRemoteFs<TFile> implements IFileSystem {
	abstract readonly name: string;

	protected rootFolderId: string;
	protected cache: AbstractMetadataCache<TFile>;
	protected logger?: Logger;
	protected metadataStore?: MetadataStore<TFile>;
	protected cacheMutex = new AsyncMutex();

	private initialized = false;
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

	protected constructor(
		rootFolderId: string,
		cache: AbstractMetadataCache<TFile>,
		metadataStore?: MetadataStore<TFile>,
		logger?: Logger,
	) {
		this.rootFolderId = rootFolderId;
		this.cache = cache;
		this.metadataStore = metadataStore;
		this.logger = logger;
	}

	/** Get the current changes page token to persist between sessions */
	get changesPageToken(): string | null {
		return this._changesPageToken;
	}

	/** Set a previously saved changes page token for incremental sync */
	set changesPageToken(token: string | null) {
		this._changesPageToken = token;
	}

	// ── Per-backend seams ──

	/** Capture a delta cursor that covers changes from *now* onward (before listing). */
	protected abstract getStartCursor(): Promise<string>;
	/** List every file under the sync root, as a flat array for `buildFromFiles`. */
	protected abstract fullList(): Promise<TFile[]>;
	/**
	 * Confirm the sync root is still live when a full list comes back EMPTY. An empty
	 * listing can mean "genuinely empty" or "root deleted/trashed" — the latter must
	 * abort rather than let a cold reconcile read every file as remotely deleted and
	 * plan a mass delete_local. Throw if the root is gone; return if it is just empty.
	 */
	protected abstract assertRootAlive(): Promise<void>;
	/** Fetch one batch of incremental changes from the cursor and apply them to the cache. */
	protected abstract fetchChanges(cursor: string): Promise<IncrementalChangesResult>;
	/** Download a file's content by its backend id. */
	protected abstract downloadFile(fileId: string): Promise<ArrayBuffer>;
	/** Delete a file/folder by its backend id (remote side only; cache is updated here). */
	protected abstract deleteRemote(fileId: string): Promise<void>;

	abstract write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity>;
	abstract mkdir(path: string): Promise<FileEntity>;
	abstract rename(oldPath: string, newPath: string): Promise<void>;

	// ── Three-phase cache update (mutex → network → guarded cache write) ──

	protected async withCacheMutex<TResolved, TResult>(opts: {
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
			const currentId = this.cache.idAt(path);
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

	// ── Lifecycle: full scan / restore / fresh ──

	/** Full scan to build the metadata cache */
	private async fullScan(): Promise<void> {
		this.cache.clear();

		// Get the starting cursor BEFORE listing so concurrent changes aren't missed.
		this._changesPageToken = await this.getStartCursor();

		const allFiles = await this.fullList();
		// An empty listing is ambiguous (empty folder vs deleted/trashed root); the
		// seam aborts if the root is gone rather than nuking the local vault.
		if (allFiles.length === 0) {
			await this.assertRootAlive();
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
	protected async ensureInitialized(): Promise<boolean> {
		if (this.initialized) return true;
		if (await this.loadFromCache()) return true;
		await this.fullScan();
		return false;
	}

	/**
	 * Restore the file map AND the delta cursor from IndexedDB. They are committed
	 * together in one transaction (ADR 0001), so the **cursor's presence** is the
	 * checkpoint signal — restore whenever it is present, even if the file map is empty
	 * (a vault that legitimately synced down to zero files is a valid checkpoint, and
	 * this keys identically to {@link hasCheckpoint}). No cursor means no usable
	 * checkpoint; the caller full-scans (losing the cursor is safe — a cold reconcile
	 * re-derives everything from the SyncRecord baseline).
	 */
	private async loadFromCache(): Promise<boolean> {
		if (!this.metadataStore) return false;
		try {
			await this.metadataStore.open();
			const { files, meta } = await this.metadataStore.loadAll();
			const cursor = meta.get(CURSOR_META_KEY);
			if (!cursor) return false;

			this.cache.clear();
			this.cache.bulkLoad(files.map((r): [string, TFile] => [r.path, r.file]));
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

	// ── Checkpoint: atomic cache + cursor commit (ADR 0001) ──

	/**
	 * Flush the file map AND the delta cursor to IndexedDB, atomically, after a clean
	 * cycle. Both commit in one transaction, so the persisted cache can never run ahead
	 * of — nor behind — the committed cursor: a failed flush lands neither, and on the
	 * next run the replay re-detects any un-flushed work. The buffer is cleared only
	 * after success (a throw propagates and retains it for the next clean cycle's retry).
	 */
	async commitCheckpoint(): Promise<void> {
		if (!this.metadataStore) return;
		await this.cacheMutex.run(async () => {
			await this.commitCache();
			this.pendingFullPersist = false;
			this.touchedPaths.clear();
		});
	}

	/**
	 * Write the cache + cursor to the store. `pendingFullPersist` rewrites the whole map
	 * (after a full scan); otherwise the touched paths are reconciled against the live
	 * cache — present → upsert, absent → delete. The reconcile reads the final cache
	 * state, so it is order-independent and correct even when `touched` spans several
	 * earlier failed cycles. The cursor is written in the SAME transaction as the file
	 * changes, so the persisted cache can never run ahead of (or behind) the cursor.
	 */
	private async commitCache(): Promise<void> {
		const store = this.metadataStore;
		if (!store) return;
		await store.open();
		const meta = this._changesPageToken
			? new Map([[CURSOR_META_KEY, this._changesPageToken]])
			: new Map<string, string>();
		if (this.pendingFullPersist) {
			await store.saveAll(this.cache.exportRecords(), meta);
			return;
		}
		const updated: { path: string; file: TFile; isFolder: boolean }[] = [];
		const deleted: string[] = [];
		for (const path of this.touchedPaths) {
			const file = this.cache.getFile(path);
			if (file) updated.push({ path, file, isFolder: this.cache.isFolder(path) });
			else deleted.push(path);
		}
		await store.commitIncremental(updated, deleted, meta);
	}

	/**
	 * Whether a committed delta checkpoint exists. The orchestrator uses this to force
	 * a cold reconcile when there is none (first sync, or after a rescan). Reads the
	 * in-memory cursor once initialized, otherwise peeks the IDB store — the cursor is
	 * co-located with the cache, so its presence is the checkpoint.
	 */
	async hasCheckpoint(): Promise<boolean> {
		if (this.initialized) return !!this._changesPageToken;
		if (!this.metadataStore) return false;
		try {
			await this.metadataStore.open();
			return !!(await this.metadataStore.getMeta(CURSOR_META_KEY));
		} catch {
			return false;
		}
	}

	/**
	 * Discard the committed checkpoint (cursor + cache) so the next sync cold-
	 * reconciles. Used by the Rescan action and an identity change. Losing the
	 * checkpoint is safe — a cold full list × SyncRecord baseline join re-derives every
	 * change (ADR 0001). Runs under `cacheMutex` (like every other mutator) so it can't
	 * corrupt a concurrent op; the IDB clear runs first, so if it throws the in-memory
	 * state stays consistent with the (un-cleared) store rather than being half-wiped.
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

	// ── Incremental replay + 410 full-scan-and-diff fallback ──

	/** Apply incremental changes from the current cursor (caller ensured init + holds mutex). */
	private async _applyIncrementalChanges(): Promise<RemoteDelta | null> {
		if (!this._changesPageToken) return null;

		const result = await this.fetchChanges(this._changesPageToken);

		if (result.needsFullScan) {
			// Cursor expired (e.g. Drive 410): snapshot-diff a fresh full scan for the delta.
			return this.fullScanWithDelta();
		}

		this._changesPageToken = result.newToken;
		// Buffer changed paths for the checkpoint commit (persisted only on a clean cycle).
		for (const path of result.changedPaths) this.touchedPaths.add(path);

		const modified: string[] = [];
		const deleted: string[] = [];
		for (const path of result.changedPaths) {
			// removeTree() was already called while fetching changes, so deleted paths
			// will correctly be absent from cache here. Edge case: if a path was removed
			// as a descendant of a deleted folder but a new file with the same path was
			// added in the same batch, it would be misclassified as modified. This is
			// unlikely in practice and does not cause data loss.
			if (this.cache.hasFile(path)) {
				modified.push(path);
			} else {
				deleted.push(path);
			}
		}
		return { modified, deleted, renamed: result.renamedPaths };
	}

	/**
	 * Full scan with delta computation (the cursor-expiry fallback): snapshot old
	 * paths-by-id, perform a fresh full scan, then diff old vs new by id. Returns null
	 * on the initial sync (no prior snapshot).
	 */
	private async fullScanWithDelta(): Promise<RemoteDelta | null> {
		// Snapshot before fullScan() overwrites the cache (only reached on cursor expiry,
		// when the cache is already populated).
		const oldPathById = this.cache.snapshotPathsById();
		await this.fullScan();
		if (oldPathById.size === 0) return null; // initial sync — no delta
		return this.diffById(oldPathById);
	}

	/**
	 * Compute a remote delta by diffing a pre-scan path-by-id snapshot against the
	 * freshly-scanned cache. Keys on backend id, so it detects adds/deletes/renames but
	 * NOT in-place content edits (same path+id); those are caught by the next incremental
	 * sync or WARM mode's local-vs-record check.
	 */
	private diffById(oldPathById: Map<string, string>): RemoteDelta {
		const modified: string[] = [];
		const deleted: string[] = [];
		const renamed: RenamePair[] = [];
		const newIds = new Set<string>();
		for (const [newPath] of this.cache.entries()) {
			const id = this.cache.idAt(newPath);
			if (id === undefined) continue;
			newIds.add(id);
			const oldPath = oldPathById.get(id);
			if (!oldPath) {
				modified.push(newPath);
			} else if (oldPath !== newPath) {
				renamed.push({ oldPath, newPath, isFolder: this.cache.isFolder(newPath) || undefined });
				modified.push(newPath);
				deleted.push(oldPath);
			}
		}
		for (const [id, oldPath] of oldPathById) {
			if (!newIds.has(id)) deleted.push(oldPath);
		}
		if (modified.length > 0 || deleted.length > 0 || renamed.length > 0) {
			this.logger?.info("Full scan delta", {
				added: modified.length - renamed.length,
				deleted: deleted.length - renamed.length,
				renamed: renamed.length,
			});
		}
		return { modified, deleted, renamed };
	}

	/**
	 * Return paths changed since the last committed cursor. Returns null on the initial
	 * sync (a fresh full scan just captured "now", so there is no delta).
	 */
	async getChangedPaths(): Promise<{ modified: string[]; deleted: string[]; renamed?: RenamePair[] } | null> {
		return this.cacheMutex.run(async () => {
			const replay = await this.ensureInitialized();
			return replay ? this._applyIncrementalChanges() : null;
		});
	}

	// ── Read-only ops (walk the cache) ──

	async list(): Promise<FileEntity[]> {
		return this.cacheMutex.run(async () => {
			// A fresh full scan captures "now"; a restored cursor warrants a replay.
			if (await this.ensureInitialized()) {
				await this._applyIncrementalChanges();
			}

			const entities: FileEntity[] = [];
			for (const [path, file] of this.cache.entries()) {
				entities.push(this.cache.toEntity(path, file));
			}
			return entities;
		});
	}

	/**
	 * Return cached metadata for a path. hash is always "" — the sync engine should use
	 * remoteChecksum for content-change detection. Does not replay here because list()
	 * already applies incremental changes before returning the full file list, and
	 * stat() is only called after list() has refreshed the cache.
	 */
	async stat(path: string): Promise<FileEntity | null> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const file = this.cache.getFile(path);
			if (!file) return null;
			return this.cache.toEntity(path, file);
		});
	}

	/** Download file content. Like stat(), relies on list() having refreshed the cache. */
	async read(path: string): Promise<ArrayBuffer> {
		// Phase 1: resolve the backend id under the mutex.
		const fileId = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const id = this.cache.idAt(path);
			if (id === undefined) {
				throw new Error(`File not found: ${path}`);
			}
			return id;
		});

		// Phase 2: download outside the mutex (network I/O).
		return this.downloadFile(fileId);
	}

	async listDir(path: string): Promise<FileEntity[]> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const kids = this.cache.getChildren(path);
			if (!kids) return [];
			const entities: FileEntity[] = [];
			for (const childPath of kids) {
				const file = this.cache.getFile(childPath);
				if (file) {
					entities.push(this.cache.toEntity(childPath, file));
				}
			}
			return entities;
		});
	}

	async delete(path: string): Promise<void> {
		// Phase 1: resolve the backend id under the mutex.
		const fileId = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			return this.cache.idAt(path) ?? null;
		});

		if (!fileId) return;

		// Phase 2: remote delete outside the mutex (network I/O).
		await this.deleteRemote(fileId);

		// Phase 3: update the cache under the mutex with an id guard (a concurrent delta
		// may have updated the cache during phase 2).
		await this.cacheMutex.run(() => {
			if (this.cache.idAt(path) === fileId) {
				this.cache.removeTree(path);
			} else {
				this.logger?.warn("Skipping stale cache update for delete", { path });
			}
		});
	}

	/** Close the metadata store (call on plugin unload) */
	async close(): Promise<void> {
		await this.metadataStore?.close();
	}
}
