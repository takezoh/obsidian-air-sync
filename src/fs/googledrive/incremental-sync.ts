import { FOLDER_MIME } from "./types";
import type { GoogleDriveChange, GoogleDriveFile } from "./types";
import { LIST_PAGE_CAP } from "./client";
import type { GoogleDriveClient } from "./client";
import type { Logger } from "../../logging/logger";
import type { AbstractMetadataCache } from "../caching/metadata-cache";
import type { IncrementalChangesResult } from "../caching/remote-fs";
import { applyIdDeltaPage, createIdDeltaResult, type IdDeltaEntry } from "../caching/id-delta";

/**
 * Context for incremental sync operations. Note there is no metadataStore here:
 * applying changes mutates only the in-memory cache. Persisting the cache to
 * IndexedDB is deferred to the checkpoint commit (CachingRemoteFs.commitCheckpoint),
 * so the persisted cache never runs ahead of the committed delta cursor.
 */
export interface IncrementalSyncContext {
	cache: AbstractMetadataCache<GoogleDriveFile>;
	client: GoogleDriveClient;
	logger?: Logger;
}

/**
 * Apply incremental changes from the Google Drive changes.list API.
 * Updates the metadata cache and returns the new page token.
 * Falls back to full re-scan (by setting initialized=false) on 410.
 *
 * `changes.list` reports one change per changed item, so moving a folder into the
 * bound root reports only that folder — its unchanged descendants produce nothing.
 * After the drain this therefore completes every folder that entered the root
 * (see {@link relistTargets}) from its current subtree listing, so the caller's
 * working view holds the same facts a cold scan would. That listing is the only
 * `listAllFiles` use on the incremental path.
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
		const acc = createIdDeltaResult();

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

			// The per-page apply (folder ordering, move classification, subtree
			// removal) is shared with OneDrive via applyIdDeltaPage.
			applyIdDeltaPage(ctx.cache, acc, toEntries(result.changes));

			pageToken = result.nextPageToken;
			if (result.newStartPageToken) {
				currentToken = result.newStartPageToken;
			}
			if (!pageToken) break;
		}

		// Complete every folder that entered the bound root during this drain. One
		// walk per topmost target, strictly one at a time (at most one AdaptivePool
		// in flight), merged through the same per-page apply: the listing is
		// parent-first, so a child always resolves against an already-placed parent.
		// This sits inside the existing try — a rejection propagates, the cursor is
		// never advanced, and the attempt aborts without committing.
		for (const folderId of relistTargets(ctx.cache, acc.enteredFolderIds)) {
			const files = await ctx.client.listAllFiles(folderId);
			applyIdDeltaPage(ctx.cache, acc, files.map(toListedEntry));
		}

		if (acc.count > 0) {
			ctx.logger?.info("Incremental changes applied", { changeCount: acc.count });
		}
		// The in-memory cache now reflects the changes; persistence to IndexedDB is
		// the caller's job at checkpoint commit (see GoogleDriveFs.commitCheckpoint).
		// The drain settled its contentions at the last page close, so these are the
		// losses that still stand. Carrying them is what gives the delta route a
		// declared producer for `RemoteDelta.contended`: without it every absence a
		// contention caused would read as a provider deletion, and no contention
		// could ever reach the remediation stage.
		return { newToken: currentToken, needsFullScan: false, changedPaths: acc.changedPaths, renamedPaths: acc.renamedPaths, contended: acc.displacements };
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
 * The folder ids to re-list once the drain has finished, in first-entered order.
 *
 * Each entered id is resolved to the path it holds AS OF DRAIN END, not the one it
 * had when it was recorded: a later page may have moved or renamed an ancestor. An
 * id that no longer resolves left the root again (moved out or tombstoned), so its
 * descendants are out of scope and the drain already reported them as deleted. A
 * target nested under another target is dropped — the ancestor's walk covers it —
 * using a `/`-delimited test so a sibling whose name merely extends another's
 * ("Notes2" under "Notes") stays its own target.
 *
 * The set is read once here. Ids that the merges themselves record are descendants
 * of a target already listed, so re-reading it would only re-walk the same subtree.
 */
function relistTargets(
	cache: AbstractMetadataCache<GoogleDriveFile>,
	enteredFolderIds: ReadonlySet<string>,
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

/** Map one listed subtree item to a delta entry, so it merges through the same apply path. */
function toListedEntry(file: GoogleDriveFile): IdDeltaEntry<GoogleDriveFile> {
	return { id: file.id, isFolder: file.mimeType === FOLDER_MIME, file };
}

/**
 * Map a `changes.list` page to normalized delta entries. A `removed` or `trashed`
 * change is a tombstone; a change carrying a `file` is an upsert; a change with
 * neither (no file and not removed) is ignored — it carries nothing to apply.
 */
function toEntries(changes: GoogleDriveChange[]): IdDeltaEntry<GoogleDriveFile>[] {
	const entries: IdDeltaEntry<GoogleDriveFile>[] = [];
	for (const change of changes) {
		if (change.removed || change.file?.trashed) {
			entries.push({ id: change.fileId, isFolder: change.file?.mimeType === FOLDER_MIME, file: undefined });
		} else if (change.file) {
			entries.push({ id: change.fileId, isFolder: change.file.mimeType === FOLDER_MIME, file: change.file });
		}
	}
	return entries;
}

/** Check if an error is an HTTP error with the given status code */
export function isHttpError(err: unknown, status: number): boolean {
	if (err && typeof err === "object" && "status" in err) {
		return (err as { status: number }).status === status;
	}
	return false;
}
