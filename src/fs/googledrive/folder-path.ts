import type { DriveClient } from "./client";
import type { Logger } from "../../logging/logger";
import { isHttpError } from "./incremental-sync";

/** Hard cap on the parent walk — guards against unexpectedly deep trees / cycles. */
const MAX_PATH_DEPTH = 50;

/**
 * Best-effort resolve the My Drive root folder id. Under the `drive.file` scope
 * the root may not be readable; returns undefined then. Knowing the root id lets
 * the walk recognize "reached the top" cleanly instead of mistaking the
 * (unreadable-by-design) root for a truncated ancestor.
 */
async function resolveRootId(client: DriveClient): Promise<string | undefined> {
	try {
		return (await client.getFile("root")).id;
	} catch {
		return undefined;
	}
}

/**
 * Build a human-readable "/"-joined path for a Drive folder by walking its
 * parent chain from the folder up toward My Drive (e.g. "Work/Projects/Notes").
 *
 * Why the result can be partial: the built-in backend uses the `drive.file`
 * OAuth scope, under which the app can read the items the user granted via the
 * Google Picker (the picked folder, the folders above it that were granted, and
 * their contents) but not arbitrary ancestors. getFile() on an ungranted
 * ancestor returns 404. When we can identify the My Drive root we stop there
 * cleanly; if instead we stop on an ungranted *non-root* ancestor we prefix the
 * result with "…/" to signal there are more (hidden) folders above. If the root
 * can't be identified at all we show the clean partial path rather than a
 * possibly-misleading marker. Under a full `drive` scope the whole chain
 * resolves and the absolute path is returned.
 *
 * Returns null only when the bound folder itself cannot be read.
 */
export async function resolveFolderPath(
	client: DriveClient,
	folderId: string,
	logger?: Logger,
): Promise<string | null> {
	let file;
	try {
		file = await client.getFile(folderId);
	} catch (err) {
		logger?.warn("Could not read bound Drive folder for path display", {
			folderId,
			message: err instanceof Error ? err.message : String(err),
		});
		return null;
	}

	const rootId = await resolveRootId(client);

	const segments = [file.name];
	const seen = new Set<string>([file.id]);
	let parents = file.parents;
	let truncated = false;

	for (let depth = 0; depth < MAX_PATH_DEPTH; depth++) {
		const parentId = parents?.[0];
		if (!parentId || parentId === rootId) break; // reached My Drive root → path complete
		if (seen.has(parentId)) break; // cycle guard

		seen.add(parentId);
		let parent;
		try {
			parent = await client.getFile(parentId);
		} catch (err) {
			if (isHttpError(err, 404)) {
				// Stopped at an unreadable ancestor. Only flag truncation when we know
				// it isn't the (unreadable-by-design) root — i.e. we resolved rootId.
				// Without rootId we can't tell the root from a real ancestor, so we
				// show the clean partial path instead of a misleading marker.
				if (rootId !== undefined) {
					logger?.info("Drive ancestor not accessible under granted scope; path is partial", {
						parentId,
					});
					truncated = true;
				}
				break;
			}
			throw err;
		}

		// The root ("My Drive") has no parents — stop before it so it never appears
		// as a path segment.
		if (!parent.parents || parent.parents.length === 0) break;
		segments.unshift(parent.name);
		parents = parent.parents;
	}

	const path = segments.join("/");
	return truncated ? `…/${path}` : path;
}
