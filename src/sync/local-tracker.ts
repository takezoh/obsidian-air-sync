export class LocalChangeTracker {
	private dirtyPaths = new Set<string>();
	private renamePairs = new Map<string, string>(); // newPath → oldPath
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

	getRenamePairs(): ReadonlyMap<string, string> {
		return this.renamePairs;
	}

	getDirtyPaths(): ReadonlySet<string> {
		return this.dirtyPaths;
	}

	acknowledge(paths: Iterable<string>): void {
		for (const p of paths) {
			this.dirtyPaths.delete(p);
			this.renamePairs.delete(p);
		}
		this.initialized = true;
	}

	isInitialized(): boolean {
		return this.initialized;
	}
}
