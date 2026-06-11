import { afterAll, beforeAll, describe } from "vitest";
import { DROPBOX_CLIENT_ID, DropboxAuth } from "../src/fs/dropbox/auth";
import { DropboxClient } from "../src/fs/dropbox/client";
import { DropboxFs } from "../src/fs/dropbox/index";
import { runIFileSystemContract } from "../src/fs/ifilesystem-contract";
import { readCreds } from "./helpers/env";
import {
	cleanupDropboxParent,
	makeDropboxChild,
	makeDropboxParent,
} from "./helpers/isolation";

/**
 * Opt-in real-cloud e2e (ADR 0003): runs the SAME `runIFileSystemContract` the
 * fake-backed unit tests run, but against the live Dropbox API, to catch drift
 * between `makeFakeDropboxClient` and the real `DropboxClient`.
 *
 * Skips (with a warning, never failing) when the refresh token is absent. Get one
 * via `npm run e2e:bootstrap -- dropbox`. See docs/e2e-testing.md.
 */
const creds = readCreds("AIRSYNC_E2E_DROPBOX_REFRESH_TOKEN");

if (!creds) {
	console.warn(
		"[e2e] Skipping Dropbox: set AIRSYNC_E2E_DROPBOX_REFRESH_TOKEN " +
			"(run `npm run e2e:bootstrap -- dropbox`; see docs/e2e-testing.md).",
	);
	describe.skip("IFileSystem contract — DropboxFs (real) [no creds]", () => {
		/* skipped */
	});
} else {
	// PKCE refresh needs only the public client id. Empty access token + expiry 0
	// forces a refresh on the first getAccessToken().
	const auth = new DropboxAuth(DROPBOX_CLIENT_ID);
	auth.setTokens(creds.refreshToken, "", 0);
	// Inject a node-safe sleep: the client's default sleep uses window.setTimeout,
	// which is undefined under vitest's node environment — a 429 backoff (the very
	// reason this suite runs fileParallelism:false) would otherwise crash with
	// "window is not defined" instead of retrying.
	const client = new DropboxClient(
		(force) => auth.getAccessToken(force),
		undefined,
		(ms) => new Promise((r) => setTimeout(r, ms)),
	);
	let parentPath = "";

	beforeAll(async () => {
		parentPath = await makeDropboxParent(client);
	});
	afterAll(async () => {
		// Best-effort: a cleanup failure must not fail an otherwise-green run.
		if (!parentPath) return;
		try {
			await cleanupDropboxParent(client, parentPath);
		} catch (err) {
			console.warn(
				`[e2e] Dropbox cleanup failed (delete airsync-e2e-* by hand): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	runIFileSystemContract(
		"DropboxFs (real)",
		async () => new DropboxFs(client, await makeDropboxChild(client, parentPath)),
		// DropboxFs reports server_modified (the upload wall-clock) as mtime, so a
		// written mtime does not round-trip (unlike the fake, which echoes it back).
		// Verified by this e2e; see ADR 0003 / dropbox/types.ts.
		{ computesHashOnStat: false, preservesWrittenMtime: false },
	);
}
