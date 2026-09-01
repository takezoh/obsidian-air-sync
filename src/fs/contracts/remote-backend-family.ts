import type { IFileSystem } from "../interface";
import { DropboxFs } from "../dropbox";
import { GoogleDriveFs } from "../googledrive";
import { OneDriveFs } from "../onedrive";

/**
 * Test-only catalog joining production filesystem implementations to the remote
 * contract families they must satisfy. Provider aliases intentionally converge
 * here when they create the same filesystem implementation.
 */
export const REMOTE_BACKEND_FAMILIES = {
	googledrive: GoogleDriveFs,
	dropbox: DropboxFs,
	onedrive: OneDriveFs,
} as const;

export type RemoteBackendFamily = keyof typeof REMOTE_BACKEND_FAMILIES;

export function remoteBackendFamilyOf(fs: IFileSystem): RemoteBackendFamily | undefined {
	for (const [family, FsClass] of Object.entries(REMOTE_BACKEND_FAMILIES)) {
		if (fs.constructor === FsClass) return family as RemoteBackendFamily;
	}
	return undefined;
}
