import { FOLDER_MIME } from "./types";
import type { DriveFile } from "./types";
import type { DriveMetadataCache } from "./metadata-cache";
import type { DriveClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { RenamePair } from "../../sync/types";
import type { Logger } from "../../logging/logger";

/**
 * Context for incremental sync operations. Note there is no metadataStore here:
 * applying changes mutates only the in-memory cache. Persisting the cache to
 * IndexedDB is deferred to the checkpoint commit (GoogleDriveFs.commitCheckpoint),
 * so the persisted cache never runs ahead of the committed delta cursor.
 */
export interface IncrementalSyncContext {
	cache: DriveMetadataCache;
	client: DriveClient;
	logger?: Logger;
}

export type IncrementalChangesResult =
	| { needsFullScan: false; newToken: string; changedPaths: Set<string>; renamedPaths: RenamePair[] }
	| { needsFullScan: true; changedPaths: Set<string> };

/**
 * Apply incremental changes from the Drive changes.list API.
 * Updates the metadata cache and returns the new page token.
 * Falls back to full re-scan (by setting initialized=false) on 410.
 *
 * @returns The new changes page token, or null if a full scan is needed.
 */
export async function applyIncrementalChanges(
	ctx: IncrementalSyncContext,
	changesPageToken: string,
): Promise<IncrementalChangesResult> {
	try {
		let pageToken: string | undefined;
		let currentToken = changesPageToken;

		let totalChanges = 0;
		const changedPaths = new Set<string>();
		const renamedPaths: RenamePair[] = [];

		do {
			const result = await ctx.client.listChanges(
				changesPageToken,
				pageToken
			);

			// Process folder changes first (shallow before deep) so paths resolve correctly
			const sorted = [...result.changes].sort((a, b) => {
				const aIsFolder =
					a.file?.mimeType === FOLDER_MIME ? 0 : 1;
				const bIsFolder =
					b.file?.mimeType === FOLDER_MIME ? 0 : 1;
				if (aIsFolder !== bIsFolder) return aIsFolder - bIsFolder;
				// Among folders, sort by cached path depth (shallow first)
				if (aIsFolder === 0) {
					const aPath = ctx.cache.getPathById(a.fileId) ?? "";
					const bPath = ctx.cache.getPathById(b.fileId) ?? "";
					return aPath.split("/").length - bPath.split("/").length;
				}
				return 0;
			});

			totalChanges += sorted.length;
			for (const change of sorted) {
				if (change.removed || change.file?.trashed) {
					const path = ctx.cache.getPathById(change.fileId);
					if (path) {
						// Collect descendants before removing
						const descendants = ctx.cache.collectDescendants(path);
						changedPaths.add(path);
						for (const d of descendants) changedPaths.add(d);
						ctx.cache.removeTree(path);
					}
				} else if (change.file) {
					const { oldPath, newPath: updatedPath, wasFolder, oldDescendants } =
						ctx.cache.applyFileChangeDetectMove(change.file);

					if (updatedPath) {
						changedPaths.add(updatedPath);
					}

					// File was moved/renamed — report old path(s) as deleted
					const moved = oldPath && updatedPath && oldPath !== updatedPath;
					const movedOutOfRoot = oldPath && !updatedPath;
					if (moved || movedOutOfRoot) {
						changedPaths.add(oldPath);
						for (const d of oldDescendants) {
							changedPaths.add(d);
						}
					}
					if (moved) {
						renamedPaths.push({ oldPath, newPath: updatedPath, isFolder: wasFolder || undefined });
					}

					// Folder move — also report new descendant paths as updated
					if (moved && wasFolder) {
						const newDescendants = ctx.cache.collectDescendants(updatedPath);
						for (const nd of newDescendants) {
							changedPaths.add(nd);
						}
					}
				}
			}

			pageToken = result.nextPageToken;
			if (result.newStartPageToken) {
				currentToken = result.newStartPageToken;
			}
		} while (pageToken);

		if (totalChanges > 0) {
			ctx.logger?.info("Incremental changes applied", { changeCount: totalChanges });
		}
		// The in-memory cache now reflects the changes; persistence to IndexedDB is
		// the caller's job at checkpoint commit (see GoogleDriveFs.commitCheckpoint).
		return { newToken: currentToken, needsFullScan: false, changedPaths, renamedPaths };
	} catch (err) {
		if (isHttpError(err, 410)) {
			// Token expired, fall back to full scan
			ctx.logger?.info("Changes token expired (410), falling back to full scan");
			return { needsFullScan: true, changedPaths: new Set<string>() };
		}
		throw err;
	}
}

/**
 * Flush the metadata cache to IndexedDB at a checkpoint commit. `fullPersist`
 * rewrites the whole map (after a full scan); otherwise the touched paths are
 * reconciled against the live cache — present → upsert, absent → delete. The
 * reconcile reads the final cache state, so it is order-independent and correct
 * even when `touched` spans several earlier failed cycles.
 */
export async function commitDriveCache(
	store: MetadataStore<DriveFile>,
	cache: DriveMetadataCache,
	touched: Set<string>,
	fullPersist: boolean,
): Promise<void> {
	await store.open();
	if (fullPersist) {
		await store.saveAll(cache.exportRecords(), new Map());
		return;
	}
	const updated: { path: string; file: DriveFile; isFolder: boolean }[] = [];
	const deleted: string[] = [];
	for (const path of touched) {
		const file = cache.getFile(path);
		if (file) updated.push({ path, file, isFolder: cache.isFolder(path) });
		else deleted.push(path);
	}
	if (updated.length > 0) await store.putFiles(updated);
	if (deleted.length > 0) await store.deleteFiles(deleted);
}

/** Check if an error is an HTTP error with the given status code */
export function isHttpError(err: unknown, status: number): boolean {
	if (err && typeof err === "object" && "status" in err) {
		return (err as { status: number }).status === status;
	}
	return false;
}
