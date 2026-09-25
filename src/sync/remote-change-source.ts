import type { IFileSystem } from "../fs/interface";
import type { RemoteDelta } from "../fs/caching/remote-fs";
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
 * Namespace collisions are settled inside the remote filesystem before this runs
 * (see `IFileSystem.namespaceReconciliation`), so the delta is a path-level 1:1 view
 * and this seam never carries a collision fact.
 */
export async function getRemoteChanges(
	remoteFs: IFileSystem,
	onIdentityEvidence?: (evidence: readonly RenameEvidence[]) => void,
	prefetchedDelta?: RemoteDelta | null,
): Promise<RemoteChanges> {
	if (!remoteFs.checkpoint) return emptyRemoteChanges();
	// A delta already built by namespace reconciliation this cycle is reused, so the
	// cursor is not replayed (a second replay sees no changes) and the view consumed is
	// the one reconciliation settled.
	const result = prefetchedDelta !== undefined
		? prefetchedDelta
		: await remoteFs.checkpoint.getChangedPaths();
	if (!result) return emptyRemoteChanges();
	// The checkpoint's pairs reach evidence untouched, identity included. Two claims on
	// one edge naming different objects now both survive collection, so the flattened
	// endpoints below can repeat an edge; every consumer folds `paths` into a Set, and
	// the conflict itself is the report family's to classify, not this seam's to hide.
	const renameEvidence = collectRemoteRenameEvidence(result.renamed ?? []);
	onIdentityEvidence?.(renameEvidence);
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
