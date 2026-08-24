import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OneDriveAuth } from "../src/fs/onedrive/auth";
import { OneDriveClient } from "../src/fs/onedrive/client";
import { OneDriveFs } from "../src/fs/onedrive/index";
import { bytes, runIFileSystemContract } from "../src/fs/ifilesystem-contract.test";
import { createMockFs } from "../src/__mocks__/sync-test-helpers";
import { LocalChangeTracker } from "../src/sync/local-tracker";
import { SyncOrchestrator } from "../src/sync/orchestrator";
import { DEFAULT_SETTINGS } from "../src/settings";
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
		{ computesHashOnStat: false, mtimePrecisionMs: 1000, stableIdentity: true },
	);

	describe("OneDrive rename safety — composed multi-cycle sync (real)", () => {
		it("preserves one correctly-cased copy across both rename origins and later COLD", async () => {
			const childId = await makeOneDriveChild(client, parentId);
			const remoteFs = new OneDriveFs(client, childId);
			const localFs = createMockFs("local");
			const tracker = new LocalChangeTracker();
			const settings = {
				...DEFAULT_SETTINGS,
				vaultId: `onedrive-e2e-${crypto.randomUUID()}`,
				backendType: "onedrive",
				lastSyncedIdentity: `onedrive:${childId}`,
			};
			const statuses: string[] = [];
			const orchestrator = new SyncOrchestrator({
				getSettings: () => settings,
				saveSettings: vi.fn().mockResolvedValue(undefined),
				configDir: () => ".obsidian",
				pluginId: () => "air-sync",
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => null,
				onStatusChange: (status) => { statuses.push(status); },
				onProgress: vi.fn(),
				notify: vi.fn(),
				isMobile: () => false,
				localTracker: tracker,
			});
			const localDelete = vi.spyOn(localFs, "delete");
			const remoteDelete = vi.spyOn(remoteFs, "delete");
			const localRename = vi.spyOn(localFs, "rename");
			const remoteRename = vi.spyOn(remoteFs, "rename");
			const remoteList = vi.spyOn(remoteFs, "list");

			try {
				const content = bytes("case-preserved");
				await localFs.write("Case.md", content, 1000);
				await remoteFs.write("Case.md", content, 1000);
				// Discard mutation-backed requested-echo cache state. The initial cycle
				// must re-observe the live backend and establish a clean baseline.
				await remoteFs.checkpoint.resetCheckpoint();
				await orchestrator.runSync();

				await localFs.rename("Case.md", "case.md");
				tracker.markRenamed("case.md", "Case.md");
				await orchestrator.runSync();
				expect(remoteRename).toHaveBeenCalledWith("Case.md", "case.md");

				const moved = await remoteFs.stat("case.md");
				expect(moved?.identityKey).toBeTruthy();
				await client.move(moved!.identityKey!, "CASE.md", undefined);
				await orchestrator.runSync();
				expect(localRename).toHaveBeenCalledWith("case.md", "CASE.md");

				// A later COLD cycle must confirm convergence without an opposing delete.
				const listsBeforeCold = remoteList.mock.calls.length;
				await remoteFs.checkpoint.resetCheckpoint();
				await orchestrator.runSync();
				expect(remoteList).toHaveBeenCalledTimes(listsBeforeCold + 1);
				expect((await localFs.list()).filter((item) => !item.isDirectory).map((item) => item.path))
					.toEqual(["CASE.md"]);
				expect((await remoteFs.list()).filter((item) => !item.isDirectory).map((item) => item.path))
					.toEqual(["CASE.md"]);
				expect(new TextDecoder().decode(await localFs.read("CASE.md"))).toBe("case-preserved");
				expect(new TextDecoder().decode(await remoteFs.read("CASE.md"))).toBe("case-preserved");
				expect(localDelete).not.toHaveBeenCalled();
				expect(remoteDelete).not.toHaveBeenCalled();
				expect(statuses.at(-1)).toBe("idle");
			} finally {
				await orchestrator.close();
				await remoteFs.close();
			}
		});
	});
}
