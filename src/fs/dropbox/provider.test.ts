import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, createMockSecretStore, dbxFolder, dbxFile } from "./test-helpers";
import type { AirSyncSettings } from "../../settings";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

async function makeProvider(secrets: Record<string, string> = {}) {
	const { DropboxProvider } = await import("./provider");
	const store = createMockSecretStore(secrets);
	return { provider: new DropboxProvider(store), store };
}

function settingsWith(dropbox: Record<string, unknown> = {}): AirSyncSettings {
	// backendData is the active backend's single flat bag — Dropbox's params live at
	// the top level, not under a "dropbox" key.
	return { vaultId: "vault-1", backendData: dropbox } as unknown as AirSyncSettings;
}

const CONNECTED = { "air-sync-dropbox-refresh-token": "RT", "air-sync-dropbox-access-token": "AT" };

describe("DropboxProvider.isConnected / getIdentity", () => {
	it("requires a token and a resolved remote vault folder id", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.isConnected(settingsWith({}))).toBe(false);
		// Other data without the folder id is not enough — the id is authoritative.
		expect(provider.isConnected(settingsWith({ cursor: "C" }))).toBe(false);
		expect(provider.isConnected(settingsWith({ remoteVaultFolderId: "id:9" }))).toBe(true);
	});

	it("derives identity from the folder id", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.getIdentity(settingsWith({ remoteVaultFolderId: "id:9" }))).toBe("dropbox:id:9");
		expect(provider.getIdentity(settingsWith({}))).toBeNull();
	});
});

describe("DropboxProvider.resolveRemoteVault", () => {
	it("creates the vault folder directly under the App Folder root on first connect", async () => {
		const spy = (await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("create_folder_v2")) {
				// Echo back a folder whose path matches the requested one.
				const body = JSON.parse((opts as RequestUrlParam).body as string) as { path: string };
				return Promise.resolve(mockRes({ metadata: dbxFolder("vault", body.path) }));
			}
			return Promise.resolve(mockRes({}));
		});
		const { provider } = await makeProvider(CONNECTED);
		const res = await provider.resolveRemoteVault({} as never, settingsWith({}), "v");

		expect(res.backendUpdates).toMatchObject({
			remoteVaultFolderId: "id:vault",
			lastKnownVaultName: "v",
		});
		// The path is not persisted — only the id + name.
		expect(res.backendUpdates).not.toHaveProperty("remoteVaultRootPath");
		// Only the vault folder is created — no wrapper-root folder call.
		const createCalls = spy.mock.calls.filter((c) => String((c[0] as RequestUrlParam).url).includes("create_folder_v2"));
		expect(createCalls.length).toBe(1);
		expect((JSON.parse((createCalls[0]![0] as RequestUrlParam).body as string) as { path: string }).path).toBe("/v");
	});

	it("does NOT touch the remote folder on a local vault rename (id binds them)", async () => {
		const spy = await spyRequestUrl(); // no impl needed — no request should be made
		const { provider } = await makeProvider(CONNECTED);
		const res = await provider.resolveRemoteVault(
			{} as never,
			settingsWith({ remoteVaultFolderId: "id:vault", lastKnownVaultName: "old" }),
			"new",
		);

		// The remote folder is bound by id, so it's kept as-is; only the last-known
		// name advances so BackendManager's short-circuit resumes.
		expect(res.backendUpdates).toMatchObject({
			remoteVaultFolderId: "id:vault",
			lastKnownVaultName: "new",
		});
		expect(spy).not.toHaveBeenCalled(); // no move_v2 / createFolder
	});

	it("refuses an empty vault name instead of collapsing the root to '/'", async () => {
		const createSpy = await spyRequestUrl();
		const { provider } = await makeProvider(CONNECTED);
		// An empty/whitespace name would make rootPath "/" and ingest the whole App Folder.
		await expect(provider.resolveRemoteVault({} as never, settingsWith({}), "   ")).rejects.toThrow(/vault name is empty/);
		expect(createSpy).not.toHaveBeenCalled(); // refused before any folder is created
	});
});

