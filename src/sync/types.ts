import type { FileEntity, RemoteChecksum, RenamePair } from "../fs/types";

/** A stored record of the last-known synced state for a file */
export interface SyncRecord {
	/** Relative path (primary key) */
	path: string;
	/** Content hash at last successful sync */
	hash: string;
	/** Local mtime at last successful sync (Unix epoch ms) */
	localMtime: number;
	/** Remote mtime at last successful sync (Unix epoch ms) */
	remoteMtime: number;
	/** Local file size at last successful sync */
	localSize: number;
	/** Remote file size at last successful sync */
	remoteSize: number;
	/** Remote-provided content checksum at last successful sync (for change detection) */
	remoteChecksum?: RemoteChecksum;
	/** Opaque remote identity observed at last sync; comparable only within one configured remote root */
	remoteIdentityKey?: string;
	/** Backend-specific metadata snapshot the sync engine does not interpret (e.g. Google Drive/pCloud file ID) */
	backendMeta?: Record<string, unknown>;
	/** Timestamp when this sync completed (Unix epoch ms) */
	syncedAt: number;
}

/** Exact record expectations for one admitted successful path relocation. */
export interface RecordRelocation {
	readonly source: SyncRecord;
	readonly destination: SyncRecord | undefined;
	readonly terminal: SyncRecord;
}

/** Combined view of a path across local, remote, and previous sync state */
export interface MixedEntity {
	path: string;
	local?: FileEntity;
	remote?: FileEntity;
	prevSync?: SyncRecord;
}

export type SyncSide = "local" | "remote";

export type ScopeDisposition = "included" | "mobile_deferred" | "unknown";

export interface ScopeProjection {
	byEndpoint: ReadonlyMap<string, ScopeDisposition>;
	/** Inclusion compatibility only; never identity or rename authorization. */
	isConfiguredScopeCompatible(this: void, from: string, to: string): boolean;
}

export type PathObservation =
	| { kind: "exact"; side: SyncSide; requestedPath: string; entity: FileEntity }
	| { kind: "alias"; side: SyncSide; requestedPath: string; resolvedPath: string; entity: FileEntity }
	| {
		kind: "present_unresolved";
		side: SyncSide;
		requestedPath: string;
		returnedPath: string;
		entity: FileEntity;
		source: "list" | "stat";
	}
	| { kind: "absent"; side: SyncSide; requestedPath: string; authority: "stat" | "checkpoint_deleted" }
	| { kind: "unknown"; side: SyncSide; requestedPath: string; reason: "not_observed" | "outside_tracked_root" };

/** Frozen occupancy and requested-key baseline for one deterministic cover destination. */
export interface CandidateFact {
	readonly requestedPath: string;
	readonly local: PathObservation;
	readonly remote: PathObservation;
	/** Required lookup result: null proves the requested key was read and absent. */
	readonly baseline: SyncRecord | null;
}

export interface EntityOccurrence {
	side: SyncSide;
	phase: "baseline" | "current";
	path: string;
	identityKey?: string;
}

export interface RenameEvidence {
	kind: "rename";
	side: SyncSide;
	oldPath: string;
	newPath: string;
	isFolder: boolean;
	authority: "reported";
	identityKey?: string;
}

export type LocalRenameEvidence = RenameEvidence & { side: "local" };

export type IdentityEvidence =
	| RenameEvidence
	| { kind: "alias"; side: SyncSide; requestedPath: string; resolvedPath: string }
	| { kind: "stable_identity"; side: "remote"; identityKey: string; occurrences: readonly EntityOccurrence[] };

/** User-facing strategy for resolving conflicts */
export type ConflictStrategy = "auto_merge" | "duplicate";

/** A record of a conflict resolution for audit/history purposes */
export interface ConflictRecord {
	path: string;
	actionType: SyncActionType;
	strategy: ConflictStrategy;
	action: "kept_local" | "kept_remote" | "duplicated" | "merged";
	local?: FileEntity;
	remote?: FileEntity;
	duplicatePath?: string;
	/** Ordered preservation outputs; duplicatePath remains the first for compatibility. */
	duplicatePaths?: readonly string[];
	hasConflictMarkers?: boolean;
	resolvedAt: string;
	sessionId: string;
}

