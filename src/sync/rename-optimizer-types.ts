import type { RenamePair, SyncAction } from "./types";

export type SkipReason = "action_type_mismatch" | "hash_mismatch" | "hash_missing" | "no_descendants";

export interface SkippedRename {
	pair: RenamePair;
	reason: SkipReason;
}

export interface RenameOptResult {
	actions: SyncAction[];
	applied: RenamePair[];
	skipped: SkippedRename[];
}

export interface FolderRenameOptResult extends RenameOptResult {
	remainingFileRenames: ReadonlyMap<string, string>;
}

export interface RemoteFolderRenameOptResult extends RenameOptResult {
	remainingPairs: RenamePair[];
}