describe("DropboxProvider.completeWebFolderPick", () => {
	// Future expiry → getAccessToken returns the cached token without a refresh call,
	// so the mocked requestUrl only ever serves the get_metadata request under test.
	const PENDING = { pendingFolderPickState: "STATE-1", accessTokenExpiry: Date.now() + 3_600_000 };

	it("binds an accessible folder, normalizing a bare id and clearing the state", async () => {
		const spy = (await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("get_metadata")) return Promise.resolve(mockRes(dbxFolder("vault", "/MyVault")));
			return Promise.resolve(mockRes({}));
		});
		const { provider } = await makeProvider(CONNECTED);
		const res = await provider.completeWebFolderPick(
			{ id: "vault", name: "MyVault", state: "STATE-1" }, // bare id (no "id:" prefix)
			settingsWith(PENDING),
		);

		expect(res.backendUpdates).toMatchObject({
			remoteVaultFolderId: "id:vault",
			pendingFolderPickState: "",
		});
		// The path is not persisted — only the id is bound.
		expect(res.backendUpdates).not.toHaveProperty("remoteVaultRootPath");
		// get_metadata was queried with the normalized id.
		const call = spy.mock.calls.find((c) => String((c[0] as RequestUrlParam).url).includes("get_metadata"));
		expect((JSON.parse((call![0] as RequestUrlParam).body as string) as { path: string }).path).toBe("id:vault");
	});

	it("rejects a CSRF state mismatch before any network call", async () => {
		const spy = await spyRequestUrl();
		const { provider } = await makeProvider(CONNECTED);
		await expect(
			provider.completeWebFolderPick({ id: "id:x", state: "WRONG" }, settingsWith(PENDING)),
		).rejects.toThrow(/State mismatch/);
		expect(spy).not.toHaveBeenCalled();
	});

	it("rejects a folder outside the app folder (get_metadata not_found) with a clear message", async () => {
		(await spyRequestUrl()).mockResolvedValue(
			mockRes({ error_summary: "path/not_found/..", error: { ".tag": "path" } }, { status: 409 }),
		);
		const { provider } = await makeProvider(CONNECTED);
		await expect(
			provider.completeWebFolderPick({ id: "id:outside", state: "STATE-1" }, settingsWith(PENDING)),
		).rejects.toThrow(/Apps\/Air Sync/);
	});

	it("rethrows a non-not_found error (e.g. server error) instead of the app-folder message", async () => {
		// A transient/server error must surface as itself, not be misreported as
		// "pick a folder under Apps/Air Sync/" (which would send the user chasing a
		// non-existent scope problem). 500 does not trigger the client's 429 retry.
		(await spyRequestUrl()).mockResolvedValue(mockRes({ error_summary: "internal_error/.." }, { status: 500 }));
		const { provider } = await makeProvider(CONNECTED);
		const call = provider.completeWebFolderPick({ id: "id:x", state: "STATE-1" }, settingsWith(PENDING));
		await expect(call).rejects.toThrow(/500|internal_error/);
		await expect(call).rejects.not.toThrow(/Apps\/Air Sync/);
	});

	it("rejects when the selected item is a file, not a folder", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes(dbxFile("f", "/note.md")));
		const { provider } = await makeProvider(CONNECTED);
		await expect(
			provider.completeWebFolderPick({ id: "id:f", state: "STATE-1" }, settingsWith(PENDING)),
		).rejects.toThrow(/select a folder/);
	});

	it("rejects when no folder id is provided", async () => {
		const { provider } = await makeProvider(CONNECTED);
		await expect(
			provider.completeWebFolderPick({ state: "STATE-1" }, settingsWith(PENDING)),
		).rejects.toThrow(/No folder/);
	});
});

describe("DropboxProvider.getRemoteVaultDisplayPath", () => {
	it("resolves the bound folder's current path from its id (not persisted)", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes(dbxFolder("vault", "/MyVault")));
		const { provider } = await makeProvider(CONNECTED);
		const path = await provider.getRemoteVaultDisplayPath(
			settingsWith({ remoteVaultFolderId: "id:vault", accessTokenExpiry: Date.now() + 3_600_000 }),
		);
		expect(path).toBe("/MyVault");
		const call = spy.mock.calls.find((c) => String((c[0] as RequestUrlParam).url).includes("get_metadata"));
		expect((JSON.parse((call![0] as RequestUrlParam).body as string) as { path: string }).path).toBe("id:vault");
	});

	it("returns null when no folder is bound", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(await provider.getRemoteVaultDisplayPath(settingsWith({}))).toBeNull();
	});
});

describe("DropboxProvider checkpoint state", () => {
	it("commits the cursor only on a fully-successful sync, and never persists a path", async () => {
		const { provider } = await makeProvider(CONNECTED);
		const { DropboxFs } = await import("./index");
		const { DropboxClient } = await import("./client");
		const fs = new DropboxFs(new DropboxClient(() => Promise.resolve("AT")), "id:root");
		fs.cursor = "CURSOR-1";

		const partial = provider.readBackendState(fs, false);
		expect(partial.cursor).toBeUndefined();
		// The remote path is resolved from the id on demand, never persisted.
		expect(partial).not.toHaveProperty("remoteVaultRootPath");

		expect(provider.readBackendState(fs, true).cursor).toBe("CURSOR-1");
	});

	it("hasCheckpoint reflects a stored cursor and resetTargetState clears it", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.hasCheckpoint(settingsWith({ cursor: "C" }))).toBe(true);
		const settings = settingsWith({ cursor: "C" });
		provider.resetTargetState(settings);
		expect(settings.backendData.cursor).toBeUndefined();
	});
});

describe("DropboxProvider.disconnect", () => {
	it("clears both token secrets and resets backend data", async () => {
		const { provider, store } = await makeProvider(CONNECTED);
		const data = await provider.disconnect(settingsWith({ remoteVaultFolderId: "id:x", cursor: "C" }));
		expect(store.getSecret("air-sync-dropbox-refresh-token")).toBe("");
		expect(store.getSecret("air-sync-dropbox-access-token")).toBe("");
		expect(data).toMatchObject({ remoteVaultFolderId: "", cursor: "" });
	});
});
