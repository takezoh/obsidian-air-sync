import type { FileEntity } from "../types";
import type { DriveFile } from "./types";
import { FOLDER_MIME, toRemoteChecksum } from "./types";
import { AbstractMetadataCache } from "../caching/metadata-cache";

export type { FileChangeResult } from "../caching/metadata-cache";

/**
 * Google Drive's metadata cache. All the data structures and path/tree logic
 * live in {@link AbstractMetadataCache}; this subclass only reads Drive's file
 * shape (multi-parent `parents[]`, `mimeType` folders) and projects a
 * `FileEntity` with Drive's md5 checksum and `driveId`.
 */
export class DriveMetadataCache extends AbstractMetadataCache<DriveFile> {
	protected extractId(file: DriveFile): string {
		return file.id;
	}

	protected extractParentIds(file: DriveFile): string[] {
		return file.parents ?? [];
	}

	protected extractName(file: DriveFile): string {
		return file.name;
	}

	protected isFolderEntry(file: DriveFile): boolean {
		return file.mimeType === FOLDER_MIME;
	}

	/**
	 * Build a FileEntity from cached DriveFile metadata (no download).
	 * hash is always "" because computing it would require downloading the
	 * file content. The sync engine uses remoteChecksum instead.
	 */
	toEntity(path: string, driveFile: DriveFile): FileEntity {
		if (this.isFolder(path)) {
			return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
		}
		const parsedMtime = driveFile.modifiedTime
			? new Date(driveFile.modifiedTime).getTime()
			: 0;
		return {
			path,
			isDirectory: false,
			size: parseInt(driveFile.size || "0", 10),
			mtime: Number.isNaN(parsedMtime) ? 0 : parsedMtime,
			hash: "",
			remoteChecksum: toRemoteChecksum(driveFile),
			backendMeta: { driveId: driveFile.id },
		};
	}
}
