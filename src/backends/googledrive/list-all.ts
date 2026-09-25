import { AdaptivePool } from "../../backend-api/async-queue";
import { classifyGoogleDriveError } from "./errors";
import { decideRetry, sleep as defaultSleep } from "../../backend-api/error-classification";
import { FOLDER_MIME, LIST_PAGE_CAP } from "./types";
import type { GoogleDriveFile, GoogleDriveFileList } from "./types";
import type { BackendLogger } from "../../backend-api";

/** Per-page retry attempts for the full-scan listing (rate-limit / transient). */
const MAX_LIST_RETRIES = 3;

/** Cap the ids named in the repeated-id warning so one bad scan can't flood the log. */
const REPEATED_ID_SAMPLE = 10;

/**
 * Recursively list every file under `rootFolderId` with **adaptive** concurrency
 * and per-page rate-limit retry. Split out of the client (principle #7) so the
 * recursive enumeration + its AIMD/retry policy is independently testable.
 *
 * Reached on a cold/initial scan, a rescan, or the 410 cursor-expiry full scan —
 * and, on the incremental path, for the one scoped exception: `changes.list`
 * reports only the changed item, so core re-lists each folder that newly entered the
 * bound root (via the adapter's declared `listSubtreeById`) to recover the
 * descendants Google Drive never sends. A steady-state delta with no entering
 * folder still issues no walk at all. Concurrency is an
 * `AdaptivePool` (start 3 ⇒ no change at t=0; ramps toward 8 on sustained success,
 * halves on a rate-limit). Each page (`listFiles`) is retried up to
 * `MAX_LIST_RETRIES` on a `rateLimit`/`transient` error honoring `Retry-After`; on
 * a rate-limit the pool is signalled (`noteRateLimit`) BEFORE the backoff sleep so
 * its ceiling drops immediately while the task holds its slot (a natural throttle).
 * `auth`/`permission`/`notFound` propagate, failing the scan exactly as before.
 *
 * The result is keyed by stable id and each folder is walked once, so neither a
 * repeated file nor a repeated folder can reach the cache (see the body).
 *
 * `sleepFn` is injectable so tests run instantly.
 */
export async function listAllFiles(
	listFiles: (folderId: string, pageToken?: string) => Promise<GoogleDriveFileList>,
	rootFolderId: string,
	opts: { sleepFn?: (ms: number) => Promise<void>; logger?: BackendLogger } = {},
): Promise<GoogleDriveFile[]> {
	const { sleepFn = defaultSleep, logger } = opts;
	// Keyed by stable id, not a flat array: one file can be returned by two folder
	// listings (a legacy multi-parent file whose parents are both in scope), and a
	// single folder's pages are not a point-in-time snapshot. A repeat would otherwise
	// reach `MetadataCache.bulkLoad()`, whose one-id-one-path guard fails the whole
	// scan as corrupt metadata. Last occurrence wins; `Map` keeps the first insertion
	// position, so the parent-before-child order the delta completion relies on holds.
	const byId = new Map<string, GoogleDriveFile>();
	// Unlike OneDrive's delta feed, Drive does not document repeats — a collapse here
	// means something unexpected, so warn (the level a vault owner actually sees) and
	// name a bounded sample of the ids, or the report is not actionable.
	const repeated: string[] = [];
	// LIST_PAGE_CAP below bounds the pages of ONE folder, not the walk itself. Without
	// this, a parent cycle would grow `tasks` forever, and a multi-parent folder would
	// re-walk its whole subtree. Drive rejects moving a folder into its own descendant,
	// but nothing here should depend on that staying true.
	const visited = new Set<string>();
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
		if (visited.has(folderId)) return;
		visited.add(folderId);
		const task = pool.run(async () => {
			let pageToken: string | undefined;
			// Bound the pagination drain: a server that never clears nextPageToken
			// would otherwise loop forever. 10k pages × 1000 files/page is far beyond
			// any real folder, so hitting it means a misbehaving server — throw rather
			// than silently truncate (a short listing would read as mass deletion).
			for (let guard = 0; guard < LIST_PAGE_CAP; guard++) {
				const result = await listPage(folderId, pageToken);
				for (const file of result.files) {
					if (byId.has(file.id)) repeated.push(file.id);
					byId.set(file.id, file);
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

	if (repeated.length > 0) {
		logger?.warn("Full scan listing returned repeated ids", {
			collapsed: repeated.length,
			kept: byId.size,
			ids: repeated.slice(0, REPEATED_ID_SAMPLE),
		});
	}
	return [...byId.values()];
}
