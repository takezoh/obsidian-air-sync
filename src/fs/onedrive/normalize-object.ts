import type { RemoteObject, RemoteLocation } from "../../backend-api";
import { isFolderEntry, toRemoteChecksum } from "./types";
import type { OneDriveItem } from "./types";

/**
 * Project a Microsoft Graph driveItem onto the normalized {@link RemoteObject}.
 *
 * Identity is the stable driveItem id; addressing is the parent-id tree
 * (`parentReference.id`, with `null` for the bound root). QuickXorHash maps to the
 * reserved `quickxor` checksum id. A missing size/mtime is OMITTED (unknown), never
 * coerced to `0`.
 */
export function normalizeOneDriveObject(item: OneDriveItem): RemoteObject {
	const folder = isFolderEntry(item);
	const parentId = item.parentReference?.id ?? null;
	const location: RemoteLocation = { addressing: "parent_id", parentId };
	const legacyChecksum = folder ? undefined : toRemoteChecksum(item);
	const checksum = legacyChecksum ? { algorithm: legacyChecksum.algo, value: legacyChecksum.value } : undefined;

	const base = {
		id: item.id,
		name: item.name,
		location,
		pathAuthority: "provider_resolved" as const,
		mtimeMs: parseGraphTime(item.fileSystemInfo?.lastModifiedDateTime ?? item.lastModifiedDateTime),
	};

	if (folder) {
		return { ...base, kind: "directory", versionToken: versionTokenOf(item) };
	}
	return { ...base, kind: "file", size: item.size, checksum, versionToken: versionTokenOf(item) };
}

function parseGraphTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : ms;
}

function versionTokenOf(item: OneDriveItem): string | undefined {
	const tag = item.cTag || item.eTag;
	if (!tag) return undefined;
	if (!isFolderEntry(item) && (!Number.isFinite(item.size) || !item.file?.hashes?.quickXorHash)) {
		return undefined;
	}
	return `onedrive:${tag}`;
}
