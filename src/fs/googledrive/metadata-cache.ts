import type { FileEntity } from "../types";
import type { GoogleDriveFile } from "./types";
import { FOLDER_MIME, toRemoteChecksum } from "./types";
import { AbstractMetadataCache } from "../caching/metadata-cache";

export type { FileChangeResult } from "../caching/metadata-cache";

/**
 * Google Drive's metadata cache. All the data structures and path/tree logic
 * live in {@link AbstractMetadataCache}; this subclass only reads Google Drive's file
 * shape (multi-parent `parents[]`, `mimeType` folders) and projects a
 * `FileEntity` with Google Drive's md5 checksum and `googleDriveId`.
 */
export class GoogleDriveMetadataCache extends AbstractMetadataCache<GoogleDriveFile> {
	protected extractId(file: GoogleDriveFile): string {
		return file.id;
	}

	protected extractParentIds(file: GoogleDriveFile): string[] {
		return file.parents ?? [];
	}

	protected extractName(file: GoogleDriveFile): string {
		return file.name;
	}

	protected isFolderEntry(file: GoogleDriveFile): boolean {
		return file.mimeType === FOLDER_MIME;
	}

	/**
	 * Build a FileEntity from cached GoogleDriveFile metadata (no download).
	 * hash is always "" because computing it would require downloading the
	 * file content. The sync engine uses remoteChecksum instead.
	 */
	toEntity(path: string, googleDriveFile: GoogleDriveFile): FileEntity {
		if (this.isFolder(path)) {
			return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
		}
		const parsedMtime = googleDriveFile.modifiedTime
			? new Date(googleDriveFile.modifiedTime).getTime()
			: 0;
		return {
			path,
			isDirectory: false,
			size: parseInt(googleDriveFile.size || "0", 10),
			mtime: Number.isNaN(parsedMtime) ? 0 : parsedMtime,
			hash: "",
			remoteChecksum: toRemoteChecksum(googleDriveFile),
			backendMeta: { googleDriveId: googleDriveFile.id },
		};
	}
}
