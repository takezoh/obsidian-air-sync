import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	addFile,
	createMockFs,
	mockSettings,
} from "../src/__mocks__/sync-test-helpers";
import { OneDriveAuth } from "../src/fs/onedrive/auth";
import { OneDriveClient } from "../src/fs/onedrive/client";
import { OneDriveFs } from "../src/fs/onedrive/index";
import type { OneDriveItem } from "../src/fs/onedrive/types";
import { runIFileSystemContract } from "../src/fs/ifilesystem-contract.test";
import { MetadataStore } from "../src/store/metadata-store";
import { LocalChangeTracker } from "../src/sync/local-tracker";
import { SyncOrchestrator } from "../src/sync/orchestrator";
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
 * absent. The shipped OneDrive app uses the obsidian:// redirect (not capturable by a
 * loopback), so — exactly like Google's own-GCP-client requirement — the e2e needs the
 * developer's OWN Entra app client id with a localhost redirect: PKCE refresh is bound
 * to the client the token was minted against.
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

	describe("OneDrive sync convergence — case-only local rename (real)", () => {
		it("keeps one local and remote copy with the requested casing across follow-up delta cycles", async () => {
			const childId = await makeOneDriveChild(client, parentId);
			const runId = crypto.randomUUID();
			const metadataStore = new MetadataStore<OneDriveItem>(runId, {
				dbNamePrefix: "air-sync-onedrive-e2e-case-rename",
				version: 1,
			});
			const remoteFs = new OneDriveFs(client, childId, undefined, metadataStore);
			const localFs = createMockFs("case-insensitive-local");
			const localTracker = new LocalChangeTracker();

			// Model Windows/Obsidian: querying the old spelling after a case-only
			// rename resolves the same file under its new, case-preserved path.
			const exactStat = localFs.stat.bind(localFs);
			localFs.stat = async (path) => {
				const exact = await exactStat(path);
				if (exact) return exact;
				const alias = [...localFs.files.keys()].find(
					(candidate) => candidate.toLowerCase() === path.toLowerCase(),
				);
				return alias ? exactStat(alias) : null;
			};

			// A delete performed by sync emits a vault delete event in production.
			// Preserve that event in the tracker so the following cycle can expose
			// whether delete_local cascades into delete_remote.
			const exactDelete = localFs.delete.bind(localFs);
			localFs.delete = async (path) => {
				const actualPath =
					[...localFs.files.keys()].find(
						(candidate) => candidate.toLowerCase() === path.toLowerCase(),
					) ?? path;
				await exactDelete(actualPath);
				localTracker.markDirty(actualPath);
			};

			const settings = mockSettings({
				backendType: "onedrive",
				vaultId: `e2e-case-rename-${runId}`,
			});
			const orchestrator = new SyncOrchestrator({
				getSettings: () => settings,
				saveSettings: () => Promise.resolve(),
				configDir: () => ".obsidian",
				pluginId: () => "air-sync",
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => null,
				onStatusChange: () => {},
				onProgress: () => {},
				notify: () => {},
				isMobile: () => false,
				localTracker,
			});

			try {
				addFile(localFs, "PRUEBA.md", "case-only rename survives", Date.now());
				await orchestrator.runSync();
				expect(
					(await remoteFs.list()).filter((entry) => !entry.isDirectory).map((entry) => entry.path),
				).toEqual(["PRUEBA.md"]);

				await localFs.rename("PRUEBA.md", "PRUEBa.md");
				localTracker.markRenamed("PRUEBa.md", "PRUEBA.md");

				// Cover the local rename, OneDrive's follow-up delta, and additional
				// convergence cycles. Before the fix these cycles deleted both copies.
				for (let cycle = 0; cycle < 4; cycle++) {
					await orchestrator.runSync();
				}

				const localFiles = (await localFs.list()).filter((entry) => !entry.isDirectory);
				const remoteFiles = (await remoteFs.list()).filter((entry) => !entry.isDirectory);
				const localPath = localFiles[0]?.path;
				const remotePath = remoteFiles[0]?.path;
				const decode = (content: ArrayBuffer): string => new TextDecoder().decode(content);

				expect({
					localPaths: localFiles.map((entry) => entry.path),
					remotePaths: remoteFiles.map((entry) => entry.path),
					localContent: localPath ? decode(await localFs.read(localPath)) : null,
					remoteContent: remotePath ? decode(await remoteFs.read(remotePath)) : null,
				}).toEqual({
					localPaths: ["PRUEBa.md"],
					remotePaths: ["PRUEBa.md"],
					localContent: "case-only rename survives",
					remoteContent: "case-only rename survives",
				});
			} finally {
				await orchestrator.close();
				await metadataStore.close();
			}
		});
	});
}
