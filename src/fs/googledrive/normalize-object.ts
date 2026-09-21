import type { RemoteObject, RemoteLocation } from "../../backend-api";
import { parseIsoTime } from "../modules/module-utils";
import { FOLDER_MIME } from "./types";
import type { GoogleDriveFile } from "./types";

/**
 * Project a provider-native Google Drive file DTO onto the normalized
 * {@link RemoteObject} (Backend Module API v2).
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
