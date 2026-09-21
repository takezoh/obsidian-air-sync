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
	// `eTag` is the version of the ENTIRE item (metadata + content), so it advances on a
	// metadata-only rename/move; `cTag` tracks content only and is absent on folders.
	// Version evidence is the eTag ALONE: a missing size or QuickXorHash makes the
	// checksum unknown, but it does not remove the item's version, and metadata mutation
	// must still be guardable and fail closed on a mismatch.
	const tag = item.eTag;
	return tag ? `onedrive:${tag}` : undefined;
}
