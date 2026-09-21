import type { IFileSystem, IncrementalCheckpoint } from "../interface";
import type { FileEntity, PathAuthority, RenamePair } from "../types";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import { errorMessage } from "../../backend-api/error-classification";
import { AsyncMutex } from "../../backend-api/async-queue";
import type {
	PriorityObservation,
	PriorityObservationCapability,
	PriorityObservationRequest,
	PriorityReadResult,
} from "../priority-observation";
import { normalizeSyncPath } from "../../utils/path";
import type { AbstractMetadataCache, AddressDisplacement } from "./metadata-cache";
import { projectedIdentityKey } from "./metadata-cache";
import { observeDetachedPriority, readDetachedPriority } from "./detached-priority";
import type { DetachedReadOutcome } from "./detached-priority";

/**
 * A remote delta: paths added/modified, deleted, and renamed since the last cursor,
 * plus the addresses this cycle found claimed by two live ids.
 *
 * `contended` is what keeps `deleted` honest. A path can be absent from the working
 * view for two completely different reasons — the provider deleted the object, or
 * two objects claimed one derived address and the cache could only hold one — and
 * only the first is a deletion. The second names an object that is still on the
 * provider, so reporting it in `deleted` would authorize deleting a live file
 * locally. Every producer of `deleted` subtracts these facts; nothing else may.
 */
export interface RemoteDelta {
	modified: string[];
	deleted: string[];
	renamed: RenamePair[];
	contended: readonly AddressDisplacement[];
}

/**
 * Result of fetching one batch of incremental changes from a backend's delta API.
 *
 * `contended` carries the drain's own contention facts (`IdDeltaResult`) through to
 * the classification below. It is optional because a backend whose addresses ARE
 * the provider's keys (Dropbox) can never produce one.
 */
export type IncrementalChangesResult =
	| {
		needsFullScan: false;
		newToken: string;
		changedPaths: Set<string>;
		renamedPaths: RenamePair[];
		contended?: readonly AddressDisplacement[];
	}
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
 * IndexedDB meta key under which the scope fingerprint (see
 * `computeScopeFingerprint` in `src/sync/scope-fingerprint.ts`) is persisted,
 * co-located with the cursor in the same transaction as {@link CURSOR_META_KEY}.
 * Absence (a checkpoint committed before this field existed, or a fresh
 * checkpoint) is read back as `null` by {@link CachingRemoteFs.getScopeFingerprint}.
 */
const SCOPE_FINGERPRINT_META_KEY = "scopeFingerprint";

/**
 * The cache addresses that are absent because a contention stands, gathered from
 * the facts the cycle's own producer handed over.
 *
 * There are exactly three producers of `RemoteDelta.deleted`, and this is the one
 * rule all three subtract: the `hasFile` split over `changedPaths` (producer 1,
 * below), `diffById`'s vanished-id sweep (producer 2, the cursor-expiry route), and
 * `id-delta.ts`'s "old path and no new path" branch (producer 3), which decides its
 * own half and feeds what is left into producer 1. An absence that cannot be
 * attributed to a contention is classified exactly as it always was — attribution
 * failure must neither upgrade an absence nor suppress one.
 */
function displacedAddresses(contended: readonly AddressDisplacement[]): ReadonlySet<string> {
	const paths = new Set<string>();
	for (const fact of contended) {
		for (const path of fact.displacedPaths) paths.add(path);
	}
	return paths;
}

/** The paths several ids held in a path-by-id snapshot — folders merged there. */
function sharedPaths(pathById: ReadonlyMap<string, string>): ReadonlySet<string> {
	const seen = new Set<string>();
	const shared = new Set<string>();
	for (const path of pathById.values()) (seen.has(path) ? shared : seen).add(path);
	return shared;
}

/**
 * How many cached paths a completed full scan lists at debug level. Enough to
 * identify a missing file in an ordinary vault without letting a large one turn
 * a routine scan into an unbounded log write.
 */
const FULL_SCAN_PATH_LOG_CAP = 200;

