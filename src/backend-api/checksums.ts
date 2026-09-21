/**
 * A content-checksum algorithm a module can reproduce locally (API v1).
 *
 * Core uses the registered algorithm to compare local bytes against a
 * `RemoteObject.checksum` WITHOUT downloading remote content. A provider version
 * token, opaque identifier, mtime, or size never satisfies content equality.
 *
 * Algorithm ids are globally namespaced (`<module-id>:<algorithm>`) except for
 * the core-standard ids (sha256/sha1/md5) and the existing compatibility ids
 * (dropbox/quickxor), which are reserved by core.
 */
export interface BackendChecksumAlgorithm {
	readonly id: string;
	digest(content: ArrayBuffer): Promise<string>;
}
