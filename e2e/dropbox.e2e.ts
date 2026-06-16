import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DropboxAuth } from "../src/fs/dropbox/auth";
import { DROPBOX_AUTH } from "../src/fs/auth-config";
import { DropboxFs } from "../src/fs/dropbox/index";
import { runIFileSystemContract, bytes } from "../src/fs/ifilesystem-contract";
import { RetryingDropboxClient } from "./helpers/dropbox-retry-client";
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
	const auth = new DropboxAuth(DROPBOX_AUTH.clientId);
	auth.setTokens(creds.refreshToken, "", 0);
	// Inject a node-safe sleep: the client's default sleep uses window.setTimeout,
	// which is undefined under vitest's node environment — a 429 backoff (the very
	// reason this suite runs fileParallelism:false) would otherwise crash with
	// "window is not defined" instead of retrying. RetryingDropboxClient adds a
	// retry for the fresh-folder-id propagation transient (see its docstring).
	const client = new RetryingDropboxClient(
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

	// The IFileSystem contract above never drives `getChangedPaths()`, so the delta's
	// rename SHAPE is unverified against real Dropbox — exactly the ADR 0003 blind spot.
	// This pins it: an out-of-band folder rename must come back as ONE renamed pair, not
	// a subtree of delete+add (ADR 0006). Lives in the one Dropbox e2e file on purpose —
	// a second `*.e2e.ts` matching "dropbox" would run concurrently and share its
	// rate-limit bucket (vitest fileParallelism; see vitest.e2e.config.ts).
	describe("DropboxFs delta — out-of-band rename via getChangedPaths (real)", () => {
		it("reports a remote folder rename as a single renamed pair", async () => {
			const childId = await makeDropboxChild(client, parentPath);
			const fs = new DropboxFs(client, childId);

			// Seed a folder with two files, then drain + commit so the cursor is at "now".
			await fs.write("dir/b.md", bytes("beta"), 1000);
			await fs.write("dir/c.md", bytes("gamma"), 1000);
			await fs.list();
			await fs.commitCheckpoint();

			// Rename the folder OUT-OF-BAND (as a second device / the web UI would),
			// bypassing the FS cache, so the delta is the only source of truth.
			await client.move(`${childId}/dir`, `${childId}/papers`);

			const delta = await fs.checkpoint.getChangedPaths();
			expect(delta).not.toBeNull();
			expect(delta!.renamed ?? []).toContainEqual({
				oldPath: "dir",
				newPath: "papers",
				isFolder: true,
			});
			// Exactly one folder pair — not N per-file renames, and not delete+add.
			expect((delta!.renamed ?? []).filter((p) => p.isFolder)).toHaveLength(1);
		});
	});
}
