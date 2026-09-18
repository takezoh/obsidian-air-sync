// The scope-entry case below drives a real MetadataStore, so this file owns the
// IndexedDB shim rather than inheriting it from a helper imported for another scenario.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GoogleDriveClient } from "../src/fs/googledrive/client";
import { GoogleDriveFs } from "../src/fs/googledrive/index";
import type { GoogleDriveFile } from "../src/fs/googledrive/types";
import type { IncrementalCheckpoint } from "../src/fs/interface";
import { bytes, runIFileSystemContract } from "../tests/fs/contracts/ifilesystem.contract";
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
import type { MovedObjectIdentity } from "../tests/fs/contracts/caching-remote-fs.contract";

/**
 * What Google Drive's own entity projection makes of a moved object's identity, against
 * the LIVE API. Same disposition the family declares to the fake-backed unit contract
 * (`tests/fs/googledrive/caching-remote-fs.contract-harness.ts`) — stated separately here
 * because a fake that always hands over a complete resource cannot establish it for
 * `changes.list`, which is the whole point of ADR 0003.
 */
const GOOGLE_DRIVE_MOVED_OBJECT_IDENTITY: MovedObjectIdentity = {
	determinate: true,
	reason:
		"GoogleDriveMetadataCache.toEntity sets identityKey: googleDriveFile.id for files " +
		"and folders alike, with no fallback, and every Drive resource carries an id — " +
		"googledrive/types.ts declares `id: string`, not an optional. A live changes.list " +
		"payload that omitted it would project no identity, so the pair would name nothing " +
		"and buildSyncRecord would refuse the record it feeds.",
};

/** The subtree `F` carries across the bound-root boundary, in sorted path order. */
const SCOPE_ENTRY_SUBTREE = ["F", "F/a.md", "F/sub", "F/sub/b.md"];
const SCOPE_ENTRY_POLL_ATTEMPTS = 20;
const SCOPE_ENTRY_POLL_INTERVAL_MS = 1500;

type RemoteDelta = NonNullable<Awaited<ReturnType<IncrementalCheckpoint["getChangedPaths"]>>>;

/**
 * Poll `getChangedPaths()` until `hasArrived` accepts a result, and return THAT result.
 *
 * Two live facts force this shape. Google Drive publishes a mutation to `changes.list`
 * some time AFTER the mutation response returns, so a single fixed read would be flaky.
 * And each read CONSUMES what it returns — the cursor advances — so the change is
 * reported exactly once: the first result carrying it is the only one that can be
 * asserted on, and a later read would see it gone rather than incomplete.
 *
 * Exhausting the bound is a hard failure naming `changes.list` propagation: it means the
 * scenario was not observable through this API. It never skips and never passes.
 */
async function pollForChange(
	checkpoint: IncrementalCheckpoint,
	step: string,
	hasArrived: (delta: RemoteDelta) => boolean,
): Promise<RemoteDelta> {
	for (let attempt = 0; attempt < SCOPE_ENTRY_POLL_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			await new Promise((resolve) => setTimeout(resolve, SCOPE_ENTRY_POLL_INTERVAL_MS));
		}
		const delta = await checkpoint.getChangedPaths();
		if (delta && hasArrived(delta)) return delta;
	}
	const seconds = (SCOPE_ENTRY_POLL_ATTEMPTS * SCOPE_ENTRY_POLL_INTERVAL_MS) / 1000;
	throw new Error(
		`changes.list propagation never reported "${step}": ${SCOPE_ENTRY_POLL_ATTEMPTS} ` +
			`getChangedPaths polls over ~${seconds}s all came back without it.`,
	);
}

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
		movedObjectIdentity: GOOGLE_DRIVE_MOVED_OBJECT_IDENTITY,
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

	// Live backstop for the scope-entry fix: `changes.list` reports ONLY the folder that
	// moved, never its unchanged descendants, so a backend that trusts the delta page
	// alone reports just "F" here. The fake-backed shared contract pins the same fact;
	// this proves it against the real API, including on RE-entry — the shape the live
	// probe reproduced, where F is absent from the cache and its own change is all Drive
	// sends. Runs in its own fresh root, cleaned up by the per-run parent trash.
	describe("GoogleDriveFs scope entry — folder moved into the bound root (real)", () => {
		it("reports an entered folder's whole pre-existing subtree, including on re-entry", async () => {
			const rootId = await makeGoogleDriveChild(client, parentId);
			// A sibling of the root, not a descendant: F is genuinely outside the bound
			// scope, so nothing about it can reach the cache until it is moved in.
			const outsideId = await makeGoogleDriveChild(client, parentId);
			const folder = await client.createFolder("F", outsideId);
			await client.uploadFile("a.md", folder.id, bytes("entered-a"));
			const sub = await client.createFolder("sub", folder.id);
			await client.uploadFile("b.md", sub.id, bytes("entered-b"));

			const store = new MetadataStore<GoogleDriveFile>(crypto.randomUUID(), {
				dbNamePrefix: "air-sync-googledrive-e2e-scope-entry",
				version: 1,
			});
			const fs = new GoogleDriveFs(client, rootId, undefined, store);
			const checkpoint = fs.checkpoint;
			try {
				// The empty baseline is load-bearing twice over: it proves F is outside the
				// scope, and committing it is what makes every later read a WARM delta from
				// a real persisted cursor instead of another cold scan.
				expect((await fs.list()).map((entry) => entry.path)).toEqual([]);
				await checkpoint.commitCheckpoint();

				await client.updateFileMetadata(folder.id, {}, rootId, outsideId);
				const entered = await pollForChange(checkpoint, "F moved into the root",
					(delta) => delta.modified.includes("F"));
				expect(entered.modified).toEqual(expect.arrayContaining(SCOPE_ENTRY_SUBTREE));
				await checkpoint.commitCheckpoint();

				await client.updateFileMetadata(folder.id, {}, outsideId, rootId);
				const left = await pollForChange(checkpoint, "F moved out of the root",
					(delta) => delta.deleted.includes("F"));
				expect(left.deleted).toEqual(expect.arrayContaining(SCOPE_ENTRY_SUBTREE));
				await checkpoint.commitCheckpoint();

				await client.updateFileMetadata(folder.id, {}, rootId, outsideId);
				const reentered = await pollForChange(checkpoint, "F moved back into the root",
					(delta) => delta.modified.includes("F"));
				expect(reentered.modified).toEqual(expect.arrayContaining(SCOPE_ENTRY_SUBTREE));
				// The working view must now hold what a cold scan would: the deepest
				// descendant is addressable, not merely named in the delta.
				expect(await fs.stat("F/sub/b.md")).not.toBeNull();
			} finally {
				await fs.close();
			}
		});
	});
}
