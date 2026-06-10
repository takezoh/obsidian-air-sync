import { afterAll, beforeAll, describe } from "vitest";
import { GoogleAuth } from "../src/fs/googledrive/auth";
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

if (!creds) {
	console.warn(
		"[e2e] Skipping Google Drive: set AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN " +
			"(run `npm run e2e:bootstrap -- google`; see docs/e2e-testing.md).",
	);
	describe.skip("IFileSystem contract — GoogleDriveFs (real) [no creds]", () => {
		/* skipped */
	});
} else {
	// Built-in GoogleAuth: refresh goes through the auth server with only the
	// refresh token (no client secret). Seeding an empty access token + expiry 0
	// forces a refresh on the first getAccessToken().
	const auth = new GoogleAuth();
	auth.setTokens(creds.refreshToken, "", 0);
	const client = new DriveClient((force) => auth.getAccessToken(force));
	let parentId = "";

	beforeAll(async () => {
		parentId = await makeDriveParent(client);
	});
	afterAll(async () => {
		if (parentId) await cleanupDriveParent(client, parentId);
	});

	runIFileSystemContract(
		"GoogleDriveFs (real)",
		// A fresh empty child folder per test → satisfies the contract's
		// empty-start assumption. Runs in beforeEach, after the beforeAll above.
		async () => new GoogleDriveFs(client, await makeDriveChild(client, parentId)),
		{ computesHashOnStat: false }, // Drive round-trips full-ms mtime → default precision
	);
}
