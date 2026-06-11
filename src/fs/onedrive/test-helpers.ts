import type { OneDriveItem } from "./types";

export { spyRequestUrl, mockRes, createMockSecretStore } from "../googledrive/test-helpers";

/** Access private fields on OneDriveFs (inherited from CachingRemoteFs) in tests. */
export interface OneDriveFsInternal {
	/** Skip the initial full scan. */
	initialized: boolean;
	/** The in-memory delta cursor (CachingRemoteFs._changesPageToken). */
	_changesPageToken: string | null;
}

/** Build a OneDrive file item for tests. */
export function odFile(id: string, name: string, parentId: string, overrides: Partial<OneDriveItem> = {}): OneDriveItem {
	return {
		id,
		name,
		size: 10,
		parentReference: { id: parentId, path: `/drive/root:` },
		file: { hashes: { quickXorHash: `qxh-${id}` } },
		fileSystemInfo: { lastModifiedDateTime: "2024-01-01T00:00:00Z" },
		lastModifiedDateTime: "2024-01-01T00:00:00Z",
		...overrides,
	};
}

/** Build a OneDrive folder item for tests. */
export function odFolder(id: string, name: string, parentId: string, overrides: Partial<OneDriveItem> = {}): OneDriveItem {
	return {
		id,
		name,
		parentReference: { id: parentId, path: `/drive/root:` },
		folder: { childCount: 0 },
		...overrides,
	};
}

/** Build a OneDrive `deleted`-facet tombstone for tests (carries only id). */
export function odDeleted(id: string): OneDriveItem {
	return { id, name: "", deleted: { state: "deleted" } };
}

/** Wrap items into a delta page that terminates with a deltaLink carrying `token`. */
export function deltaPage(value: OneDriveItem[], token: string): { value: OneDriveItem[]; "@odata.deltaLink": string } {
	return { value, "@odata.deltaLink": `https://graph.microsoft.com/v1.0/me/drive/items/root/delta?token=${token}` };
}
