/**
 * Algorithm id of a remote-provided content checksum.
 *
 * Core-standard ids are `"sha256"`, `"sha1"`, `"md5"`, `"dropbox"` (Dropbox's
 * 4 MiB-block SHA-256 tree), and `"quickxor"` (Microsoft QuickXorHash base64).
 * `"opaque"` is a backend-internal value that cannot be reproduced locally.
 *
 * A backend module may declare additional namespaced ids
 * (`<module-id>:<algorithm>`). Locally-reproducibility and digest computation are
 * resolved by the injected `ChecksumRegistry` (`registry.has` / `registry.compute`),
 * NOT by a fixed switch or a type union — an unregistered id fails closed.
 */
export type ChecksumAlgo = string;

/** A content checksum provided by a remote backend, tagged with its algorithm. */
export interface RemoteChecksum {
	algo: ChecksumAlgo;
	value: string;
}

/** Whether an entity path was resolved by the producer or merely echoed from the request. */
export type PathAuthority = "actual_resolved" | "requested_echo";

/** Represents a file or folder entity from any filesystem */
export interface FileEntity {
	/** Relative path from the sync root (e.g. "notes/hello.md") */
	path: string;
	/** Producer-qualified authority for `path`; absence is not proof of resolved spelling. */
	pathAuthority?: PathAuthority;
	/** Opaque identity stable only within this configured filesystem/root. */
	identityKey?: string;
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
	 * instead (e.g. Google Drive md5, pCloud's opaque content hash). The sync engine
	 * uses it for temporal change detection (remote-now vs last-sync) and, when
	 * the algo is locally computable (not `"opaque"`), for cross-side dedup.
	 */
	remoteChecksum?: RemoteChecksum;
	/** Backend-specific metadata the sync engine does not interpret (e.g. Google Drive/pCloud file ID) */
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
	/**
	 * The producing filesystem's own `FileEntity` projection for `newPath` — i.e. the
	 * `identityKey` a `stat`/`list` of the moved object reports, and nothing else.
	 *
	 * Optional by contract, not by accident: a producer that has no projected identity
	 * for `newPath` omits the field, and a missing key is *no evidence* (ADR 0008's
	 * third state) rather than a failure. Nothing infers, defaults, or substitutes a
	 * value for an absent one.
	 *
	 * Forbidden sources for anything that crosses the `IFileSystem` boundary:
	 * `AbstractMetadataCache.extractId`, `idAt`, `getPathById` and `snapshotPathsById`.
	 * Those are cache-internal *address* functions and are deliberately total — Dropbox's
	 * `extractId` is `entry.id ?? entry.path_lower`, where the fallback is a real download
	 * address — while the entity projection carries the provider's object id with no
	 * fallback. The two are not defined to agree, so a synthetic address must never
	 * escape the cache dressed as an identity.
	 */
	identityKey?: string;
}