/**
 * Shared base for an id-addressed remote backend with an incremental delta cursor
 * and a crash-safe, co-located metadata checkpoint (ADR 0001).
 *
 * Owns every part that is identical across Google Drive/Dropbox/pCloud: the cache mutex
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
	 * Scope fingerprint committed with the last clean cycle (see
	 * {@link IncrementalCheckpoint.getScopeFingerprint}). Kept in memory once
	 * initialized, same lifecycle as `_changesPageToken`; both are written to the
	 * store in the same transaction at commit time.
	 */
	private _scopeFingerprint: string | null = null;
	/**
	 * The contentions decided while building this working view from a path-level call,
	 * waiting to be drained exactly once.
	 *
	 * A full scan is entered lazily, from whichever path-level call first needs the
	 * cache — `list()`, `stat()`, `listDir()` — and `list()` replays the cursor on a
	 * restored checkpoint. None of them can return an address-level fact, so before
	 * this their contentions were simply dropped and a withheld object stayed invisible
	 * for as long as the checkpoint stood. They belong to the working view, share its
	 * lifecycle, and are cleared with it.
	 *
	 * Handed over, not held: {@link drainWorkingViewContentions} empties it, so this
	 * is a one-shot channel out of a lazy call and never a second reader's state. A
	 * delta `getChangedPaths` returns carries its own contentions and parks nothing
	 * here, so nothing is reported twice.
	 */
	private _workingViewContentions: readonly AddressDisplacement[] = [];

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
	/**
	 * Version-bound download for the priority path. The default defers to
	 * {@link downloadFile}; a filesystem whose provider reports a typed read outcome
	 * overrides this so a mid-read change is returned, never thrown away.
	 */
	protected async downloadForPriority(fileId: string): Promise<DetachedReadOutcome> {
		return { kind: "content", content: await this.downloadFile(fileId) };
	}
	/** Delete a file/folder by its backend id (remote side only; cache is updated here). */
	protected abstract deleteRemote(fileId: string): Promise<void>;
	/** Request-local provider lookup only; priority observation must not touch the cache or delta cursor. */
	protected abstract fetchCurrentFile(fileId: string): Promise<TFile | null>;
	protected abstract fetchCurrentPath(path: string): Promise<TFile[] | null>;
	protected abstract resolveDetachedPath(file: TFile): Promise<string | null>;
	protected abstract toDetachedEntity(path: string, file: TFile): FileEntity;
	protected abstract detachedVersionToken(file: TFile): string | null;

	readonly priority: PriorityObservationCapability = {
		observe: (request) => this.observePriority(request),
		read: (observation) => this.readPriority(observation),
	};

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
			// This is the compare-and-swap of an optimistic protocol: phase 2 (the
			// network op above) ran with the mutex RELEASED, so the phase-1 view of the
			// cache may be stale by now. Re-read idAt(path) and write only if it still
			// matches what phase 1 saw:
			//  - expectedId set (operating on a known file): skip if the path now
			//    resolves to a different id — it was replaced/moved out from under us.
			//  - expectedId undefined (creating a NEW path): skip if the path is now
			//    occupied at all. Overwriting would drop the concurrent change; the
			//    in-memory cursor already advanced past it, so the next cycle re-detects
			//    our write — no data loss.
			// A concurrent re-keyer during phase 2 is currently UNREACHABLE (ADR 0001,
			// T7): deltas run only in the detect phase, never during execute, so the
			// only producer would be a parallel Group-A write — and those target
			// disjoint file paths. The guard is retained as defense-in-depth for those
			// type-unenforced invariants; it degrades a future violation from silent
			// cache corruption to a logged skip.
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

	/**
	 * Full scan to build the metadata cache.
	 *
	 * Returns the contentions `buildFromFiles` decided over the complete listing.
	 * Handing them back is what gives the full-scan route a DECLARED producer for
	 * the absence rule: `fullScanWithDelta` passes them to `diffById`, which would
	 * otherwise read every withheld claimant as a vanished id and call it deleted.
	 */
	private async fullScan(): Promise<readonly AddressDisplacement[]> {
		this.cache.clear();

		// Get the starting cursor BEFORE listing so concurrent changes aren't missed.
		this._changesPageToken = await this.getStartCursor();

		const allFiles = await this.fullList();
		// An empty listing is ambiguous (empty folder vs deleted/trashed root); the
		// seam aborts if the root is gone rather than nuking the local vault.
		if (allFiles.length === 0) {
			await this.assertRootAlive();
		}
		const contended = this.cache.buildFromFiles(allFiles);

		this.initialized = true;
		this.logger?.info("Full scan completed", { fileCount: this.cache.size });
		// "Full scan completed" only ever logged the count, which says whether this
		// cache and change detection disagree but never where. Log the paths
		// themselves so "why isn't this specific file syncing" is a direct answer
		// rather than another layer to add a diagnostic for. Capped so a large vault
		// can't turn a routine scan into an unbounded debug write, and built inside
		// the level check so it costs nothing at all when logging is off.
		if (this.logger?.enabled("debug")) {
			const paths: string[] = [];
			for (const [path] of this.cache.entries()) {
				if (paths.length === FULL_SCAN_PATH_LOG_CAP) break;
				paths.push(path);
			}
			this.logger.debug("Full scan paths", { paths, total: this.cache.size });
		}
		return contended;
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
		// The caller is a path-level API with nowhere to put an address-level fact, so
		// the scan's contentions are parked on the working view for the cycle to drain.
		// `fullScanWithDelta` deliberately does not come through here: it takes the
		// return value, so a cursor-expiry scan reports through the delta and only there.
		this._workingViewContentions = await this.fullScan();
		return false;
	}

	/**
	 * Take the contentions the working view was built with, leaving none behind.
	 *
	 * Every temperature reports its contentions through this or through the delta, so
	 * an address the cache could not seat is announced once per cycle no matter which
	 * call happened to build the view — which is what makes "nothing disappears from
	 * the working view without saying so" true on the full-scan route too.
	 */
	drainWorkingViewContentions(): readonly AddressDisplacement[] {
		const drained = this._workingViewContentions;
		this._workingViewContentions = [];
		return drained;
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
			// A merged folder path is one stored record carrying its other folders; each
			// is seated at the same path, where the cache merges it beside the first.
			this.cache.bulkLoad(files.flatMap((r): [string, TFile, PathAuthority?][] => [
				[r.path, r.file, r.pathAuthority],
				...(r.merged ?? []).map((file): [string, TFile, PathAuthority?] => [r.path, file, r.pathAuthority]),
			]));
			this._changesPageToken = cursor;
			this._scopeFingerprint = meta.get(SCOPE_FINGERPRINT_META_KEY) ?? null;
			this.initialized = true;
			this.logger?.info("Cache loaded from IndexedDB", { fileCount: files.length });
			return true;
		} catch (err) {
			this.logger?.warn("Failed to load cache from IndexedDB, will full scan", {
				message: errorMessage(err),
			});
			return false;
		}
	}

	// ── Checkpoint: atomic cache + cursor commit (ADR 0001) ──

	/**
	 * Every CachingRemoteFs IS its own incremental-checkpoint capability — it implements
	 * all core methods directly. Exposing `this` (typed down to {@link IncrementalCheckpoint})
	 * is what lets the sync engine treat the bundle as one all-or-nothing capability
	 * (`fs.checkpoint?.…`) without a downcast.
	 */
	get checkpoint(): IncrementalCheckpoint { return this; }

	/**
	 * Flush the file map AND the delta cursor to IndexedDB, atomically, after a clean
	 * cycle. Both commit in one transaction, so the persisted cache can never run ahead
	 * of — nor behind — the committed cursor: a failed flush lands neither, and on the
	 * next run the replay re-detects any un-flushed work.
	 */
	async commitCheckpoint(context?: { scopeFingerprint?: string }): Promise<void> {
		if (!this.metadataStore) return;
		await this.cacheMutex.run(async () => {
			const scopeFingerprint = context?.scopeFingerprint ?? this._scopeFingerprint;
			await this.commitCache(scopeFingerprint);
			this._scopeFingerprint = scopeFingerprint;
		});
	}

	/**
	 * Write the complete final cache + cursor to the store. The snapshot is captured
	 * under `cacheMutex`, and `saveAll` atomically replaces both cache rows and metadata.
	 * This keeps the cache a complete, derived projection co-committed with the cursor;
	 * commit correctness never depends on tracking individual mutation paths.
	 */
	private async commitCache(scopeFingerprint: string | null): Promise<void> {
		const store = this.metadataStore;
		if (!store) return;
		await store.open();
		const meta = new Map<string, string>();
		if (this._changesPageToken !== null) meta.set(CURSOR_META_KEY, this._changesPageToken);
		if (scopeFingerprint !== null) meta.set(SCOPE_FINGERPRINT_META_KEY, scopeFingerprint);
		await store.saveAll(this.cache.exportRecords(), meta);
	}

	/**
	 * Read a meta key from the durable checkpoint without consulting the live working
	 * view. Missing or unreadable storage is conservatively treated as no committed
	 * value, which routes the next cycle through the ordinary cold path.
	 */
	private async peekCommittedMeta(key: string): Promise<string | null> {
		if (!this.metadataStore) return null;
		try {
			await this.metadataStore.open();
			return (await this.metadataStore.getMeta(key)) ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Whether a committed delta checkpoint exists. The orchestrator uses this to force
	 * a cold reconcile when there is none (first sync, or after a rescan). The cursor
	 * is co-located with the cache, so its presence is the checkpoint.
	 */
	async hasCheckpoint(): Promise<boolean> {
		return this.cacheMutex.run(async () => this.initialized
			? (await this.peekCommittedMeta(CURSOR_META_KEY)) !== null
			: this.loadFromCache());
	}

	/** Discard the live working view without mutating the durable checkpoint. */
	async abortWorkingView(): Promise<void> {
		await this.cacheMutex.run(() => {
			this._changesPageToken = null;
			this._scopeFingerprint = null;
			this._workingViewContentions = [];
			this.cache.clear();
			this.initialized = false;
		});
	}

	/**
	 * Discard the committed checkpoint (cursor + cache + scope fingerprint) so the next
	 * sync cold-reconciles. Used by the Rescan action and an identity change. Losing the
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
			this._scopeFingerprint = null;
			this._workingViewContentions = [];
			this.cache.clear();
			this.initialized = false;
		});
	}

	/**
	 * The scope fingerprint committed with the last clean cycle, or `null` if none was
	 * ever committed. Like {@link hasCheckpoint}, this reports durable state rather than
	 * the current attempt's live working view.
	 */
	async getScopeFingerprint(): Promise<string | null> {
		return this.cacheMutex.run(async () => {
			if (!this.initialized && !(await this.loadFromCache())) return null;
			return this.peekCommittedMeta(SCOPE_FINGERPRINT_META_KEY);
		});
	}

	// ── Incremental replay + 410 full-scan-and-diff fallback ──

	/** Apply incremental changes from the current cursor (caller ensured init + holds mutex). */
	private async _applyIncrementalChanges(): Promise<RemoteDelta | null> {
		if (!this._changesPageToken) return null;

		const result = await this.fetchChanges(this._changesPageToken);

		if (result.needsFullScan) {
			// Cursor expired (e.g. Google Drive 410): snapshot-diff a fresh full scan for the delta.
			return this.fullScanWithDelta();
		}

		this._changesPageToken = result.newToken;
		const contended = result.contended ?? [];
		const displaced = displacedAddresses(contended);
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
			} else if (!displaced.has(path)) {
				// PRODUCER 1 of `deleted`. A path the drain vacated for a contention is
				// absent from the working view but present on the provider, so it is a
				// displacement, not an absence. An absence this cycle cannot attribute
				// to one is classified exactly as it always was.
				deleted.push(path);
			}
		}
		return { modified, deleted, renamed: result.renamedPaths, contended };
	}

	/**
	 * Full scan with delta computation (the cursor-expiry fallback): snapshot old
	 * paths-by-id, perform a fresh full scan, then diff old vs new by id.
	 *
	 * Only a replay reaches this, so a cursor exists — committed, or the one a fresh
	 * scan earlier in this working view captured. Either way the snapshot is a view,
	 * and an empty one is a view with nothing in it: everything the scan finds is new,
	 * not an initial sync with no delta, and the scan's contentions must reach the
	 * cycle.
	 */
	private async fullScanWithDelta(): Promise<RemoteDelta> {
		// Snapshot before fullScan() overwrites the cache.
		const oldPathById = this.cache.snapshotPathsById();
		const contended = await this.fullScan();
		return this.diffById(oldPathById, contended);
	}

	/**
	 * Compute a remote delta by diffing a pre-scan path-by-id snapshot against the
	 * freshly-scanned cache. Keys on backend id, so it detects adds/deletes/renames but
	 * NOT in-place content edits (same path+id); those are caught by the next incremental
	 * sync or WARM mode's local-vs-record check.
	 *
	 * A folder that moved out of, or into, a path other folders share is not reported
	 * as a folder rename — the rule the incremental drain follows too. The vault holds
	 * one folder at such a path and that folder did not move; only this folder's own
	 * contents did, and each of them is reported here as its own move. Its old path is
	 * changed, not deleted, for as long as another folder still holds it.
	 */
	private diffById(
		oldPathById: Map<string, string>,
		contended: readonly AddressDisplacement[],
	): RemoteDelta {
		const displacedIds = new Set(contended.map((fact) => fact.withheldId));
		const displaced = displacedAddresses(contended);
		const modified = new Set<string>();
		const deleted = new Set<string>();
		const renamed: RenamePair[] = [];
		// Every id the scan placed, merged folders included: a folder merged beside
		// another is live, and missing it here would sweep its old path as deleted.
		const newPathById = this.cache.snapshotPathsById();
		const sharedBefore = sharedPaths(oldPathById);
		const acrossShared = (oldPath: string, newPath: string) => this.cache.isFolder(newPath) &&
			(sharedBefore.has(oldPath) || this.cache.idsAt(newPath).length > 1);
		for (const [id, newPath] of newPathById) {
			const oldPath = oldPathById.get(id);
			if (!oldPath) {
				modified.add(newPath);
			} else if (oldPath !== newPath && acrossShared(oldPath, newPath)) {
				modified.add(newPath);
				(this.cache.hasFile(oldPath) ? modified : deleted).add(oldPath);
			} else if (oldPath !== newPath) {
				// `id` is the cache's ADDRESS for this entry (it may be a synthetic
				// fallback); the reported identity comes from the entity projection only.
				renamed.push({
					oldPath,
					newPath,
					isFolder: this.cache.isFolder(newPath) || undefined,
					identityKey: projectedIdentityKey(this.cache, newPath),
				});
				modified.add(newPath);
				deleted.add(oldPath);
			}
		}
		// PRODUCER 2 of `deleted`: the vanished-id sweep, the route a cursor expiry
		// takes and the one measured to reach `delete_local`. An id the scan withheld,
		// and every path that went with it, vanished from the cache because another
		// claimant took its address — not because the provider dropped it. A folder
		// that vanished from a path it shared leaves that path to the others.
		for (const [id, oldPath] of oldPathById) {
			if (newPathById.has(id) || displacedIds.has(id) || displaced.has(oldPath)) continue;
			(sharedBefore.has(oldPath) && this.cache.hasFile(oldPath) ? modified : deleted).add(oldPath);
		}
		if (modified.size > 0 || deleted.size > 0 || renamed.length > 0) {
			this.logger?.info("Full scan delta", {
				added: modified.size - renamed.length,
				deleted: deleted.size - renamed.length,
				renamed: renamed.length,
			});
		}
		return { modified: [...modified], deleted: [...deleted], renamed, contended };
	}

	/**
	 * Return paths changed since the last committed cursor. Returns null on the initial
	 * sync (a fresh full scan just captured "now", so there is no delta).
	 */
	async getChangedPaths(): Promise<RemoteDelta | null> {
		return this.cacheMutex.run(async () => {
			const replay = await this.ensureInitialized();
			return replay ? this._applyIncrementalChanges() : null;
		});
	}

	async listCurrentSnapshot(): Promise<FileEntity[]> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			return this.snapshotEntities();
		});
	}

	private async observePriority(request: PriorityObservationRequest): Promise<PriorityObservation> {
		const path = normalizeSyncPath(request.path);
		return observeDetachedPriority({ ...request, path }, {
			fetchIdentity: (identityKey) => this.fetchCurrentFile(identityKey),
			fetchPath: (requestedPath) => this.fetchCurrentPath(requestedPath),
			resolvePath: async (file) => {
				const resolved = await this.resolveDetachedPath(file);
				return resolved ? normalizeSyncPath(resolved) : null;
			},
			toEntity: (requestedPath, file) => this.toDetachedEntity(requestedPath, file),
			versionToken: (file) => this.detachedVersionToken(file),
		});
	}

	private async readPriority(
		observation: Extract<PriorityObservation, { kind: "current" }>,
	): Promise<PriorityReadResult> {
		return readDetachedPriority(
			observation,
			(identityKey) => this.downloadForPriority(identityKey),
			(request) => this.observePriority(request),
		);
	}

	// ── Read-only ops (walk the cache) ──

	async list(): Promise<FileEntity[]> {
		return this.cacheMutex.run(async () => {
			// A fresh full scan captures "now"; a restored cursor warrants a replay.
			if (await this.ensureInitialized()) {
				// The replay's paths are superseded by the listing this returns, but its
				// contentions are not: they are facts about this working view, and this
				// path-level call has nowhere else to put them. A cycle that lists instead
				// of asking for a delta — COLD with a checkpoint standing, as after a scope
				// change — would otherwise report none.
				const delta = await this._applyIncrementalChanges();
				if (delta && delta.contended.length > 0) {
					this._workingViewContentions = [...this._workingViewContentions, ...delta.contended];
				}
			}
			return this.snapshotEntities();
		});
	}

	private snapshotEntities(): FileEntity[] {
		return Array.from(this.cache.entries(), ([path, file]) =>
			this.cache.toEntity(path, file),
		);
	}

	/**
	 * Return cached metadata for a path. hash is always "" — the sync engine should use
	 * remoteChecksum for content-change detection. Does not replay here because list()
	 * already applies incremental changes before returning the full file list, and
	 * stat() is only called after list() has refreshed the cache.
	 */
	async stat(path: string): Promise<FileEntity | null> {
		path = normalizeSyncPath(path);
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const file = this.cache.getFile(path);
			if (!file) return null;
			return this.cache.toEntity(path, file);
		});
	}

	/** Download file content. Like stat(), relies on list() having refreshed the cache. */
	async read(path: string): Promise<ArrayBuffer> {
		path = normalizeSyncPath(path);
		// Phase 1: resolve the backend id under the mutex.
		const fileId = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			if (this.cache.isFolder(path)) {
				throw new Error(`Not a file (is a directory): ${path}`);
			}
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
		path = normalizeSyncPath(path);
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
		path = normalizeSyncPath(path);
		// Phase 1: resolve the backend id under the mutex — and, for a vault folder that
		// several provider folders make up, every one of theirs.
		const { fileId, mergedIds } = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			return { fileId: this.cache.idAt(path) ?? null, mergedIds: this.cache.idsAt(path).slice(1) };
		});

		if (!fileId) return;

		// Phase 2: remote delete outside the mutex (network I/O). The vault folder is
		// all of them, so deleting only the representative would bring the rest back.
		for (const id of mergedIds) await this.deleteRemote(id);
		await this.deleteRemote(fileId);

		// Phase 3: update the cache under the mutex with an id guard — the inline twin of
		// withCacheMutex's CAS (delete needs no `update` callback, so it guards here). This
		// guard is ACTIVE: delete_remote is now POOLED in the structural phase (ADR 0001, T7),
		// so a folder delete and an overlapping descendant delete can run concurrently. If the
		// folder's removeTree evicted this path during phase 2, idAt no longer matches fileId,
		// so we skip the stale removeTree (the path is already gone) rather than corrupt the
		// cache. (The common case short-circuits earlier: a child whose entry was already
		// evicted resolves no id at phase 1 and never reaches the network delete.)
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
