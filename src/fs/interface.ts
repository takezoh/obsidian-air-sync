import type { FileEntity } from "./types";
import type { RenamePair } from "./types";

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
	 * Release resources (e.g. close IndexedDB connections).
	 * Called on plugin unload. Optional — not all backends need cleanup.
	 */
	close?(): Promise<void>;
}

/**
 * A backend's incremental-sync capability: a delta cursor for change detection and a
 * crash-safe, atomically-committed checkpoint (ADR 0001). Exposed as one object on
 * {@link IFileSystem.checkpoint} so the four methods travel together — a backend that
 * can detect deltas (`getChangedPaths`) MUST also expose the full checkpoint lifecycle
 * (`hasCheckpoint`/`resetCheckpoint`/`commitCheckpoint`), because a half-implementation
 * would silently degrade crash recovery. The type enforces all-or-nothing (B1-3).
 */
export interface IncrementalCheckpoint {
	/**
	 * Return paths changed since the last sync, or null if unavailable.
	 * Should be called before list() to allow the change-detector to skip
	 * unchanged paths. Returns modified, deleted, and optionally renamed path lists.
	 */
	getChangedPaths(): Promise<{
		modified: string[];
		deleted: string[];
		renamed?: RenamePair[];
	} | null>;

	/**
	 * Whether a committed incremental checkpoint (delta cursor) exists. When false,
	 * the sync engine cannot trust delta-based remote detection — the last sync never
	 * completed, or was reset — so it forces a full cold reconcile. The cursor is
	 * stored with the backend's own cache (not in settings), so this is async.
	 */
	hasCheckpoint(): Promise<boolean>;

	/**
	 * Discard the committed checkpoint (delta cursor + any derived cache) so the next
	 * sync does a full cold reconcile. Used by the Rescan action. Losing the
	 * checkpoint is safe — a cold list × baseline join re-derives every change.
	 */
	resetCheckpoint(): Promise<void>;

	/**
	 * Flush the committed checkpoint — the delta cursor AND any derived cache — to the
	 * backend's own store, atomically (one transaction; see ADR 0001). Called by the
	 * sync engine ONLY after a fully-successful cycle (failed === 0); a failed cycle
	 * leaves cache+cursor at the last committed state so the next run re-detects the
	 * un-synced work. Lives on the FS (not the provider) so the engine never has to
	 * downcast.
	 */
	commitCheckpoint(): Promise<void>;
}
