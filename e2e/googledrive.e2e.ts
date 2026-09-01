import { afterAll, beforeAll, describe } from "vitest";
import { GoogleDriveClient } from "../src/fs/googledrive/client";
import { GoogleDriveFs } from "../src/fs/googledrive/index";
import type { GoogleDriveFile } from "../src/fs/googledrive/types";
import { runIFileSystemContract } from "../src/fs/contracts/ifilesystem.contract";
import { MetadataStore } from "../src/store/metadata-store";
import {
	createGoogleE2EAuth,
	GOOGLE_E2E_REFRESH_TOKEN_ENV,
	readGoogleE2ECreds,
} from "./helpers/google-auth";
import {
	cleanupGoogleDriveParent,
	makeGoogleDriveChild,
	makeGoogleDriveParent,
} from "./helpers/isolation";
import { runRenameSafetyE2E } from "./helpers/rename-safety";
import { runPriorityFidelityE2E } from "./helpers/priority-fidelity";

/**
 * Opt-in real-cloud e2e (ADR 0003): runs the SAME `runIFileSystemContract` the
 * fake-backed unit tests run, but against the live Google Drive API, to catch
 * drift between `makeFakeGoogleDriveClient` and the real `GoogleDriveClient`.
 *
 * Skips (with a warning, never failing) when the refresh token is absent. Get one
 * via `npm run e2e:bootstrap -- google`. See docs/e2e-testing.md.
 */
const creds = readGoogleE2ECreds();

if (!creds) {
	console.warn(
		`[e2e] Skipping Google Drive: set ${GOOGLE_E2E_REFRESH_TOKEN_ENV} ` +
			"(run `npm run e2e:bootstrap -- google`; see docs/e2e-testing.md).",
	);
	describe.skip("IFileSystem contract — GoogleDriveFs (real) [no creds]", () => {
		/* skipped */
	});
} else {
	const auth = createGoogleE2EAuth(creds.refreshToken);
	const client = new GoogleDriveClient((force) => auth.getAccessToken(force));
	let parentId = "";

	beforeAll(async () => {
		parentId = await makeGoogleDriveParent(client);
	});
	afterAll(async () => {
		// Best-effort: cleanup is housekeeping, not an assertion. drive.file can't
		// hard-delete and may 403 on trash under load — don't fail a green run over
		// leftover folders (they're uniquely named; delete airsync-e2e-* manually).
		if (!parentId) return;
		try {
			await cleanupGoogleDriveParent(client, parentId);
		} catch (err) {
			console.warn(
				`[e2e] Google Drive cleanup failed (delete airsync-e2e-* by hand): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	runIFileSystemContract(
		"GoogleDriveFs (real)",
		// A fresh empty child folder per test → satisfies the contract's
		// empty-start assumption. Runs in beforeEach, after the beforeAll above.
		async () => new GoogleDriveFs(client, await makeGoogleDriveChild(client, parentId)),
		{ computesHashOnStat: false, stableIdentity: true }, // Google Drive round-trips full-ms mtime → default preservesWrittenMtime: true
	);

	runPriorityFidelityE2E(
		"GoogleDriveFs",
		async () => new GoogleDriveFs(client, await makeGoogleDriveChild(client, parentId)),
	);

	runRenameSafetyE2E("GoogleDriveFs", {
		backendType: "googledrive",
		makeBackend: async () => {
			const childId = await makeGoogleDriveChild(client, parentId);
			const store = new MetadataStore<GoogleDriveFile>(crypto.randomUUID(), {
				dbNamePrefix: "air-sync-googledrive-e2e-rename",
				version: 1,
			});
			const fs = new GoogleDriveFs(client, childId, undefined, store);
			return {
				fs,
				renameOutOfBand: async (file, newPath) => {
					await client.updateFileMetadata(file.identityKey!, { name: newPath });
				},
			};
		},
	});
}
