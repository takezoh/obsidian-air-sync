import { AdaptivePool } from "../../queue/async-queue";
import { classifyGoogleDriveError } from "./errors";
import { decideRetry, sleep as defaultSleep } from "../errors";
import { FOLDER_MIME, LIST_PAGE_CAP } from "./types";
import type { GoogleDriveFile, GoogleDriveFileList } from "./types";

/** Per-page retry attempts for the full-scan listing (rate-limit / transient). */
const MAX_LIST_RETRIES = 3;

/**
 * Recursively list every file under `rootFolderId` with **adaptive** concurrency
 * and per-page rate-limit retry. Split out of the client (principle #7) so the
 * recursive enumeration + its AIMD/retry policy is independently testable.
 *
 * Reached only on a cold/initial scan, a rescan, or the 410 cursor-expiry full
 * scan — never the steady-state hot/warm delta path. Concurrency is an
 * `AdaptivePool` (start 3 ⇒ no change at t=0; ramps toward 8 on sustained success,
 * halves on a rate-limit). Each page (`listFiles`) is retried up to
 * `MAX_LIST_RETRIES` on a `rateLimit`/`transient` error honoring `Retry-After`; on
 * a rate-limit the pool is signalled (`noteRateLimit`) BEFORE the backoff sleep so
 * its ceiling drops immediately while the task holds its slot (a natural throttle).
 * `auth`/`permission`/`notFound` propagate, failing the scan exactly as before.
 *
 * `sleepFn` is injectable so tests run instantly.
 */
export async function listAllFiles(
	listFiles: (folderId: string, pageToken?: string) => Promise<GoogleDriveFileList>,
	rootFolderId: string,
	sleepFn: (ms: number) => Promise<void> = defaultSleep,
): Promise<GoogleDriveFile[]> {
	const allFiles: GoogleDriveFile[] = [];
	const pool = new AdaptivePool({ min: 1, start: 3, max: 8, rampAfter: 8 });
	const tasks: Promise<void>[] = [];
	// Capture each task's rejection so a failing folder can't leave a sibling task's
	// rejection unhandled when the drain below stops early. The first error is rethrown
	// after all in-flight tasks settle (the scan still fails atomically).
	let failed = false;
	let firstError: unknown;

	const listPage = async (
		folderId: string,
		pageToken: string | undefined,
	): Promise<GoogleDriveFileList> => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await listFiles(folderId, pageToken);
			} catch (err) {
				const classification = classifyGoogleDriveError(err);
				const decision = decideRetry(classification, attempt, MAX_LIST_RETRIES, Math.random);
				if (decision.action !== "retry") throw err;
				if (classification.kind === "rateLimit") pool.noteRateLimit();
				await sleepFn(decision.delayMs);
			}
		}
	};

	const enqueueFolder = (folderId: string): void => {
		const task = pool.run(async () => {
			let pageToken: string | undefined;
			// Bound the pagination drain: a server that never clears nextPageToken
			// would otherwise loop forever. 10k pages × 1000 files/page is far beyond
			// any real folder, so hitting it means a misbehaving server — throw rather
			// than silently truncate (a short listing would read as mass deletion).
			for (let guard = 0; guard < LIST_PAGE_CAP; guard++) {
				const result = await listPage(folderId, pageToken);
				for (const file of result.files) {
					allFiles.push(file);
					if (file.mimeType === FOLDER_MIME) {
						enqueueFolder(file.id);
					}
				}
				pageToken = result.nextPageToken;
				if (!pageToken) return;
			}
			throw new Error(
				`listAllFiles: pagination exceeded ${LIST_PAGE_CAP} pages for folder ${folderId} (server not clearing nextPageToken?)`
			);
		}).catch((err) => {
			if (!failed) {
				failed = true;
				firstError = err;
			}
		});
		tasks.push(task);
	};

	enqueueFolder(rootFolderId);

	// Drain the dynamically-growing list. Every task resolves (errors captured above),
	// so a failure never leaves an in-flight folder's rejection unhandled; rethrow the
	// first captured error once all tasks have settled.
	for (let i = 0; i < tasks.length; i++) await tasks[i];
	if (failed) throw firstError;

	return allFiles;
}
