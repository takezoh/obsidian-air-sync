import type { IFileSystem } from "../fs/interface";
import type { AddressDisplacement } from "../fs/caching/claim-set-assignment";
import type { FileEntity } from "../fs/types";
import type { RenameEvidence } from "./types";
import { collectRemoteRenameEvidence } from "./identity-evidence";

export interface RemoteChanges {
	paths: string[];
	deletedPaths: ReadonlySet<string>;
	renameEvidence: RenameEvidence[];
}

export function hasFolderRename(changes: RemoteChanges): boolean {
	return changes.renameEvidence.some((evidence) => evidence.isFolder);
}

export async function remoteSnapshotAfterDelta(remoteFs: IFileSystem): Promise<FileEntity[]> {
	const checkpoint = remoteFs.checkpoint;
	if (!checkpoint?.listCurrentSnapshot) {
		throw new Error("Remote folder rename requires a replay-free checkpoint snapshot");
	}
	return checkpoint.listCurrentSnapshot();
}

/**
 * Collect this cycle's remote delta.
 *
 * `onContention` carries the addresses the filesystem found claimed by two live
 * ids, in the same shape as `onIdentityEvidence`: a fact about this cycle handed
 * straight to the caller, so `RemoteChanges` stays the path-level view it has
 * always been. The facts are not stored anywhere — the next cycle re-observes
 * whatever still stands.
 */
export async function getRemoteChanges(
	remoteFs: IFileSystem,
	onIdentityEvidence?: (evidence: readonly RenameEvidence[]) => void,
	onContention?: (contended: readonly AddressDisplacement[]) => void,
): Promise<RemoteChanges> {
	if (!remoteFs.checkpoint) return emptyRemoteChanges();
	const result = await remoteFs.checkpoint.getChangedPaths();
	if (!result) return emptyRemoteChanges();
	// The checkpoint's pairs reach evidence untouched, identity included. Two claims on
	// one edge naming different objects now both survive collection, so the flattened
	// endpoints below can repeat an edge; every consumer folds `paths` into a Set, and
	// the conflict itself is the report family's to classify, not this seam's to hide.
	const renameEvidence = collectRemoteRenameEvidence(result.renamed ?? []);
	onIdentityEvidence?.(renameEvidence);
	onContention?.(result.contended ?? []);
	return {
		paths: [
			...result.modified,
			...result.deleted,
			...renameEvidence.flatMap(({ oldPath, newPath }) => [oldPath, newPath]),
		],
		deletedPaths: new Set(result.deleted),
		renameEvidence,
	};
}

function emptyRemoteChanges(): RemoteChanges {
	return { paths: [], deletedPaths: new Set(), renameEvidence: [] };
}
