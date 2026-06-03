/**
 * Normalize a sync path to canonical form:
 * - Backslashes → forward slashes
 * - Collapse consecutive slashes
 * - Strip leading/trailing slashes
 */
export function normalizeSyncPath(path: string): string {
	let p = path.replace(/\\/g, "/");
	p = p.replace(/\/+/g, "/");
	if (p.startsWith("/")) p = p.substring(1);
	if (p.endsWith("/")) p = p.substring(0, p.length - 1);
	return p;
}

/**
 * Extract the file extension (including the dot) in lowercase.
 * Returns "" if the path has no extension or the last dot belongs to a directory segment.
 */
export function getFileExtension(path: string): string {
	const lastDot = path.lastIndexOf(".");
	if (lastDot === -1 || lastDot <= path.lastIndexOf("/")) {
		return "";
	}
	return path.substring(lastDot).toLowerCase();
}

/**
 * A dot-prefixed (hidden) path — top-level (".airsync") or nested ("foo/.bar").
 * Obsidian's vault index excludes these, so they must be operated on via the raw
 * adapter rather than the indexed Vault API (which returns null / can't create
 * them). This is a mechanism check (which API to use), independent of sync policy.
 */
export function isDotPrefixed(path: string): boolean {
	return path.startsWith(".") || path.includes("/.");
}

/**
 * A dot-prefixed path is in sync scope only when it sits under a configured
 * syncDotPaths root. Every other hidden path (.obsidian, .git, .airsync, etc.)
 * is out of scope and must not be synced in either direction. Normal (non-hidden)
 * paths are never out of scope here (ignorePatterns is applied separately).
 */
export function isDotPathOutOfScope(path: string, syncDotPaths: string[]): boolean {
	if (!isDotPrefixed(path)) return false;
	return !syncDotPaths.some((root) => {
		const r = root.replace(/\/+$/, "");
		return path === r || path.startsWith(r + "/");
	});
}

/**
 * Validate that a rename operation is safe.
 * @throws if oldPath === newPath or newPath is inside oldPath's subtree.
 */
export function validateRename(oldPath: string, newPath: string): void {
	if (oldPath === newPath) {
		throw new Error(`Cannot rename "${oldPath}" to itself`);
	}
	if (newPath.startsWith(oldPath + "/")) {
		throw new Error(
			`Cannot move "${oldPath}" into its own subtree "${newPath}"`
		);
	}
}
