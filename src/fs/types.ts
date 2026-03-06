/** Represents a file or folder entity from any filesystem */
export interface FileEntity {
	/** Relative path from the sync root (e.g. "notes/hello.md") */
	path: string;
	/** True if this entity is a directory */
	isDirectory: boolean;
	/** File size in bytes (0 for directories) */
	size: number;
	/**
	 * Last modification time as Unix epoch ms.
	 *
	 * Sentinel value `0` means "unknown" — typically for directories
	 * or backends that don't expose mtime. Comparisons should treat
	 * `0` as "no data" rather than the epoch.
	 */
	mtime: number;
	/**
	 * Content hash (SHA-256 hex).
	 *
	 * Sentinel value `""` means "not computed". `list()` may omit
	 * hash computation for performance; use `stat()` when an
	 * accurate hash is needed. Always `""` for directories.
	 */
	hash: string;
	/** Backend-specific metadata (e.g. Drive file ID, contentChecksum) */
	backendMeta?: Record<string, unknown>;
}
