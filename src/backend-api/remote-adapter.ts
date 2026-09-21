import type { JsonObject } from "./json";
import type { RemoteObject } from "./remote-object";

/**
 * The provider operation boundary a module implements (Backend Module API v1).
 *
 * A module does NOT implement the filesystem, metadata cache, cursor lifecycle,
 * scope fingerprint, or checkpoint. It reports provider facts and performs
 * provider mutations; core owns everything above this boundary.
 *
 * Every method that can paginate must either produce a complete result or fail:
 * a partial page, a partial object set, or an empty `nextCursor` must never be
 * published as complete.
 */
export interface RemoteBackendAdapter {
	/** The provider's current start cursor, taken BEFORE any full scan. */
	getStartCursor(): Promise<string>;
	/** A complete recursive snapshot of the bound root. */
	listAll(): Promise<readonly RemoteObject[]>;
	/** Confirm the bound root is alive; distinguish empty from gone/inaccessible. */
	assertRootAlive(): Promise<void>;
	/** Provider facts since `cursor`, or explicit cursor invalidation. */
	getChanges(cursor: string): Promise<RemoteChangeResult>;

	/** A detached current observation by stable id; `null` when absent. */
	getById(id: string): Promise<RemoteObject | null>;
	/** Detached current occupants of a provider-resolved path (may be several). */
	getByPath(path: string): Promise<readonly RemoteObject[]>;

	/** Read bytes bound to an observed object version. */
	read(input: VersionBoundReadInput): Promise<VersionBoundReadResult>;

	createFile(input: CreateFileInput): Promise<RemoteObject>;
	updateFile(input: UpdateFileInput): Promise<RemoteObject>;
	createDirectory(input: CreateDirectoryInput): Promise<RemoteObject>;
	move(input: MoveInput): Promise<RemoteObject>;
	delete(input: DeleteInput): Promise<void>;

	/**
	 * Non-authoritative provider/auth-derived state core may persist (e.g. a
	 * refreshed `accessTokenExpiry`). It is NOT identity, cursor, or sync truth:
	 * core treats it as an opaque settings-bag contribution, never as a decision
	 * input. Optional; a module without such state omits it.
	 */
	readState?(): Readonly<Record<string, unknown>> | undefined;
}

/** An object was created or changed. */
export interface RemoteChangeUpsert {
	readonly kind: "upsert";
	readonly object: RemoteObject;
}

/**
 * A deletion addressed by stable id — the only identity-safe form.
 * A provider that only reports a path must use {@link RemoteChangeDeleteByPath}
 * rather than minting a fake id.
 */
export interface RemoteChangeDeleteById {
	readonly kind: "delete";
	readonly id: string;
}

/** A deletion the provider only reported by resolved path. */
export interface RemoteChangeDeleteByPath {
	readonly kind: "delete";
	readonly path: string;
	readonly pathAuthority: "provider_resolved";
}

export type RemoteChange =
	| RemoteChangeUpsert
	| RemoteChangeDeleteById
	| RemoteChangeDeleteByPath;

/**
 * Complete provider delta from a cursor, or explicit invalidation. `cursor_invalid`
 * is NOT empty changes: core performs a full scan + identity diff and derives a
 * fresh usable cursor.
 */
export type RemoteChangeResult =
	| {
			readonly kind: "changes";
			readonly nextCursor: string;
			readonly changes: readonly RemoteChange[];
	  }
	| { readonly kind: "cursor_invalid" };

/** An observed object version a read must still correspond to. */
export interface ExpectedVersion {
	readonly id: string;
	readonly versionToken: string;
}

export interface VersionBoundReadInput {
	readonly id: string;
	readonly versionToken: string;
}

/**
 * A detached read result. A version mismatch or inability to prove the version
 * is never reported as success: core must not publish stale bytes as current.
 */
export type VersionBoundReadResult =
	| { readonly kind: "content"; readonly object: RemoteObject; readonly content: ArrayBuffer }
	| { readonly kind: "target_changed" }
	| { readonly kind: "unverifiable"; readonly reason: string };

/**
 * Where a mutation places its object. Exactly one addressing scheme is used,
 * matching the module's {@link RemoteLocation} form.
 */
export type DestinationAddress =
	| { readonly addressing: "parent_id"; readonly parentId: string | null; readonly name: string }
	| { readonly addressing: "provider_path"; readonly rootId: string; readonly path: string };

export interface CreateFileInput {
	readonly destination: DestinationAddress;
	readonly content: ArrayBuffer;
	readonly mtimeMs: number;
}

/** Update an existing object; `expected` fixes the source version (no unversioned overwrite). */
export interface UpdateFileInput {
	readonly id: string;
	readonly expected: ExpectedVersion;
	readonly content: ArrayBuffer;
	readonly mtimeMs: number;
}

export interface CreateDirectoryInput {
	readonly destination: DestinationAddress;
}

/** Identity-preserving move. A copy+delete is not an acceptable equivalent. */
export interface MoveInput {
	readonly id: string;
	readonly expected?: ExpectedVersion;
	readonly destination: DestinationAddress;
}

export interface DeleteInput {
	readonly id: string;
	readonly expected?: ExpectedVersion;
}

/** A module's JSON-safe per-connection configuration (the active backendData bag). */
export type BackendModuleConfig = Readonly<JsonObject>;
