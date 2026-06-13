import type { FileEntity } from "../types";
import type { OneDriveItem } from "./types";
import { isFolderEntry, oneDriveItemToEntity } from "./types";
import { AbstractMetadataCache } from "../caching/metadata-cache";

/**
 * OneDrive's metadata cache. All the data structures and path/tree logic live in
 * {@link AbstractMetadataCache}; this subclass only reads Graph's driveItem shape
 * (single-parent `parentReference.id`, the `folder` facet) and projects a
 * `FileEntity` with OneDrive's sha1 checksum and `oneDriveId`.
 *
 * Like Google Drive (and unlike Dropbox), OneDrive references its parent by id, so
 * the base's id→parent-chain path resolver drives it unchanged — `extractParentIds`
 * just returns the single parent id as a one-element array.
 */
export class OneDriveMetadataCache extends AbstractMetadataCache<OneDriveItem> {
	protected extractId(item: OneDriveItem): string {
		return item.id;
	}

	protected extractParentIds(item: OneDriveItem): string[] {
		return item.parentReference?.id ? [item.parentReference.id] : [];
	}

	protected extractName(item: OneDriveItem): string {
		return item.name;
	}

	protected isFolderEntry(item: OneDriveItem): boolean {
		return isFolderEntry(item);
	}

	/**
	 * Build a FileEntity from cached driveItem metadata (no download). hash is always
	 * "" because computing it would require downloading the content; the sync engine
	 * uses remoteChecksum (the locally-reproducible quickXorHash) instead.
	 */
	toEntity(path: string, item: OneDriveItem): FileEntity {
		if (this.isFolder(path)) {
			return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
		}
		return oneDriveItemToEntity(path, item);
	}
}
