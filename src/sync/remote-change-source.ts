import type { IFileSystem } from "../fs/interface";
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

export async function getRemoteChanges(
	remoteFs: IFileSystem,
	onIdentityEvidence?: (evidence: readonly RenameEvidence[]) => void,
): Promise<RemoteChanges> {
	if (!remoteFs.checkpoint) return emptyRemoteChanges();
	const result = await remoteFs.checkpoint.getChangedPaths();
	if (!result) return emptyRemoteChanges();
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
