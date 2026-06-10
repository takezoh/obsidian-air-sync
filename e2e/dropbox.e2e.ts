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
	const client = new DropboxClient((force) => auth.getAccessToken(force));
	let parentId = "";

	beforeAll(async () => {
		parentId = await makeDropboxParent(client);
	});
	afterAll(async () => {
		if (parentId) await cleanupDropboxParent(client, parentId);
	});

	runIFileSystemContract(
		"DropboxFs (real)",
		async () => new DropboxFs(client, await makeDropboxChild(client, parentId)),
		// Dropbox truncates client_modified to whole seconds → relax mtime equality
		// to second precision (ADR 0002 documented divergence; ADR 0003 knob).
		{ computesHashOnStat: false, mtimePrecisionMs: 1000 },
	);
}
