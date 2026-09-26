import type { RemoteObject, RemoteLocation } from "../../backend-api";
import { parseIsoTime } from "../shared/module-utils";
import { FOLDER_MIME, isGoogleDriveNativeObject } from "./types";
import type { GoogleDriveFile } from "./types";

/**
 * Whether a provider DTO may enter the remote sync view as a synchronizable object.
 *
 * RB-SVC-010: Google Workspace-native objects (Docs Editors, shortcuts, forms, …) are
 * excluded from the view rather than projected as an ordinary file with no size/checksum
 * and an unreadable media route.
 *
 * An object with no parent at all is likewise excluded. The `parent_id` location reserves
 * `null` for the bound root AND ONLY the bound root (see `RemoteLocation`), so a Drive item
 * whose `parents` is empty — an item in "Shared with me", or the My Drive root itself — is
 * outside the bound subtree. Projecting it as `parentId: null` would seat it at a bare-name
 * root address and pull a file the vault does not contain.
 */
function isSyncableGoogleDriveObject(file: GoogleDriveFile): boolean {
	return !isGoogleDriveNativeObject(file.mimeType) && hasGoogleDriveParent(file);
}

/**
 * Whether the provider reported at least one parent for this object. A Google Drive
 * object with an empty `parents` is not inside any folder the account can address, so it
 * cannot be placed under the bound root; only a real parent id (the bound root included)
 * makes its in-tree position representable.
 */
function hasGoogleDriveParent(file: GoogleDriveFile): boolean {
	return (file.parents?.length ?? 0) > 0;
}

/**
 * Normalize one provider DTO, or `null` when it must not enter the remote sync view
 * (a provider-native object or one with no provider parent). A `null` input
 * (authoritative absence) is also `null`.
 */
export function toSyncableRemoteObject(
	file: GoogleDriveFile | null,
	rootId: string,
): RemoteObject | null {
	if (file === null || !isSyncableGoogleDriveObject(file)) return null;
	return normalizeGoogleDriveObject(file, rootId);
}

/** Normalize a provider listing, dropping objects the view cannot represent. */
export function mapSyncableGoogleDriveObjects(
	files: readonly GoogleDriveFile[],
	rootId: string,
): RemoteObject[] {
	return files
		.filter(isSyncableGoogleDriveObject)
		.map((file) => normalizeGoogleDriveObject(file, rootId));
}

/**
 * Project a provider-native Google Drive file DTO onto the normalized
 * {@link RemoteObject} (Backend Module API v3).
 *
 * Identity is the Drive file id (unchanged by a rename/move). Addressing is a
 * parent-id tree: `parentId === null` means the bound root. When the provider
 * reports several parents (a legacy Drive entry), the bound root is preferred, so
 * the observed location matches the legacy `findRelevantParentId` policy.
 *
 * `size`/`mtimeMs` are OMITTED when the provider does not report them (Google Docs
 * carry no size, a malformed timestamp is unknown) so the normalized "unknown" state
 * is never confused with a real `0`.
 */
export function normalizeGoogleDriveObject(file: GoogleDriveFile, rootId: string): RemoteObject {
	const isDirectory = file.mimeType === FOLDER_MIME;
	const parents = file.parents ?? [];
	const parentId = parents.includes(rootId) ? rootId : parents[0] ?? null;
	const location: RemoteLocation = { addressing: "parent_id", parentId };

	const base = {
		id: file.id,
		name: file.name,
		location,
		pathAuthority: "provider_resolved" as const,
		mtimeMs: parseIsoTime(file.modifiedTime),
	};

	// Drive's `version` is monotonic and advances on every server-side change,
	// including a metadata-only rename/move that leaves the bytes and checksum
	// unchanged. That is the only evidence that detects those changes, so it is the
	// version token for files AND directories (a folder rename must still move it).
	const versionToken = file.version !== undefined && file.version !== ""
		? `googledrive:v:${file.version}`
		: undefined;

	if (isDirectory) {
		return { ...base, kind: "directory", versionToken };
	}

	const size = parseSize(file.size);
	const checksum = file.md5Checksum ? { algorithm: "md5", value: file.md5Checksum } : undefined;

	return {
		...base,
		kind: "file",
		size,
		checksum,
		versionToken,
	};
}

function parseSize(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}
