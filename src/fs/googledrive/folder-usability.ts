import type { GoogleDriveClient } from "./client";
import type { GoogleDriveFile } from "./types";
import { FOLDER_MIME, isGoogleDriveTrashed } from "./types";
import { isHttpError } from "./incremental-sync";
import { classifyGoogleDriveError } from "./errors";

/**
 * The single seam that decides whether a Google Drive folder is usable, and — when
 * it is not — why, from the metadata already returned by `getFile`.
 *
 * Why a seam: every binding path (the Picker, the cached-id rebind, the default
 * folder, and the custom OAuth hand-typed id) asks the same question, and so does
 * the settings display. Answering it in each place let a new condition (access
 * revoked, moved outside the granted scope, the wrong Drive account) be forgotten
 * at all but the site that happened to be edited. `trashed` is already requested by
 * `FILE_FIELDS` (client.ts), so this costs no extra request — it is placement, not
 * cost.
 *
 * This module owns only the decision. How to present a non-usable folder — throw
 * with which message, or map to `null` for an identity that no longer exists — stays
 * with the caller, because the right answer differs by context.
 */
export type GoogleDriveFolderProblem =
	| "not_found"
	| "inaccessible"
	| "not_folder"
	| "trashed";

/**
 * `not_found` / `inaccessible` come from the fetch and always carry the original
 * error; `not_folder` / `trashed` are properties of a fetched file. Splitting the
 * union this way means a caller can rethrow the accessibility failure's `cause`
 * without a possibly-undefined value, and a new problem forces both a fetch-error
 * and a fetched-file decision.
 */
export type GoogleDriveFolderInspection =
	| { usable: true; file: GoogleDriveFile }
	| { usable: false; problem: "not_folder" | "trashed" }
	| { usable: false; problem: "not_found" | "inaccessible"; cause: unknown };

/** Classification of a file already fetched from Drive (no fetch-error arm). */
export type GoogleDriveFetchedFolderProblem = "not_folder" | "trashed";
export type GoogleDriveFetchedFolderInspection =
	| { usable: true; file: GoogleDriveFile }
	| { usable: false; problem: GoogleDriveFetchedFolderProblem };

/**
 * Classify a file already read from Drive. Used by the settings display, which
 * already has the file in hand, so it too reads the decision through this seam
 * rather than inspecting `trashed` itself.
 */
export function classifyFetchedGoogleDriveFolder(
	file: GoogleDriveFile,
): GoogleDriveFetchedFolderInspection {
	if (file.mimeType !== FOLDER_MIME) return { usable: false, problem: "not_folder" };
	if (isGoogleDriveTrashed(file)) return { usable: false, problem: "trashed" };
	return { usable: true, file };
}

/**
 * Read a folder by id and classify it. A 404 (gone / not granted) and a genuine 403
 * permission failure are returned as problems with the original error on `cause`.
 * A 403 that is actually a rate limit, and every other failure (auth, transient,
 * server), is rethrown unchanged so the caller keeps its existing classification and
 * retry behaviour — R3.
 */
export async function inspectGoogleDriveFolder(
	client: GoogleDriveClient,
	folderId: string,
): Promise<GoogleDriveFolderInspection> {
	let file: GoogleDriveFile;
	try {
		file = await client.getFile(folderId);
	} catch (err) {
		if (isHttpError(err, 404)) return { usable: false, problem: "not_found", cause: err };
		if (isHttpError(err, 403) && classifyGoogleDriveError(err).kind === "permission") {
			return { usable: false, problem: "inaccessible", cause: err };
		}
		throw err;
	}

	return classifyFetchedGoogleDriveFolder(file);
}
