/**
 * An immutable, point-in-time copy of the tracker's pending-change state, taken
 * at the start of a sync cycle. The cycle drives change detection from this
 * frozen view AND acknowledges exactly this view at the end — so a `markDirty`
 * (or rename) arriving mid-cycle is neither processed by this cycle nor swept
 * away by its acknowledge; it survives in the live tracker for the next cycle,
 * keeping it on the fast HOT path instead of degrading to a full WARM scan.
 */
export interface TrackerSnapshot {
	readonly dirtyPaths: ReadonlySet<string>;
	readonly renamePairs: ReadonlyMap<string, string>;
	readonly folderRenamePairs: ReadonlyMap<string, string>;
	readonly initialized: boolean;
}

/**
 * Delete from `live` each entry the snapshot `captured`, but only when the live
 * value still equals what was captured — so an entry re-created or overwritten
 * since the snapshot (a mid-cycle rename) is left intact.
 */
function deleteMatching(
	live: Map<string, string>,
	captured: ReadonlyMap<string, string>,
): void {
	for (const [key, value] of captured) {
		if (live.get(key) === value) live.delete(key);
	}
}

export class LocalChangeTracker {
	private dirtyPaths = new Set<string>();
	private renamePairs = new Map<string, string>(); // newPath → oldPath
	private folderRenamePairs = new Map<string, string>(); // newFolder → oldFolder
	private initialized = false;

	markDirty(path: string): void {
		this.dirtyPaths.add(path);
	}

	markRenamed(newPath: string, oldPath: string): void {
		// Resolve chain: if oldPath was itself a rename destination (A→B, B→C → A→C)
		const resolved = this.renamePairs.get(oldPath) ?? oldPath;
		this.renamePairs.delete(oldPath);
		if (resolved === newPath) return; // renamed back to original — no-op
		this.renamePairs.set(newPath, resolved);
		this.dirtyPaths.add(resolved);
		this.dirtyPaths.add(newPath);
	}

	markFolderRenamed(newPath: string, oldPath: string): void {
		const resolved = this.folderRenamePairs.get(oldPath) ?? oldPath;
		this.folderRenamePairs.delete(oldPath);
		if (resolved === newPath) return;
		this.folderRenamePairs.set(newPath, resolved);
	}

	getRenamePairs(): ReadonlyMap<string, string> {
		return this.renamePairs;
	}

	getFolderRenamePairs(): ReadonlyMap<string, string> {
		return this.folderRenamePairs;
	}

	getDirtyPaths(): ReadonlySet<string> {
		return this.dirtyPaths;
	}

	/**
	 * Capture the current pending-change state as a point-in-time snapshot. The
	 * sets and maps are COPIED, so later mutation of the live tracker (a mid-cycle
	 * `markDirty`) cannot retroactively change a captured snapshot. Consumers must
	 * not mutate the snapshot: that is enforced at compile time by the
	 * `ReadonlySet`/`ReadonlyMap` types — `Object.freeze` is a shallow guard on the
	 * wrapper only and does not freeze the inner collections.
	 */
	snapshot(): TrackerSnapshot {
		return Object.freeze({
			dirtyPaths: new Set(this.dirtyPaths),
			renamePairs: new Map(this.renamePairs),
			folderRenamePairs: new Map(this.folderRenamePairs),
			initialized: this.initialized,
		});
	}

	/**
	 * Clear exactly the paths/renames captured in `snap` — what one sync cycle
	 * consumed. Anything dirtied AFTER the snapshot was taken is left intact (it
	 * belongs to the next cycle). Folder renames are deleted by key from the
	 * snapshot rather than wholesale, so a folder rename recorded mid-cycle is
	 * not swept away.
	 */
	acknowledge(snap: TrackerSnapshot): void {
		for (const p of snap.dirtyPaths) {
			this.dirtyPaths.delete(p);
		}
		// Drop a rename pair only if the LIVE entry still equals what the snapshot
		// captured. A mid-cycle rename that re-created or overwrote the key (a fresh
		// pair, or the same newPath with a different source) differs from the
		// snapshot and is left for the next cycle. Keying off `dirtyPaths` instead
		// would sweep such a pair, because `markRenamed`/`markFolderRenamed` reuse a
		// newPath that may already be in the dirty snapshot for an unrelated edit.
		deleteMatching(this.renamePairs, snap.renamePairs);
		deleteMatching(this.folderRenamePairs, snap.folderRenamePairs);
		this.initialized = true;
	}

	/**
	 * Clear a single path after an out-of-band priority pull (see
	 * `SyncOrchestrator.pullSingle`). Unlike `acknowledge`, this intentionally
	 * does NOT touch `folderRenamePairs` (a single-file pull must not wipe pending
	 * folder renames) nor flip `initialized` (it must not move the tracker out of
	 * its cold-start state).
	 */
	acknowledgePath(path: string): void {
		this.dirtyPaths.delete(path);
		this.renamePairs.delete(path);
	}

	isInitialized(): boolean {
		return this.initialized;
	}
}
