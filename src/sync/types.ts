import type { FileEntity } from "../fs/types";

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
	/** Backend-specific metadata snapshot (e.g. Drive contentChecksum) */
	backendMeta?: Record<string, unknown>;
	/** Timestamp when this sync completed (Unix epoch ms) */
	syncedAt: number;
}

/** Combined view of a path across local, remote, and previous sync state */
export interface MixedEntity {
	path: string;
	local?: FileEntity;
	remote?: FileEntity;
	prevSync?: SyncRecord;
}

/** User-facing strategy for resolving conflicts */
export type ConflictStrategy = "auto_merge" | "duplicate" | "ask";

/** A record of a conflict resolution for audit/history purposes */
export interface ConflictRecord {
	path: string;
	actionType: SyncActionType;
	strategy: ConflictStrategy;
	action: "kept_local" | "kept_remote" | "duplicated" | "merged";
	local?: FileEntity;
	remote?: FileEntity;
	duplicatePath?: string;
	hasConflictMarkers?: boolean;
	resolvedAt: string;
	sessionId: string;
}

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

/** Shared fields across all sync actions */
interface SyncActionBase {
	path: string;
	local?: FileEntity;
	remote?: FileEntity;
	baseline?: SyncRecord;
}

/** Standard sync action (all types except rename actions) */
export interface StandardSyncAction extends SyncActionBase {
	action: Exclude<SyncActionType, "rename_remote" | "rename_local">;
}

/** Rename action (local or remote) — oldPath is required */
export interface RenameAction extends SyncActionBase {
	action: "rename_remote" | "rename_local";
	oldPath: string;
}

/** A single planned action for a path */
export type SyncAction = StandardSyncAction | RenameAction;

/** Result of safety checks before execution */
export interface SafetyCheckResult {
	shouldAbort: boolean;
	requiresConfirmation: boolean;
	deletionRatio?: number;
	deletionCount?: number;
}

/** The full sync plan */
export interface SyncPlan {
	actions: SyncAction[];
	safetyCheck: SafetyCheckResult;
}