// RenamePair is part of the IFileSystem contract, so its canonical home is
// fs/types (imported above). Re-exported here for the sync engine's many
// consumers, keeping the fs/ → sync/ dependency from inverting.
export type { RenamePair };

/** Sync service status */
export type SyncStatus = "idle" | "syncing" | "error" | "partial_error" | "not_connected";

/** Action types produced by the decision engine and optimizer */
export type SyncActionType =
	| "push"
	| "pull"
	| "delete_local"
	| "delete_remote"
	| "rename_remote"
	| "rename_local"
	| "conflict"
	| "match"
	| "cleanup";

/** Exact admitted record expectations; comparison history is kept separately. */
export interface RecordPublication {
	readonly source: SyncRecord | undefined;
	readonly destination: SyncRecord | undefined;
}

export interface ObservedEndpoint {
	readonly side: SyncSide;
	readonly entity: FileEntity;
}

export interface PreservationCoverChild {
	readonly source: ObservedEndpoint;
	readonly content: { readonly sha256: string; readonly size: number };
	readonly candidatePath: string;
	readonly expectedLocal: FileEntity | null;
	readonly expectedRemote: FileEntity | null;
	readonly missingSides: readonly SyncSide[];
	readonly publication: RecordPublication;
}

export interface ExactRecordCleanup {
	readonly path: string;
	readonly expected: SyncRecord;
}

export type ConflictProtocol =
	| { readonly kind: "same_path" }
	| {
		readonly kind: "preservation_cover";
		readonly collisionWitnesses: readonly PathObservation[];
		/** Stable child order for terminal/audit projection. */
		readonly candidatePaths: readonly string[];
		/** Candidates already proven two-sided and published by current facts. */
		readonly preservedPaths: readonly string[];
		readonly children: readonly PreservationCoverChild[];
		readonly cleanup: readonly ExactRecordCleanup[];
	};

/** A fixed rename protocol, not a programmable sequence of filesystem steps. */
export type RenameContent =
	| { readonly mode: "equal" }
	| {
		readonly mode: "copy";
		readonly read: ObservedEndpoint;
		readonly write: { readonly side: SyncSide; readonly path: string };
	};

/** Shared fields across all sync actions */
interface SyncActionBase {
	path: string;
	local?: FileEntity;
	remote?: FileEntity;
	baseline?: SyncRecord;
	/** Exact publication expectations captured by Admission, not comparison policy. */
	publication?: RecordPublication;
	/** Actual endpoint addresses may differ while a parent transition is pending. */
	localPath?: string;
	remotePath?: string;
	/** Exact current identity source and a distinct protected destination version. */
	remoteIdentitySource?: FileEntity;
	additionalRemote?: FileEntity;
	/** A distinct local destination version that must survive replacement. */
	additionalLocal?: FileEntity;
	/** Closed conflict execution contract. Omitted only on legacy same-path actions. */
	protocol?: ConflictProtocol;
}

/** Standard sync action (all types except rename actions) */
export interface StandardSyncAction extends SyncActionBase {
	action: Exclude<SyncActionType, "rename_remote" | "rename_local">;
}

/** Rename action (local or remote) — oldPath is required */
export interface RenameAction extends SyncActionBase {
	action: "rename_remote" | "rename_local";
	oldPath: string;
	/** When true, oldPath/path are folder paths and descendants lists affected children */
	isFolder?: boolean;
	/** Descendant path mappings consumed by this folder rename */
	descendants?: RenamePair[];
	content?: RenameContent;
	/** Fixed child-before-parent publication dependencies, never a general graph. */
	descendantRecords?: readonly {
		readonly oldPath: string;
		readonly newPath: string;
		readonly source: SyncRecord | undefined;
		readonly destination: SyncRecord | undefined;
		readonly after?: SyncAction;
	}[];
}

/** A single planned action for a path */
export type SyncAction = StandardSyncAction | RenameAction;

/** The full sync plan */
export interface SyncPlan {
	actions: SyncAction[];
}
