import { diffIndices, diff3Merge } from "node-diff3";
import { getFileExtension } from "../utils/path";

const TEXT_EXTENSIONS = new Set([
	".md", ".txt", ".json", ".canvas", ".css", ".js", ".ts", ".html", ".xml",
	".yaml", ".yml", ".csv", ".svg", ".tex", ".bib", ".org",
	".rst", ".adoc", ".toml", ".ini", ".cfg", ".conf", ".log",
	".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".lua",
	".sql", ".graphql", ".env", ".gitignore",
]);

const MAX_MERGE_SIZE = 1024 * 1024; // 1MB

/** Check if a file is eligible for 3-way text merge */
export function isMergeEligible(path: string, size: number): boolean {
	if (size > MAX_MERGE_SIZE) return false;
	const ext = getFileExtension(path);
	return TEXT_EXTENSIONS.has(ext);
}

export interface MergeResult {
	success: boolean;
	/** Merged content (may contain conflict markers if success is false) */
	content: string;
	/** True if the merge had conflicts (markers inserted) */
	hasConflicts: boolean;
}

interface DiffHunk {
	baseStart: number;
	baseLen: number;
	content: string[];
}

function rangesOverlap(s1: number, l1: number, s2: number, l2: number): boolean {
	const e1 = s1 + Math.max(l1, 1);
	const e2 = s2 + Math.max(l2, 1);
	return s1 < e2 && s2 < e1;
}

function isSameHunk(a: DiffHunk, b: DiffHunk): boolean {
	return a.baseStart === b.baseStart
		&& a.baseLen === b.baseLen
		&& a.content.length === b.content.length
		&& a.content.every((line, i) => line === b.content[i]);
}

function toHunks(diffs: ReturnType<typeof diffIndices>): DiffHunk[] {
	return diffs.map(d => ({
		baseStart: d.buffer1[0],
		baseLen: d.buffer1[1],
		content: d.buffer2Content as string[],
	}));
}

/**
 * Perform a 3-way merge using the base (last synced), local, and remote versions.
 *
 * Uses independent diffs (diffIndices) from base to each side, then checks for
 * overlapping change ranges — the same principle as git merge. Non-overlapping
 * hunks are applied independently; overlapping hunks produce conflict markers.
 */
export function threeWayMerge(
	base: string,
	local: string,
	remote: string
): MergeResult {
	const useCRLF = local.includes("\r\n") || remote.includes("\r\n");
	const normBase = base.replace(/\r\n/g, "\n");
	const normLocal = local.replace(/\r\n/g, "\n");
	const normRemote = remote.replace(/\r\n/g, "\n");

	if (normBase === normLocal) return ok(normRemote, useCRLF);
	if (normBase === normRemote) return ok(normLocal, useCRLF);
	if (normLocal === normRemote) return ok(normLocal, useCRLF);

	const baseLines = normBase.split("\n");
	const localLines = normLocal.split("\n");
	const remoteLines = normRemote.split("\n");

	const localHunks = toHunks(diffIndices(baseLines, localLines));
	const remoteHunks = toHunks(diffIndices(baseLines, remoteLines));

	if (localHunks.length === 0) return ok(normRemote, useCRLF);
	if (remoteHunks.length === 0) return ok(normLocal, useCRLF);

	for (const lh of localHunks) {
		for (const rh of remoteHunks) {
			if (rangesOverlap(lh.baseStart, lh.baseLen, rh.baseStart, rh.baseLen)) {
				if (isSameHunk(lh, rh)) continue;
				return conflict(localLines, remoteLines, useCRLF);
			}
		}
	}

	const allHunks = [...localHunks, ...remoteHunks]
		.sort((a, b) => b.baseStart - a.baseStart);
	const result = [...baseLines];
	for (const h of allHunks) {
		result.splice(h.baseStart, h.baseLen, ...h.content);
	}

	return ok(result.join("\n"), useCRLF);
}

/**
 * Variant of {@link threeWayMerge} that uses `diff3Merge` for conflict
 * rendering so that conflict markers span only the lines that actually differ.
 * Common leading and trailing lines between the two conflicting versions appear
 * outside the markers, matching git's default conflict style.
 *
 * Clean-merge detection still uses `diffIndices` + overlap checking (same as
 * `threeWayMerge`) to avoid the false-conflict edge cases that arise when
 * `diff3Merge` is used alone for non-overlapping nearby changes.
 */
export function threeWayMergeOptimize(
	base: string,
	local: string,
	remote: string,
): MergeResult {
	const useCRLF = local.includes("\r\n") || remote.includes("\r\n");
	const normBase = base.replace(/\r\n/g, "\n");
	const normLocal = local.replace(/\r\n/g, "\n");
	const normRemote = remote.replace(/\r\n/g, "\n");

	if (normBase === normLocal) return ok(normRemote, useCRLF);
	if (normBase === normRemote) return ok(normLocal, useCRLF);
	if (normLocal === normRemote) return ok(normLocal, useCRLF);

	const baseLines = normBase.split("\n");
	const localLines = normLocal.split("\n");
	const remoteLines = normRemote.split("\n");

	const localHunks = toHunks(diffIndices(baseLines, localLines));
	const remoteHunks = toHunks(diffIndices(baseLines, remoteLines));

	if (localHunks.length === 0) return ok(normRemote, useCRLF);
	if (remoteHunks.length === 0) return ok(normLocal, useCRLF);

	// Detect whether any hunks truly overlap (same logic as threeWayMerge).
	let hasConflict = false;
	for (const lh of localHunks) {
		for (const rh of remoteHunks) {
			if (rangesOverlap(lh.baseStart, lh.baseLen, rh.baseStart, rh.baseLen)) {
				if (!isSameHunk(lh, rh)) {
					hasConflict = true;
					break;
				}
			}
		}
		if (hasConflict) break;
	}

	if (!hasConflict) {
		// No real conflict — apply hunks cleanly (same as threeWayMerge).
		const allHunks = [...localHunks, ...remoteHunks]
			.sort((a, b) => b.baseStart - a.baseStart);
		const result = [...baseLines];
		for (const h of allHunks) {
			result.splice(h.baseStart, h.baseLen, ...h.content);
		}
		return ok(result.join("\n"), useCRLF);
	}

	// Conflict confirmed — use diff3Merge for minimal per-hunk conflict markers.
	const regions = diff3Merge(localLines, baseLines, remoteLines);
	const lines: string[] = [];
	for (const region of regions) {
		if (region.ok !== undefined) {
			lines.push(...region.ok);
		} else if (region.conflict !== undefined) {
			lines.push("<<<<<<< LOCAL", ...region.conflict.a, "=======", ...region.conflict.b, ">>>>>>> REMOTE");
		}
	}

	let content = lines.join("\n");
	if (useCRLF) content = content.replace(/\n/g, "\r\n");
	return { success: false, content, hasConflicts: true };
}

function ok(content: string, useCRLF: boolean): MergeResult {
	return {
		success: true,
		content: useCRLF ? content.replace(/\n/g, "\r\n") : content,
		hasConflicts: false,
	};
}

function conflict(localLines: string[], remoteLines: string[], useCRLF: boolean): MergeResult {
	const lines = [
		"<<<<<<< LOCAL",
		...localLines,
		"=======",
		...remoteLines,
		">>>>>>> REMOTE",
	];
	let content = lines.join("\n");
	if (useCRLF) {
		content = content.replace(/\n/g, "\r\n");
	}
	return { success: false, content, hasConflicts: true };
}
