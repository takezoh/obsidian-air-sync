/**
 * Minimal raw-filesystem adapter: the small slice of Obsidian's `DataAdapter` that
 * the plugin's out-of-band files (logs, conflict history) need. Both the Logger and
 * ConflictHistory take one of these instead of casting the vault adapter themselves,
 * so the shape is declared and shared in one place (no `as unknown as` per call site).
 * Obsidian's `DataAdapter` is a structural superset, so `vault.adapter` satisfies it.
 */
export interface RawFsAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

/**
 * Recursively ensure a directory (and all its ancestors) exist, creating each level
 * that is missing. The shared bootstrap for `.airsync/...` subtrees — replaces the
 * per-level exists/mkdir ladders the Logger and ConflictHistory each open-coded.
 *
 * Calls `mkdir()` unconditionally for every level rather than gating on `exists()`
 * first: an out-of-band deletion (e.g. the user removing `.airsync` directly on
 * disk, outside Obsidian) can leave the adapter's own `exists()` view stale, so a
 * gated check can wrongly skip recreating a directory that's actually gone. A
 * missing-directory error can't be told apart from "already exists" without a
 * adapter-specific error code, so tolerate any `mkdir()` failure here as long as
 * the directory verifiably exists afterward; a genuine failure (e.g. permissions)
 * still surfaces there.
 */
export async function ensureDir(adapter: RawFsAdapter, path: string): Promise<void> {
	const parts = path.split("/").filter((p) => p.length > 0);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		try {
			await adapter.mkdir(current);
		} catch {
			if (!(await adapter.exists(current))) throw new Error(`Failed to create directory: ${current}`);
		}
	}
}
