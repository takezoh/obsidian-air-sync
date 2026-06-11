import { afterAll, beforeAll, describe } from "vitest";
import { OneDriveAuth } from "../src/fs/onedrive/auth";
import { OneDriveClient } from "../src/fs/onedrive/client";
import { OneDriveFs } from "../src/fs/onedrive/index";
import { runIFileSystemContract } from "../src/fs/ifilesystem-contract";
import { readCreds } from "./helpers/env";
import {
	cleanupOneDriveParent,
	makeOneDriveChild,
	makeOneDriveParent,
} from "./helpers/isolation";

/**
 * Opt-in real-cloud e2e (ADR 0003): runs the SAME `runIFileSystemContract` the
 * fake-backed unit tests run, but against the live Microsoft Graph API, to catch
 * drift between `makeFakeOneDriveClient` and the real `OneDriveClient`.
 *
 * Skips (with a warning, never failing) when the refresh token OR the client id is
 * absent. The shipped OneDrive client id is a placeholder (REPLACE_ME), so — exactly
 * like Google's own-GCP-client requirement — the e2e needs the developer's OWN Entra
 * app client id: PKCE refresh is bound to the client the token was minted against.
 * Get a token via `npm run e2e:bootstrap -- onedrive`. See docs/e2e-testing.md.
 */
const creds = readCreds("AIRSYNC_E2E_ONEDRIVE_REFRESH_TOKEN");
const clientId = process.env.AIRSYNC_E2E_ONEDRIVE_CLIENT_ID;

if (!creds || !clientId) {
	console.warn(
		"[e2e] Skipping OneDrive: set AIRSYNC_E2E_ONEDRIVE_REFRESH_TOKEN and " +
			"AIRSYNC_E2E_ONEDRIVE_CLIENT_ID (run `npm run e2e:bootstrap -- onedrive`; " +
			"see docs/e2e-testing.md).",
	);
	describe.skip("IFileSystem contract — OneDriveFs (real) [no creds]", () => {
		/* skipped */
	});
} else {
	// PKCE refresh needs only the (developer's own) public client id. Empty access
	// token + expiry 0 forces a refresh on the first getAccessToken().
	const auth = new OneDriveAuth(clientId);
	auth.setTokens(creds.refreshToken, "", 0);
	// Inject a node-safe sleep: the client's default sleep uses window.setTimeout,
	// undefined under vitest's node environment — a 429 backoff would otherwise crash
	// with "window is not defined" instead of retrying (same fix as the Dropbox e2e).
	const client = new OneDriveClient(
		(force) => auth.getAccessToken(force),
		undefined,
		(ms) => new Promise((r) => setTimeout(r, ms)),
	);
	let parentId = "";

	beforeAll(async () => {
		parentId = await makeOneDriveParent(client);
	});
	afterAll(async () => {
		// Best-effort: a cleanup failure must not fail an otherwise-green run.
		if (!parentId) return;
		try {
			await cleanupOneDriveParent(client, parentId);
		} catch (err) {
			console.warn(
				`[e2e] OneDrive cleanup failed (delete airsync-e2e-* by hand): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	runIFileSystemContract(
		"OneDriveFs (real)",
		async () => new OneDriveFs(client, await makeOneDriveChild(client, parentId)),
		// OneDriveFs PATCHes fileSystemInfo.lastModifiedDateTime after the content PUT,
		// so the written mtime IS preserved (preservesWrittenMtime stays true, unlike
		// Dropbox's server clock) — but Microsoft Graph stores it at WHOLE-SECOND
		// precision (this e2e proved 12345 → 12000), so it round-trips only to the
		// second: mtimePrecisionMs 1000. The OneDrive fake echoes full ms, hence the
		// unit contract stays exact and only this live run carries the precision knob.
		{ computesHashOnStat: false, mtimePrecisionMs: 1000 },
	);
}
