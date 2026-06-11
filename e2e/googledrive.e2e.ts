import { afterAll, beforeAll, describe } from "vitest";
import type { IGoogleAuth } from "../src/fs/googledrive/auth";
import { GoogleAuth, GoogleAuthDirect } from "../src/fs/googledrive/auth";
import { DriveClient } from "../src/fs/googledrive/client";
import { GoogleDriveFs } from "../src/fs/googledrive/index";
import { runIFileSystemContract } from "../src/fs/ifilesystem-contract";
import { readCreds } from "./helpers/env";
import {
	cleanupDriveParent,
	makeDriveChild,
	makeDriveParent,
} from "./helpers/isolation";

/**
 * Opt-in real-cloud e2e (ADR 0003): runs the SAME `runIFileSystemContract` the
 * fake-backed unit tests run, but against the live Google Drive API, to catch
 * drift between `makeFakeDriveClient` and the real `DriveClient`.
 *
 * Skips (with a warning, never failing) when the refresh token is absent. Get one
 * via `npm run e2e:bootstrap -- google`. See docs/e2e-testing.md.
 */
const creds = readCreds("AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN");
const clientId = process.env.AIRSYNC_E2E_GOOGLE_CLIENT_ID;
const clientSecret = process.env.AIRSYNC_E2E_GOOGLE_CLIENT_SECRET;

if (!creds) {
	console.warn(
		"[e2e] Skipping Google Drive: set AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN " +
			"(run `npm run e2e:bootstrap -- google`; see docs/e2e-testing.md).",
	);
	describe.skip("IFileSystem contract — GoogleDriveFs (real) [no creds]", () => {
		/* skipped */
	});
} else {
	// A refresh token is bound to the OAuth client that issued it, so refresh with
	// the matching client: GoogleAuthDirect (your own GCP client) when the loopback
	// bootstrap was used, else the built-in GoogleAuth (auth server, no secret).
	// Seeding an empty access token + expiry 0 forces a refresh on first use.
	const auth: IGoogleAuth =
		clientId && clientSecret
			? new GoogleAuthDirect({ clientId, clientSecret })
			: new GoogleAuth();
	auth.setTokens(creds.refreshToken, "", 0);
	const client = new DriveClient((force) => auth.getAccessToken(force));
	let parentId = "";

	beforeAll(async () => {
		parentId = await makeDriveParent(client);
	});
	afterAll(async () => {
		// Best-effort: cleanup is housekeeping, not an assertion. drive.file can't
		// hard-delete and may 403 on trash under load — don't fail a green run over
		// leftover folders (they're uniquely named; delete airsync-e2e-* manually).
		if (!parentId) return;
		try {
			await cleanupDriveParent(client, parentId);
		} catch (err) {
			console.warn(
				`[e2e] Drive cleanup failed (delete airsync-e2e-* by hand): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	runIFileSystemContract(
		"GoogleDriveFs (real)",
		// A fresh empty child folder per test → satisfies the contract's
		// empty-start assumption. Runs in beforeEach, after the beforeAll above.
		async () => new GoogleDriveFs(client, await makeDriveChild(client, parentId)),
		{ computesHashOnStat: false }, // Drive round-trips full-ms mtime → default preservesWrittenMtime: true
	);
}
