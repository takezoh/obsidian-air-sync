import type { RemoteChange, RemoteObject } from "../../backend-api";
import { normalizeSyncPath } from "../../utils/path";
import type { RenamePair } from "../types";
import type { AddressDisplacement } from "../caching/metadata-cache";
import type { IdDeltaEntry } from "../caching/id-delta";
import { applyIdDeltaPage, createIdDeltaResult } from "../caching/id-delta";
import type { NormalizedMetadataCache } from "./normalized-metadata-cache";

/** The paths, rename pairs, and contentions one adapter delta produced. */
export interface ProjectedDelta {
	changedPaths: Set<string>;
	renamedPaths: RenamePair[];
	contended: readonly AddressDisplacement[];
}

/**
 * Apply one adapter delta to the normalized cache and report what it touched.
 *
 * Id-addressed changes (upserts, and id-keyed tombstones) go through the shared
 * `applyIdDeltaPage`, which sorts folders shallow-first, arbitrates contended
 * addresses, and settles standing contentions. A path-addressed tombstone has no
 * stable id and core will not mint one for it, so it is handled separately:
 * after every id entry is applied, a path that still holds an object is removed
 * by its real cached id(s). A path a rename already vacated is skipped, and a
 * path a same-delta upsert wrote is skipped too — exactly the guards the
 * order-independent Dropbox drain uses, because a tombstone that trails a
 * reclaim must never drop the live object.
 */
export function applyRemoteChanges(
	cache: NormalizedMetadataCache,
	changes: readonly RemoteChange[],
): ProjectedDelta {
	const acc = createIdDeltaResult();
	const entries: IdDeltaEntry<RemoteObject>[] = [];
	const pathDeletes: string[] = [];
	const upsertedIds = new Map<string, string>();
	for (const change of changes) {
		if (change.kind === "upsert") {
			entries.push({
				id: change.object.id,
				isFolder: change.object.kind === "directory",
				file: change.object,
			});
			const resolved = cache.resolvePathFromCache(change.object);
			if (resolved !== null) upsertedIds.set(resolved, change.object.id);
		} else if ("id" in change) {
			entries.push({ id: change.id, isFolder: false, file: undefined });
		} else {
			pathDeletes.push(normalizeSyncPath(change.path));
		}
	}
	// A path-addressed tombstone and a same-delta upsert at that path with a DIFFERENT
	// stable id is a delete-then-recreate: the upsert is the live object, and the
	// tombstoned occupant must be cleared BEFORE id arbitration or the incumbent's
	// lower id would withhold the genuinely new object. A same-id reclaim keeps the
	// occupant (the trailing tombstone is then skipped below).
	for (const path of pathDeletes) {
		const upsertId = upsertedIds.get(path);
		if (upsertId === undefined) continue;
		const occupant = cache.idAt(path);
		if (occupant !== undefined && occupant !== upsertId) cache.removeEntry(path);
	}
	applyIdDeltaPage(cache, acc, entries);
	for (const path of pathDeletes) {
		if (upsertedIds.has(path) || !cache.hasFile(path)) continue;
		for (const path2 of [path, ...cache.collectDescendants(path)]) acc.changedPaths.add(path2);
		cache.removeTree(path);
	}
	return { changedPaths: acc.changedPaths, renamedPaths: acc.renamedPaths, contended: acc.displacements };
}
