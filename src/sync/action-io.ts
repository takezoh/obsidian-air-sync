import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { SyncAction } from "./types";

/** Execute one already late-admitted filesystem effect without committing state. */
export async function runActionIO(
	action: SyncAction,
	fs: { localFs: IFileSystem; remoteFs: IFileSystem },
	boundRemoteContent?: ArrayBuffer,
	boundLocalContent?: ArrayBuffer,
): Promise<{ localEntity?: FileEntity; remoteEntity?: FileEntity }> {
	const { localFs, remoteFs } = fs;
	const { path } = action;
	switch (action.action) {
		case "push": {
			if (!action.local) throw new Error(`push action requires local entity: ${path}`);
			const content = boundLocalContent ?? await localFs.read(path);
			const remoteEntity = await remoteFs.write(path, content, action.local.mtime);
			return { localEntity: await localFs.stat(path) ?? action.local, remoteEntity };
		}
		case "pull": {
			if (!action.remote) throw new Error(`pull action requires remote entity: ${path}`);
			const content = boundRemoteContent ?? await remoteFs.read(path);
			const localEntity = await localFs.write(path, content, action.remote.mtime);
			return { localEntity, remoteEntity: await remoteFs.stat(path) ?? action.remote };
		}
		case "match":
			return { localEntity: action.local, remoteEntity: action.remote };
		case "rename_remote": {
			await remoteFs.rename(action.oldPath, path);
			return {
				localEntity: await localFs.stat(path) ?? action.local,
				remoteEntity: await remoteFs.stat(path) ?? undefined,
			};
		}
		case "rename_local": {
			await localFs.rename(action.oldPath, path);
			return { localEntity: await localFs.stat(path) ?? undefined, remoteEntity: action.remote };
		}
		case "delete_remote":
			await remoteFs.delete(path);
			return {};
		case "delete_local":
			await localFs.delete(path);
			return {};
		case "cleanup":
		case "conflict":
			return {};
	}
}
