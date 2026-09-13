import type { FileEntity } from "../fs/types";
import type {
	ConflictAction,
	ConflictExecutionPolicy,
	ConflictStrategy,
	SyncRecord,
} from "./types";

interface SamePathConflictFacts {
	readonly path: string;
	readonly local?: FileEntity;
	readonly remote?: FileEntity;
	readonly baseline?: SyncRecord;
	readonly hasMove: boolean;
	readonly replacement: boolean;
	readonly hasAdditionalRemote: boolean;
	readonly hasAdditionalLocal: boolean;
	readonly hasLocalPathOverride: boolean;
	readonly hasRemotePathOverride: boolean;
}

/** Admission-only policy compiler. It consumes bound facts and performs no I/O. */
export function compileSamePathConflictContract(
	facts: SamePathConflictFacts,
	strategy: ConflictStrategy,
	allowLocalWin: boolean,
): Pick<ConflictAction, "protocol" | "conflictPolicy"> {
	const protocol = { kind: "same_path" } as const;
	if (strategy === "auto_merge") {
		return { protocol, conflictPolicy: { mode: "auto_merge", strategy } };
	}
	if (strategy === "duplicate") {
		return { protocol, conflictPolicy: { mode: "preserve", strategy } };
	}
	const { path, local, remote, baseline } = facts;
	const simple = allowLocalWin && !!local && !!remote && !!baseline?.hash && baseline.path === path &&
		local.path === path && remote.path === path && !facts.hasMove && !facts.replacement &&
		!facts.hasAdditionalRemote && !facts.hasAdditionalLocal &&
		!facts.hasLocalPathOverride && !facts.hasRemotePathOverride;
	const proven = simple && !!local.hash && !!remote.hash &&
		local.hash !== baseline.hash && remote.hash !== baseline.hash && local.hash !== remote.hash;
	const conflictPolicy: ConflictExecutionPolicy = proven
		? { mode: "local_win", strategy }
		: { mode: "preserve", strategy };
	return { protocol, conflictPolicy };
}
