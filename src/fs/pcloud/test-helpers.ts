import type { PCloudEntry } from "./types";

export { spyRequestUrl, mockRes, createMockSecretStore } from "../googledrive/test-helpers";

/** Access private fields on PCloudFs in tests (skip the initial full scan). */
export interface PCloudFsInternal {
	initialized: boolean;
}

/** Build a pCloud file entry for tests. */
export function pcFile(
	fileid: number,
	name: string,
	parentfolderid: number,
	overrides: Partial<PCloudEntry> = {},
): PCloudEntry {
	return {
		id: "f" + fileid,
		name,
		isfolder: false,
		parentfolderid,
		fileid,
		size: 10,
		hash: fileid,
		modified: "Wed, 02 Oct 2013 14:17:54 +0000",
		...overrides,
	};
}

/** Build a pCloud folder entry for tests. */
export function pcFolder(
	folderid: number,
	name: string,
	parentfolderid: number,
	contents?: PCloudEntry[],
): PCloudEntry {
	return { id: "d" + folderid, name, isfolder: true, parentfolderid, folderid, contents };
}
