import { DropboxClient } from "../../src/fs/dropbox/client";
import { DropboxApiError } from "../../src/fs/dropbox/types";
import type { DropboxEntry } from "../../src/fs/dropbox/types";

/**
 * e2e-only `DropboxClient` that retries the FRESH-FOLDER-ID propagation transient.
 *
 * DropboxFs addresses every op by the vault's stable folder id (`id:<id>/<sub>`).
 * A BRAND-NEW folder id (this contract creates one child folder per test) does not
 * resolve immediately: `create_folder_v2` / `upload` against it 400 with the body
 * `'id:…' did not match pattern …` for a short window until the id propagates. The
 * production client does NOT retry this — a real vault folder id is long-propagated
 * by the time it syncs, so the window never occurs there.
 *
 * This replaces the former create+delete "warm-up" probe (isolation.ts): one
 * successful probe did not prove the window had closed, so the contract's first
 * real `create_folder` still raced it (observed twice on 2026-06-11, a different
 * test each run). Retrying the ACTUAL op on the EXACT transient is deterministic
 * and costs nothing once the id is settled.
 */
export class RetryingDropboxClient extends DropboxClient {
	override createFolder(path: string): Promise<DropboxEntry> {
		return retryFreshId(() => super.createFolder(path));
	}

	override upload(path: string, content: ArrayBuffer, mtime: number): Promise<DropboxEntry> {
		return retryFreshId(() => super.upload(path, content, mtime));
	}
}

const FRESH_ID_RETRIES = 12;
const FRESH_ID_BACKOFF_MS = 500;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The fresh-id window: a 400 whose body is `create_folder_v2`'s path-pattern
 * validation failure (`'id:…' did not match pattern …`), NOT the structured
 * `error_summary` JSON. Match the exact pattern text so a genuine 400 (real bad
 * input) is NOT retried away — it surfaces after the same bounded backoff.
 */
function isFreshIdTransient(err: unknown): boolean {
	return err instanceof DropboxApiError && err.status === 400 && err.summary.includes("did not match pattern");
}

async function retryFreshId<T>(op: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await op();
		} catch (err) {
			if (attempt >= FRESH_ID_RETRIES || !isFreshIdTransient(err)) throw err;
			await sleep(FRESH_ID_BACKOFF_MS);
		}
	}
}
