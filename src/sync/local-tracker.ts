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
	readonly generations?: ReadonlyMap<string, number>;
	readonly initialized: boolean;
}

/**
 * Delete from `live` each entry the snapshot `captured`, but only when the live
 * value and endpoint generations still equal what was captured. Pair equality
 * alone cannot distinguish a same-value report recreated after the snapshot.
 */
function deleteMatching(
	live: Map<string, string>,
	captured: ReadonlyMap<string, string>,
	generations: ReadonlyMap<string, number>,
	capturedGenerations: ReadonlyMap<string, number> | undefined,
): void {
	for (const [key, value] of captured) {
		const unchanged = (path: string) => !capturedGenerations ||
			(generations.get(path) ?? 0) === (capturedGenerations.get(path) ?? 0);
		if (live.get(key) === value && unchanged(key) && unchanged(value)) live.delete(key);
	}
}

export class LocalChangeTracker {
	private dirtyPaths = new Set<string>();
	private renamePairs = new Map<string, string>(); // newPath → oldPath
	private folderRenamePairs = new Map<string, string>(); // newFolder → oldFolder
	private generations = new Map<string, number>();
	private initialized = false;

	private bump(path: string): void {
		this.generations.set(path, this.generation(path) + 1);
	}

	markDirty(path: string): void {
		this.bump(path);
		this.dirtyPaths.add(path);
	}

	markRenamed(newPath: string, oldPath: string): void {
		// Resolve chain: if oldPath was itself a rename destination (A→B, B→C → A→C)
		const resolved = this.renamePairs.get(oldPath) ?? oldPath;
		this.renamePairs.delete(oldPath);
		// Every observed endpoint mutation advances its existing generation, even
		// when the collapsed report cancels itself (A→B→A).
		for (const path of new Set([oldPath, resolved, newPath])) {
			this.markDirty(path);
		}
		if (resolved === newPath) return; // renamed back to original — no-op
		this.renamePairs.set(newPath, resolved);
	}

	markFolderRenamed(newPath: string, oldPath: string): void {
		const resolved = this.folderRenamePairs.get(oldPath) ?? oldPath;
		this.folderRenamePairs.delete(oldPath);
		for (const path of new Set([oldPath, resolved, newPath])) this.bump(path);
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
			generations: new Map(this.generations),
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
			if (!snap.generations || this.generation(p) === (snap.generations.get(p) ?? 0)) {
				this.dirtyPaths.delete(p);
			}
		}
		// A same-value ABA report is new input too; acknowledge only the captured
		// endpoint generations, using the same map as dirty-path acknowledgment.
		deleteMatching(this.renamePairs, snap.renamePairs, this.generations, snap.generations);
		deleteMatching(this.folderRenamePairs, snap.folderRenamePairs, this.generations, snap.generations);
		this.initialized = true;
	}

	/**
	 * Clear a single path after an out-of-band priority pull (see
	 * `SyncOrchestrator.pullSingle`). Unlike `acknowledge`, this intentionally
	 * does NOT touch `folderRenamePairs` (a single-file pull must not wipe pending
	 * folder renames) nor flip `initialized` (it must not move the tracker out of
	 * its cold-start state).
	 */
	acknowledgePath(path: string, expectedGeneration = this.generation(path)): void {
		if (this.generation(path) !== expectedGeneration) return;
		this.dirtyPaths.delete(path);
		this.renamePairs.delete(path);
	}

	generation(path: string): number {
		return this.generations.get(path) ?? 0;
	}

	isInitialized(): boolean {
		return this.initialized;
	}
}
