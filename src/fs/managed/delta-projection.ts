import type { RemoteAddressing, RemoteChange, RemoteObject } from "../../backend-api";
import { normalizeSyncPath } from "../../utils/path";
import type { RenamePair } from "../types";
import type { AddressDisplacement } from "../caching/metadata-cache";
import type { IdDeltaEntry } from "../caching/id-delta";
import { applyIdDeltaPage, createIdDeltaResult } from "../caching/id-delta";
import type { NormalizedMetadataCache } from "./normalized-metadata-cache";
import { RemoteObjectValidationError, validateRemoteChanges } from "./remote-object-validation";

/** The paths, rename pairs, contentions, and entered-folder targets one adapter delta produced. */
export interface ProjectedDelta {
	changedPaths: Set<string>;
	renamedPaths: RenamePair[];
	contended: readonly AddressDisplacement[];
	/**
	 * The stable ids of folders that newly entered the bound root during this
	 * projection, in first-entered order. Per-call bookkeeping only: core consumes
	 * it to complete the delta by listing exactly those folders' subtrees, and
	 * discards it with the call.
	 */
	enteredFolderIds: readonly string[];
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
	return {
		changedPaths: acc.changedPaths,
		renamedPaths: acc.renamedPaths,
		contended: acc.displacements,
		enteredFolderIds: [...acc.enteredFolderIds],
	};
}

/**
 * The folder ids to complete a delta over, in first-entered order.
 *
 * Each entered id is resolved to the path it holds AS OF DRAIN END, not the one it
 * had when recorded: a later page may have moved or renamed an ancestor. An id that
 * no longer resolves left the root again, so its descendants are out of scope and
 * the drain already reported them. A target nested under another target is dropped —
 * the ancestor's walk covers it — using a `/`-delimited test so a sibling whose name
 * merely extends another's ("Notes2" under "Notes") stays its own target.
 *
 * Core owns this selection: the adapter is stateless and reads no cache, so it
 * cannot distinguish a folder that newly entered from one already addressable.
 */
export function relistTargets(
	cache: NormalizedMetadataCache,
	enteredFolderIds: readonly string[],
): string[] {
	const resolved: { id: string; path: string }[] = [];
	for (const id of enteredFolderIds) {
		const path = cache.getPathById(id);
		if (path !== undefined) resolved.push({ id, path });
	}
	return resolved
		.filter(({ path }) => !resolved.some((other) => path.startsWith(other.path + "/")))
		.map(({ id }) => id);
}

/**
 * Complete a projected delta by listing the subtree of every folder that newly
 * entered the bound root, once per topmost target, in first-entered order, strictly
 * one at a time after the whole drain. The returned facts merge upsert-only through
 * the same apply, so absence never removes, tombstones or re-keys a cached entry.
 *
 * A rejected listing propagates and aborts the attempt; a `cursor_invalid` outcome
 * for any target makes the whole call take the existing full-scan fallback — a
 * partial delta is never returned. `readSubtree` is the adapter's optional declared
 * provider read; when absent the delta is already complete.
 */
export async function completeDelta(
	cache: NormalizedMetadataCache,
	initial: ProjectedDelta,
	readSubtree: ((id: string) => Promise<unknown>) | undefined,
	addressing: RemoteAddressing,
): Promise<ProjectedDelta | "cursor_invalid"> {
	if (readSubtree === undefined) return initial;
	const targets = relistTargets(cache, initial.enteredFolderIds);
	if (targets.length === 0) return initial;
	const changedPaths = initial.changedPaths;
	const renamedPaths = [...initial.renamedPaths];
	const contended: AddressDisplacement[] = [...initial.contended];
	for (const id of targets) {
		const result = await readSubtree(id);
		if (!isRecord(result)) invalidSubtreeResult();
		if (result.kind === "cursor_invalid") return "cursor_invalid";
		if (result.kind !== "subtree" || !Array.isArray(result.objects)) invalidSubtreeResult();
		const upserts: RemoteChange[] = result.objects.map((object) => ({
			kind: "upsert",
			object: object as RemoteObject,
		}));
		// Validate the raw boundary payload against the adapter's declared addressing
		// before anything reaches the cache: a malformed object or a location scheme
		// that disagrees with the declaration is a permanent structural failure, never a
		// silently accepted partial subtree.
		const merged = applyRemoteChanges(cache, validateRemoteChanges(upserts, addressing));
		for (const path of merged.changedPaths) changedPaths.add(path);
		renamedPaths.push(...merged.renamedPaths);
		contended.push(...merged.contended);
	}
	return { changedPaths, renamedPaths, contended, enteredFolderIds: initial.enteredFolderIds };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSubtreeResult(): never {
	throw new RemoteObjectValidationError("subtree read returned an unrecognized result");
}
