import ignore from "ignore";

/**
 * OS-generated junk files that are never worth syncing on ANY backend (and that
 * some backends, e.g. Dropbox, reject outright with `path/disallowed_name`).
 * Matched case-insensitively on the final path segment and treated as
 * always-excluded — like a reserved path, independent of the user's ignore
 * patterns or syncDotPaths. Syncing them just churns (or fails) every cycle.
 */
const SYSTEM_JUNK_BASENAMES = new Set(["desktop.ini", "thumbs.db", ".ds_store"]);

/** Whether a path is OS-generated junk that must never be synced on any backend. */
export function isSystemJunkFile(path: string): boolean {
	const name = path.split("/").pop()?.toLowerCase() ?? "";
	return SYSTEM_JUNK_BASENAMES.has(name);
}

export function isIgnored(path: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	return ignore().add(patterns).ignores(path);
}
