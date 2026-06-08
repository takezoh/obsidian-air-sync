import type { FileEntity } from "../types";
import type { Logger } from "../../logging/logger";
import type { PCloudEntry } from "./types";
import { pcloudEntryToEntity, withoutContents } from "./types";
import { AbstractMetadataCache } from "../caching/metadata-cache";

export type { FileChangeResult } from "../caching/metadata-cache";

/**
 * Flatten a recursive `listfolder` response (the root entry with nested
 * `contents`) into the flat `PCloudEntry[]` the cache's `buildFromFiles` expects.
 *
 * Each entry's `parentfolderid` is stamped from its position in the tree so path
 * resolution never depends on the listfolder payload populating it on every
 * nested item; the recursive `contents` array is dropped so cached/persisted
 * entries stay flat.
 */
export function flattenPCloudListing(root: PCloudEntry): PCloudEntry[] {
	const out: PCloudEntry[] = [];
	const walk = (entry: PCloudEntry, parentFolderId: number): void => {
		for (const child of entry.contents ?? []) {
			out.push({
				...withoutContents(child),
				parentfolderid: child.parentfolderid ?? parentFolderId,
			});
			if (child.isfolder) walk(child, child.folderid ?? parentFolderId);
		}
	};
	walk(root, root.folderid ?? 0);
	return out;
}

/**
 * pCloud's metadata cache. All the data structures and path/tree logic live in
 * {@link AbstractMetadataCache}; this subclass only reads pCloud's entry shape
 * (single-parent `parentfolderid`, `isfolder`) and projects a `FileEntity` with
 * pCloud's opaque content hash.
 *
 * Addressing is id-based (`id` = `"d<folderid>"`/`"f<fileid>"`) because pCloud's
 * `diff` feed returns account-wide events whose metadata has no absolute path — a
 * delete is reverse-resolved through {@link getPathById}. The numeric `parentfolderid`
 * is lifted into the same id namespace (`"d" + parentfolderid`), and the numeric
 * sync-root folderid is lifted to its `"d"`-prefixed id so a top-level item's parent
 * matches the root.
 */
export class PCloudMetadataCache extends AbstractMetadataCache<PCloudEntry> {
	constructor(rootFolderId: string, logger?: Logger) {
		super("d" + rootFolderId, logger);
	}

	protected extractId(entry: PCloudEntry): string {
		return entry.id;
	}

	protected extractParentIds(entry: PCloudEntry): string[] {
		return entry.parentfolderid == null ? [] : ["d" + entry.parentfolderid];
	}

	protected extractName(entry: PCloudEntry): string {
		return entry.name;
	}

	protected isFolderEntry(entry: PCloudEntry): boolean {
		return entry.isfolder;
	}

	toEntity(path: string, entry: PCloudEntry): FileEntity {
		return pcloudEntryToEntity(path, entry);
	}
}
