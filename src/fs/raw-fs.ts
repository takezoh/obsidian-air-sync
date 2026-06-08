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
 */
export async function ensureDir(adapter: RawFsAdapter, path: string): Promise<void> {
	const parts = path.split("/").filter((p) => p.length > 0);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!(await adapter.exists(current))) {
			await adapter.mkdir(current);
		}
	}
}
