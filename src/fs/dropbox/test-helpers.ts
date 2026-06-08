import type { DropboxEntry } from "./types";

export { spyRequestUrl, mockRes, createMockSecretStore } from "../googledrive/test-helpers";

/** Access private fields on DropboxFs (inherited from CachingRemoteFs) in tests. */
export interface DropboxFsInternal {
	/** Skip the initial full scan. */
	initialized: boolean;
	/** The in-memory delta cursor (CachingRemoteFs._changesPageToken). */
	_changesPageToken: string | null;
}

/** Build a Dropbox file entry for tests (paths are absolute, as Dropbox returns them). */
export function dbxFile(
	id: string,
	path: string,
	overrides: Partial<DropboxEntry> = {},
): DropboxEntry {
	const name = path.split("/").pop()!;
	return {
		".tag": "file",
		id: "id:" + id,
		name,
		path_lower: path.toLowerCase(),
		path_display: path,
		rev: "rev" + id,
		size: 10,
		client_modified: "2024-01-01T00:00:00Z",
		server_modified: "2024-01-01T00:00:00Z",
		content_hash: "hash" + id,
		...overrides,
	};
}

/** Build a Dropbox folder entry for tests. */
export function dbxFolder(id: string, path: string): DropboxEntry {
	const name = path.split("/").pop()!;
	return {
		".tag": "folder",
		id: "id:" + id,
		name,
		path_lower: path.toLowerCase(),
		path_display: path,
	};
}

/** Build a Dropbox `deleted` tombstone for tests (carries a path, no id). */
export function dbxDeleted(path: string): DropboxEntry {
	const name = path.split("/").pop()!;
	return {
		".tag": "deleted",
		name,
		path_lower: path.toLowerCase(),
		path_display: path,
	};
}

/**
 * Strip the `.tag` discriminator from an entry.
 *
 * Mimics Dropbox's `create_folder_v2` / `upload` responses, which return a bare
 * concrete FolderMetadata/FileMetadata WITHOUT `.tag` (unlike list_folder's
 * tagged union). Tests must use this for those mocks, or they mask the real API
 * shape and give false confidence.
 */
export function untagged(entry: DropboxEntry): Omit<DropboxEntry, ".tag"> {
	const copy = { ...entry };
	delete (copy as Partial<DropboxEntry>)[".tag"];
	return copy;
}
