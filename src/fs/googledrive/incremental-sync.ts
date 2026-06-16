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

		if (acc.count > 0) {
			ctx.logger?.info("Incremental changes applied", { changeCount: acc.count });
		}
		// The in-memory cache now reflects the changes; persistence to IndexedDB is
		// the caller's job at checkpoint commit (see GoogleDriveFs.commitCheckpoint).
		return { newToken: currentToken, needsFullScan: false, changedPaths: acc.changedPaths, renamedPaths: acc.renamedPaths };
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
