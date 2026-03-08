import { FOLDER_MIME } from "./types";
import type { DriveFile } from "./types";

/**
 * Lightweight folder hierarchy for incremental path resolution without the full metadata cache.
 * Tracks folderId → { name, parentId } for all folders under the sync root.
 */
export interface FolderHierarchy {
	/** folderId → { name, parentId } */
	folders: Map<string, { name: string; parentId: string }>;
	rootFolderId: string;
}

/** Compact serialized format for storage (~5KB for 100 folders) */
interface StoredFolderHierarchy {
	folders: Record<string, { n: string; p: string }>;
	rootFolderId: string;
}

/**
 * Resolve a file path using the folder hierarchy.
 * Traverses parentId chain up to rootFolderId.
 * @returns resolved path, or null if any ancestor is unknown
 */
export function resolvePathFromHierarchy(
	hierarchy: FolderHierarchy,
	parentId: string,
	fileName: string,
): string | null {
	if (parentId === hierarchy.rootFolderId) return fileName;

	const parts: string[] = [fileName];
	let currentId = parentId;

	while (currentId !== hierarchy.rootFolderId) {
		const folder = hierarchy.folders.get(currentId);
		if (!folder) return null; // Unknown folder — fall back to full scan
		parts.unshift(folder.name);
		currentId = folder.parentId;
	}

	return parts.join("/");
}

/** Serialize a FolderHierarchy to JSON string for storage */
export function serializeFolderHierarchy(hierarchy: FolderHierarchy): string {
	const stored: StoredFolderHierarchy = {
		rootFolderId: hierarchy.rootFolderId,
		folders: {},
	};
	for (const [id, { name, parentId }] of hierarchy.folders) {
		stored.folders[id] = { n: name, p: parentId };
	}
	return JSON.stringify(stored);
}

/** Deserialize a FolderHierarchy from a JSON string */
export function deserializeFolderHierarchy(json: string): FolderHierarchy | null {
	try {
		const stored = JSON.parse(json) as StoredFolderHierarchy;
		if (!stored.rootFolderId || typeof stored.folders !== "object") return null;
		const folders = new Map<string, { name: string; parentId: string }>();
		for (const [id, entry] of Object.entries(stored.folders)) {
			if (typeof entry.n === "string" && typeof entry.p === "string") {
				folders.set(id, { name: entry.n, parentId: entry.p });
			}
		}
		return { folders, rootFolderId: stored.rootFolderId };
	} catch {
		return null;
	}
}

/**
 * Build a FolderHierarchy from DriveFile list (e.g., after fullScan).
 * Only includes folders whose parents chain reaches rootFolderId.
 */
export function buildFolderHierarchy(
	files: DriveFile[],
	rootFolderId: string,
): FolderHierarchy {
	const hierarchy: FolderHierarchy = {
		folders: new Map(),
		rootFolderId,
	};

	// Build id → file map for lookup
	const byId = new Map<string, DriveFile>();
	for (const file of files) {
		if (file.mimeType === FOLDER_MIME) {
			byId.set(file.id, file);
		}
	}

	// For each folder, find the relevant parent (the one in our tree)
	for (const [id, file] of byId) {
		if (!file.parents || file.parents.length === 0) continue;

		// Prefer rootFolderId as parent, then any known folder parent
		const parentId = file.parents.includes(rootFolderId)
			? rootFolderId
			: file.parents.find((p) => byId.has(p) || p === rootFolderId);

		if (parentId) {
			hierarchy.folders.set(id, { name: file.name, parentId });
		}
	}

	return hierarchy;
}
