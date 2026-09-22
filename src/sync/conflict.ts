import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import { insertConflictSuffix } from "../utils/path";
import type { ExactSnapshot } from "./content-snapshot";

export { insertConflictSuffix } from "../utils/path";

export interface ConflictResolutionResult {
	/** The action that was taken */
	action: "kept_local" | "kept_remote" | "duplicated" | "merged";
	/** If a duplicate was created, its path */
	duplicatePath?: string;
	/** Every preservation output path in admitted child order. */
	duplicatePaths?: readonly string[];
	/** True if the merged result contains unresolved conflict markers */
	hasConflictMarkers?: boolean;
	/** Verified preservation outputs created before any original-path effect. */
	verifiedOutputs?: readonly VerifiedConflictOutput[];
	/** Exact bytes the executor must install at the target after preservation. */
	targetContent?: ArrayBuffer;
	targetMtime?: number;
	/** Attempt-local read witnesses; execution revalidates these before original-path effects. */
	capturedInputs?: { readonly local?: ExactSnapshot; readonly remote?: ExactSnapshot };
}

export interface VerifiedConflictOutput {
	readonly role: "primary" | "additional" | "local";
	readonly path: string;
	readonly sourcePath: string;
	/** Immutable resolver snapshot used by the executor's destructive precondition check. */
	readonly sourceEntity: FileEntity;
	readonly sourceContent: ArrayBuffer;
}

/** Generate a conflict file path with sequential numbering to avoid overwrites.
 *  e.g. "notes/file.conflict.md" → "notes/file.conflict-2.md" if the first exists.
 *  Checks all provided filesystems to prevent overwriting on any side.
 */
export async function generateConflictPath(
	path: string,
	...filesystems: IFileSystem[]
): Promise<string> {
	const existsOnAny = async (candidate: string): Promise<boolean> => {
		for (const fs of filesystems) {
			if (await fs.stat(candidate)) return true;
		}
		return false;
	};

	const candidate = insertConflictSuffix(path, 1);
	if (!(await existsOnAny(candidate))) return candidate;

	for (let i = 2; i <= 100; i++) {
		const numbered = insertConflictSuffix(path, i);
		if (!(await existsOnAny(numbered))) return numbered;
	}
	// Extremely unlikely (100 existing .conflict copies of one file): fall back to a
	// timestamp suffix. No further tier — a same-path, same-millisecond collision on
	// top of 100 existing copies is not a real scenario.
	return insertConflictSuffix(path, Date.now());
}

/** Reverse only the deterministic full-SHA preservation address. The result is
 * an acquisition hint; callers must prove the base alias and candidate bytes.
 */
export function directConflictCandidateHint(
	path: string,
): { readonly basePath: string; readonly sha256: string } | undefined {
	const slash = path.lastIndexOf("/");
	const directory = slash === -1 ? "" : path.substring(0, slash + 1);
	const filename = path.substring(slash + 1);
	const match = /^(.*)\.conflict-([0-9a-f]{64})(\.[^.]*)?$/.exec(filename);
	if (!match) return undefined;
	const basePath = `${directory}${match[1]}${match[3] ?? ""}`;
	const sha256 = match[2]!;
	if ((!match[1] && !match[3]) || insertConflictSuffix(basePath, sha256) !== path) return undefined;
	return { basePath, sha256 };
}
