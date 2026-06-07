import { FOLDER_MIME } from "./types";
import type { DriveFile } from "./types";
import type { DriveMetadataCache } from "./metadata-cache";
import { LIST_PAGE_CAP } from "./client";
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

		// Bound the drain: a server that never clears nextPageToken would loop
		// forever. 10k pages of changes is far beyond any real delta, so throw
		// rather than spin (mirrors the full-list cap in listAllFiles).
		for (let guard = 0; ; guard++) {
			if (guard >= LIST_PAGE_CAP) {
				throw new Error(
					`applyIncrementalChanges: changes pagination exceeded ${LIST_PAGE_CAP} pages (server not clearing nextPageToken?)`,
				);
			}
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
			if (!pageToken) break;
		}

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
 * IndexedDB meta key under which the delta cursor is persisted, ALONGSIDE the
 * file map and in the SAME transaction (see {@link commitDriveCache}). Co-locating
 * the cursor with the cache is what makes the checkpoint atomic — there is no
 * separate settings write that a crash could leave out of step with the cache.
 */
export const CHANGES_CURSOR_KEY = "changesStartPageToken";

/**
 * Flush the metadata cache AND the delta cursor to IndexedDB at a checkpoint
 * commit, atomically. `fullPersist` rewrites the whole map (after a full scan);
 * otherwise the touched paths are reconciled against the live cache — present →
 * upsert, absent → delete. The reconcile reads the final cache state, so it is
 * order-independent and correct even when `touched` spans several earlier failed
 * cycles. The cursor is written in the SAME transaction as the file changes, so
 * the persisted cache can never run ahead of (or behind) the committed cursor.
 */
export async function commitDriveCache(
	store: MetadataStore<DriveFile>,
	cache: DriveMetadataCache,
	touched: Set<string>,
	fullPersist: boolean,
	cursor: string | null,
): Promise<void> {
	await store.open();
	const meta = cursor ? new Map([[CHANGES_CURSOR_KEY, cursor]]) : new Map<string, string>();
	if (fullPersist) {
		await store.saveAll(cache.exportRecords(), meta);
		return;
	}
	const updated: { path: string; file: DriveFile; isFolder: boolean }[] = [];
	const deleted: string[] = [];
	for (const path of touched) {
		const file = cache.getFile(path);
		if (file) updated.push({ path, file, isFolder: cache.isFolder(path) });
		else deleted.push(path);
	}
	await store.commitIncremental(updated, deleted, meta);
}

/** Snapshot the cache's current path-by-Drive-id mapping (before a 410 full-scan diff). */
export function snapshotPathsById(cache: DriveMetadataCache): Map<string, string> {
	const byId = new Map<string, string>();
	for (const [path, file] of cache.entries()) byId.set(file.id, path);
	return byId;
}

/**
 * Compute a remote delta by diffing a pre-scan path-by-id snapshot against the
 * freshly-scanned cache — the 410 (cursor-expired) fallback. Keys on Drive id, so
 * it detects adds/deletes/renames but NOT in-place content edits (same path+id);
 * those are caught by the next incremental sync or WARM mode's local-vs-record check.
 */
export function diffCacheByDriveId(
	oldPathById: Map<string, string>,
	cache: DriveMetadataCache,
	logger?: Logger,
): { modified: string[]; deleted: string[]; renamed: RenamePair[] } {
	const modified: string[] = [];
	const deleted: string[] = [];
	const renamed: RenamePair[] = [];
	const newIds = new Set<string>();
	for (const [newPath, file] of cache.entries()) {
		newIds.add(file.id);
		const oldPath = oldPathById.get(file.id);
		if (!oldPath) {
			modified.push(newPath);
		} else if (oldPath !== newPath) {
			renamed.push({ oldPath, newPath, isFolder: cache.isFolder(newPath) || undefined });
			modified.push(newPath);
			deleted.push(oldPath);
		}
	}
	for (const [id, oldPath] of oldPathById) {
		if (!newIds.has(id)) deleted.push(oldPath);
	}
	if (modified.length > 0 || deleted.length > 0 || renamed.length > 0) {
		logger?.info("Full scan delta", {
			added: modified.length - renamed.length,
			deleted: deleted.length - renamed.length,
			renamed: renamed.length,
		});
	}
	return { modified, deleted, renamed };
}

/** Check if an error is an HTTP error with the given status code */
export function isHttpError(err: unknown, status: number): boolean {
	if (err && typeof err === "object" && "status" in err) {
		return (err as { status: number }).status === status;
	}
	return false;
}
