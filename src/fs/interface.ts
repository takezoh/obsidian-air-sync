import type { FileEntity } from "./types";
import type { RenamePair } from "./types";
import type { PriorityObservationCapability } from "./priority-observation";
import type { AddressDisplacement } from "./caching/claim-set-assignment";

/**
 * Abstract filesystem interface for sync operations.
 *
 * **Path conventions:**
 * - All paths are relative to the sync root (e.g. `"notes/hello.md"`).
 * - No leading or trailing slashes.
 * - Forward slash (`/`) as separator regardless of platform.
 */
export interface IFileSystem {
	/** Human-readable name for this filesystem (e.g. "local", "googledrive") */
	readonly name: string;

	/**
	 * List all files and directories recursively from the root.
	 *
	 * Returned `FileEntity.hash` may be `""` (not computed) for performance;
	 * use `stat()` when an accurate hash is needed.
	 */
	list(): Promise<FileEntity[]>;

	/**
	 * Get metadata for a single path, or `null` if it doesn't exist.
	 *
	 * Implementations should compute `hash` here when feasible.
	 * Remote backends may return `hash: ""` if they provide an equivalent
	 * `remoteChecksum` for change detection.
	 */
	stat(path: string): Promise<FileEntity | null>;

	/** Detached, identity-addressed file-open observation; never consumes global delta state. */
	priority?: PriorityObservationCapability;

	/**
	 * Read file content as ArrayBuffer.
	 *
	 * @throws if the path does not exist or is a directory.
	 */
	read(path: string): Promise<ArrayBuffer>;

	/**
	 * Write (create or overwrite) a file. Returns the resulting FileEntity.
	 *
	 * Parent directories are created automatically.
	 * Writing to a path that is a directory results in an error.
	 *
	 * @param mtime — Unix epoch ms to set as the file's modification time.
	 */
	write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity>;

	/**
	 * Create a directory (and parents if needed). Returns the resulting FileEntity.
	 *
	 * Idempotent — calling on an existing directory is a no-op.
	 * @throws if an intermediate path component is an existing file.
	 */
	mkdir(path: string): Promise<FileEntity>;

	/**
	 * List immediate children of a directory.
	 *
	 * Returns an empty array if the directory is empty or does not exist.
	 * Only returns direct children — not recursive.
	 */
	listDir(path: string): Promise<FileEntity[]>;

	/**
	 * Delete a file or directory (including children).
	 *
	 * Idempotent — deleting a non-existent path is a no-op.
	 *
	 * **Note:** When deleting a directory, all child entries are removed
	 * recursively by the filesystem implementation. The caller is
	 * responsible for cleaning up any associated sync state (e.g.
	 * SyncRecords) for each child path.
	 *
	 * Implementation note: backends may use soft deletion (e.g. move to
	 * trash). Callers should treat the path as removed regardless of
	 * mechanism.
	 */
	delete(path: string): Promise<void>;

	/**
	 * Rename / move a file or directory (including children).
	 *
	 * Parent directories are created automatically.
	 *
	 * @throws if `oldPath` does not exist.
	 * @throws if `newPath` already exists.
	 */
	rename(oldPath: string, newPath: string): Promise<void>;

	/**
	 * The backend's incremental delta cursor + crash-safe checkpoint (see
	 * {@link IncrementalCheckpoint} for what travels together and why), or `undefined`
	 * for backends without incremental sync (e.g. the local vault). Check `fs.checkpoint`
	 * once; its presence guarantees every method on the capability.
	 */
	checkpoint?: IncrementalCheckpoint;

	/**
	 * Rename a provider object addressed by its own stable id (see
	 * {@link IdentityAddressedRename}), or `undefined` for a backend that cannot
	 * produce the condition it repairs. Consulted for presence exactly like
	 * {@link checkpoint} — `fs.identityRename` once, never a test on `fs.name`.
	 */
	identityRename?: IdentityAddressedRename;

	/**
	 * Release resources (e.g. close IndexedDB connections).
	 * Called on plugin unload. Optional — not all backends need cleanup.
	 */
	close?(): Promise<void>;
}

/**
 * Renaming a provider object the cache is deliberately not holding.
 *
 * {@link IFileSystem.rename} is path-addressed, and the object a namespace repair
 * has to move is precisely the one with no cache path — that is what losing a
 * contended address means. Renaming the *addressable* claimant instead would move
 * the wrong object, so the addressing input is the provider's own id.
 *
 * Optional, in the shape {@link IFileSystem.checkpoint} already uses: a backend
 * either offers the capability or does not, and its absence means no repair is
 * planned — never a silent path-addressed fallback. Only Google Drive implements
 * it today, because only Google Drive can produce two live objects at one derived
 * address.
 */
export interface IdentityAddressedRename {
	/**
	 * Rename the object with `identityKey` so it is addressed by `newPath`.
	 *
	 * `admittedPath` is the source address Admission observed the object at when
	 * it decided the repair. The call fails closed if the object is no longer
	 * addressed there: a post-Admission move must not let a fresh observation
	 * justify renaming an object at a different location.
	 *
	 * Only the final segment moves: the object keeps the provider parent it
	 * already has, which is exactly what disambiguating two claimants of one
	 * address needs. `newPath`'s parent segments are the caller's statement of
	 * where the object already is; they are not used to re-parent it.
	 *
	 * The cache is updated from the provider's answer to this call and from
	 * nothing else — the target address is never written in advance.
	 *
	 * @throws if the provider refuses the rename, the object no longer exists, or
	 * it is no longer addressed by `admittedPath`.
	 */
	renameById(identityKey: string, admittedPath: string, newPath: string): Promise<void>;
}

