import type { RenamePair } from "../types";

export interface RemoteDelta {
	modified: string[];
	deleted: string[];
	renamed: RenamePair[];
}

export function cloneDelta(delta: RemoteDelta): RemoteDelta {
	return {
		modified: [...delta.modified],
		deleted: [...delta.deleted],
		renamed: delta.renamed.map((pair) => ({ ...pair })),
	};
}

export type IncrementalChangesResult =
	| { needsFullScan: false; newToken: string; changedPaths: Set<string>; renamedPaths: RenamePair[] }
	| { needsFullScan: true; changedPaths: Set<string> };
