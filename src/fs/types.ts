/**
 * Algorithm of a remote-provided content checksum.
 *
 * `"dropbox"` is Dropbox's `content_hash`: the file is split into 4 MiB blocks,
 * each block is SHA-256'd, the raw block digests are concatenated, and the
 * concatenation is SHA-256'd (hex). Unlike `"opaque"` it IS reproducible from
 * local content, so it powers cross-side dedup; it is distinct from `"sha256"`
 * (a plain hash of the whole file), hence its own algo tag.
 *
 * `"quickxor"` is Microsoft's QuickXorHash (base64) — the only content hash a
 * personal OneDrive returns. Like `"dropbox"` it IS reproducible from local
 * content (see {@link ../utils/quickxor}), so it powers cross-side dedup.
 *
 * `"opaque"` is a backend-internal value (e.g. pCloud's content hash) that
 * cannot be reproduced from local content.
 */
export type ChecksumAlgo = "md5" | "sha1" | "sha256" | "dropbox" | "quickxor" | "opaque";

/** A content checksum provided by a remote backend, tagged with its algorithm. */
export interface RemoteChecksum {
	algo: ChecksumAlgo;
	value: string;
}

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
	/**
	 * Remote-provided content checksum, tagged with its algorithm.
	 *
	 * Remote backends that return `hash: ""` expose a stable checksum here
	 * instead (e.g. Drive md5, pCloud's opaque content hash). The sync engine
	 * uses it for temporal change detection (remote-now vs last-sync) and, when
	 * the algo is locally computable (not `"opaque"`), for cross-side dedup.
	 */
	remoteChecksum?: RemoteChecksum;
	/** Backend-specific metadata the sync engine does not interpret (e.g. Drive/pCloud file ID) */
	backendMeta?: Record<string, unknown>;
}

/**
 * A rename pair: source and destination paths. Part of the filesystem contract
 * (it appears in `IFileSystem.getChangedPaths`), so it lives here in `fs/`; the
 * sync engine re-exports it from `sync/types` for its own consumers.
 */
export interface RenamePair {
	oldPath: string;
	newPath: string;
	/** When true, this pair represents a folder rename (not a file rename) */
	isFolder?: boolean;
}
