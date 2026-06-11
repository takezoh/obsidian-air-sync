import { afterAll, beforeAll, describe } from "vitest";
import { PCloudClient } from "../src/fs/pcloud/client";
import { PCloudFs } from "../src/fs/pcloud/index";
import { runIFileSystemContract } from "../src/fs/ifilesystem-contract";
import { readPCloudCreds } from "./helpers/env";
import {
	cleanupPCloudParent,
	makePCloudChild,
	makePCloudParent,
} from "./helpers/isolation";

/**
 * Opt-in real-cloud e2e (ADR 0003): runs the SAME `runIFileSystemContract` the
 * fake-backed unit test runs (`src/fs/pcloud/ifilesystem-contract.test.ts`), but
 * against the live pCloud API, to catch drift between `makeFakePCloudClient` and
 * the real `PCloudClient`.
 *
 * Unlike the refresh-token backends there is NO bootstrap: pCloud issues a single
 * long-lived access token (no refresh, no expiry), so the token is pasted into
 * `.env.e2e` once (AIRSYNC_E2E_PCLOUD_ACCESS_TOKEN, plus AIRSYNC_E2E_PCLOUD_API_HOST
 * for an EU account). Skips (with a warning, never failing) when it is absent. See
 * docs/e2e-testing.md.
 */
const creds = readPCloudCreds();

if (!creds) {
	console.warn(
		"[e2e] Skipping pCloud: set AIRSYNC_E2E_PCLOUD_ACCESS_TOKEN (long-lived " +
			"token; no bootstrap) and, for an EU account, AIRSYNC_E2E_PCLOUD_API_HOST" +
			"=eapi.pcloud.com. See docs/e2e-testing.md.",
	);
	describe.skip("IFileSystem contract — PCloudFs (real) [no creds]", () => {
		/* skipped */
	});
} else {
	// The long-lived token is used verbatim (no refresh) and the region host is
	// pinned at auth time, so both are read straight from creds. The client has no
	// retry/backoff loop, so — unlike Dropbox/OneDrive — there is no sleep to inject.
	const client = new PCloudClient(
		() => creds.accessToken,
		() => creds.apiHost,
	);
	let parentId = "";

	beforeAll(async () => {
		parentId = await makePCloudParent(client);
	});
	afterAll(async () => {
		// Best-effort: a cleanup failure must not fail an otherwise-green run.
		if (!parentId) return;
		try {
			await cleanupPCloudParent(client, parentId);
		} catch (err) {
			console.warn(
				`[e2e] pCloud cleanup failed (delete airsync-e2e-* by hand): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	runIFileSystemContract(
		"PCloudFs (real)",
		async () => new PCloudFs(client, await makePCloudChild(client, parentId)),
		// PCloudFs reports hash:"" + an opaque remoteChecksum from stat()
		// (computesHashOnStat:false). `uploadfile` sends mtime at WHOLE-SECOND
		// precision (Math.floor(mtime/1000)) and pCloud preserves the supplied value,
		// so a written mtime round-trips floored to the second — the OneDrive shape
		// (mtimePrecisionMs:1000), not Dropbox's server clock. Confirm/adjust on the
		// first live run, the same way ADR 0003 derived this knob for OneDrive.
		{ computesHashOnStat: false, mtimePrecisionMs: 1000 },
	);
}