/**
 * A backend's incremental-sync capability: a delta cursor for change detection and a
 * crash-safe, atomically-committed checkpoint (ADR 0001). Exposed as one object on
 * {@link IFileSystem.checkpoint} so the five core methods travel together — a backend
 * that can detect deltas (`getChangedPaths`) MUST also expose the full checkpoint
 * lifecycle (`hasCheckpoint`/`abortWorkingView`/`resetCheckpoint`/`commitCheckpoint`), because a
 * half-implementation would silently degrade crash recovery. The type enforces
 * all-or-nothing for those five (B1-3).
 *
 * `getScopeFingerprint` is a later, orthogonal addition and stays OPTIONAL: real
 * backends (`CachingRemoteFs`) always implement it, but a test double that only
 * needs the core five methods can omit it — the sync engine treats a missing
 * `getScopeFingerprint` as "this capability doesn't track scope", not as a
 * mismatched fingerprint, and skips the scope-change check entirely rather than
 * forcing a spurious cold reconcile.
 */
export interface IncrementalCheckpoint {
	/**
	 * Return paths changed since the last sync, or null if unavailable.
	 * Should be called before list() to allow the change-detector to skip
	 * unchanged paths. Returns modified, deleted, and optionally renamed path lists.
	 *
	 * `contended` reports the derived addresses this cycle found claimed by two live
	 * ids. It is a FACT ABOUT THIS CYCLE, not a deletion and not an instruction: the
	 * backend has already subtracted those addresses from `deleted`, because an
	 * object that lost an address is still on the provider. Nothing above the
	 * filesystem decides an absence, so no caller may move a path from here into
	 * `deleted`. Optional: a backend whose addresses are the provider's own keys
	 * cannot produce one.
	 */
	getChangedPaths(): Promise<{
		modified: string[];
		deleted: string[];
		renamed?: RenamePair[];
		contended?: readonly AddressDisplacement[];
	} | null>;

	/**
	 * Return the cache state produced by the most recent `getChangedPaths()` call
	 * without fetching or applying another delta page. Folder-rename recovery uses
	 * this to inspect the whole moved subtree while keeping one cursor/evidence
	 * boundary. Optional for non-caching/test implementations; callers that require
	 * it must fail closed rather than fall back to `IFileSystem.list()`.
	 */
	listCurrentSnapshot?(): Promise<FileEntity[]>;

	/**
	 * Take the contentions the current working view was built with, leaving none
	 * behind.
	 *
	 * `getChangedPaths` reports what a delta it RETURNS found. A working view is also
	 * built by path-level calls (`list`, `stat`) that have nowhere to return an
	 * address-level fact: a lazily-entered full scan, and the cursor replay `list()`
	 * performs on a restored checkpoint. Without this, a cycle acquiring its remote
	 * side by listing — COLD, with or without a checkpoint — reports no contention at
	 * all, and an address the cache could not seat stays silently absent for as long
	 * as the checkpoint stands.
	 *
	 * Draining is what keeps the two channels from double-reporting: a delta that is
	 * returned carries its own contentions and leaves nothing here.
	 * Optional, for the same reason `getChangedPaths`'s `contended` is: a backend
	 * whose addresses are the provider's own keys can never produce one.
	 */
	drainWorkingViewContentions?(): readonly AddressDisplacement[];

	/**
	 * Whether a committed incremental checkpoint (delta cursor) exists. When false,
	 * the sync engine cannot trust delta-based remote detection — the last sync never
	 * completed, or was reset — so it forces a full cold reconcile. The cursor is
	 * stored with the backend's own cache (not in settings), so this is async.
	 */
	hasCheckpoint(): Promise<boolean>;

	/**
	 * Discard only the uncommitted in-memory cache/cursor/scope view. The durable
	 * checkpoint and provider are unchanged; the next ordinary access restores the
	 * last committed checkpoint, or performs a fresh scan when none exists.
	 */
	abortWorkingView(): Promise<void>;

	/**
	 * Discard the committed checkpoint (delta cursor + any derived cache) so the next
	 * sync does a full cold reconcile. Used by the Rescan action. Losing the
	 * checkpoint is safe — a cold list × baseline join re-derives every change. Also
	 * discards the committed scope fingerprint (see {@link getScopeFingerprint}) —
	 * a rescan resets everything the checkpoint tracks.
	 */
	resetCheckpoint(): Promise<void>;

	/**
	 * Flush the committed checkpoint — the delta cursor AND any derived cache — to the
	 * backend's own store, atomically (one transaction; see ADR 0001). Called by the
	 * sync engine ONLY after a fully-successful cycle (failed === 0); a failed cycle
	 * leaves cache+cursor at the last committed state so the next run re-detects the
	 * un-synced work. Lives on the FS (not the provider) so the engine never has to
	 * downcast.
	 *
	 * `context.scopeFingerprint`, when given, is persisted alongside the cursor in the
	 * SAME transaction (see {@link getScopeFingerprint}). Omitting it leaves the
	 * previously-committed fingerprint untouched.
	 */
	commitCheckpoint(context?: { scopeFingerprint?: string }): Promise<void>;

	/**
	 * The scope fingerprint committed with the last clean cycle, or `null` if none was
	 * ever committed (fresh checkpoint, or a checkpoint from before this field existed).
	 * The sync engine compares this against the CURRENT scope fingerprint
	 * (`computeScopeFingerprint`) to force one cold reconcile when a settings change
	 * has widened sync scope to include remote paths the delta cursor already passed —
	 * warm/hot detection would otherwise never surface them (see
	 * `src/sync/scope-fingerprint.ts`). `null` compares unequal to any real
	 * fingerprint, so it also drives the one-time cold reconcile that back-fills
	 * existing checkpoints predating this field. Optional — see the interface doc.
	 */
	getScopeFingerprint?(): Promise<string | null>;
}
