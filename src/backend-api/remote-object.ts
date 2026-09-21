/**
 * The normalized remote object model (Backend Module API v3).
 *
 * Provider-native DTOs must not leak into core persistence or the sync engine.
 * A module projects each provider object to this shape; core builds `FileEntity`,
 * the metadata cache, and the identity index from it.
 *
 * The model is deliberately broader than a naive `{ id, name, parentId }`:
 * addressing is a discriminated union so Dropbox's stable-root + provider-path
 * scheme is not forced to invent a parent id it does not have, and an unknown
 * size/mtime is distinguishable from a real `0`.
 */
export type RemoteObjectKind = "file" | "directory";

/** Whether an object's provider path was resolved by the provider or only echoed from the request. */
export type RemotePathAuthority = "provider_resolved" | "requested_echo";

/** A content checksum the provider reports for an object's bytes. */
export interface RemoteChecksum {
	/** Algorithm id. Core-standard ids are reserved; a module's own ids are namespaced. */
	readonly algorithm: string;
	readonly value: string;
}

/**
 * How an object's position in the tree is addressed.
 *
 * `parent_id` covers Google Drive/OneDrive-style trees (`parentId === null`
 * means the bound root, and only the bound root). `provider_path` covers
 * Dropbox-style stable-root + resolved path, which has no parent id to report.
 */
export type RemoteLocation =
	| { readonly addressing: "parent_id"; readonly parentId: string | null }
	| { readonly addressing: "provider_path"; readonly rootId: string; readonly path: string };

/**
 * The one addressing scheme a provider uses. An adapter declares it so core
 * builds destinations without inferring the scheme from a backend id or waiting
 * for an observed object; the same union discriminant appears on every
 * {@link RemoteLocation} and every {@link DestinationAddress}.
 */
export type RemoteAddressing = RemoteLocation["addressing"];

interface RemoteObjectBase {
	/** Stable provider identity: unchanged by an identity-preserving rename/move. */
	readonly id: string;
	/** Final path segment, as the provider resolves it. */
	readonly name: string;
	readonly location: RemoteLocation;
	readonly pathAuthority?: RemotePathAuthority;
	/** Byte size when known; absent means unknown, and `0` is a real size. */
	readonly size?: number;
	/** Modification time in epoch ms when known; absent means unknown. */
	readonly mtimeMs?: number;
	/**
	 * Temporal/race evidence for detached reads and conditional mutations. It is
	 * NOT a content checksum and never substitutes for one.
	 */
	readonly versionToken?: string;
}

export interface RemoteFileObject extends RemoteObjectBase {
	readonly kind: "file";
	/** Locally reproducible content checksum for a regular synchronizable file. */
	readonly checksum?: RemoteChecksum;
}

export interface RemoteDirectoryObject extends RemoteObjectBase {
	readonly kind: "directory";
}

export type RemoteObject = RemoteFileObject | RemoteDirectoryObject;

/** Narrowing helper for the file variant. */
export function isRemoteFile(object: RemoteObject): object is RemoteFileObject {
	return object.kind === "file";
}

/** Narrowing helper for the directory variant. */
export function isRemoteDirectory(object: RemoteObject): object is RemoteDirectoryObject {
	return object.kind === "directory";
}
