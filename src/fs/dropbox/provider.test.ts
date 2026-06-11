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
		// Fresh expiry → the cached access token is used directly, so the mocked
		// requestUrl only serves the create_folder_v2 call under test (no token refresh).
		const res = await provider.resolveRemoteVault(
			{} as never,
			settingsWith({ accessTokenExpiry: Date.now() + 3_600_000 }),
			"v",
		);

		expect(res.backendUpdates).toMatchObject({
			remoteVaultFolderId: "id:vault",
		});
		// The path is not persisted — only the id.
		expect(res.backendUpdates).not.toHaveProperty("remoteVaultRootPath");
		// Only the vault folder is created — no wrapper-root folder call.
		const createCalls = spy.mock.calls.filter((c) => String((c[0] as RequestUrlParam).url).includes("create_folder_v2"));
		expect(createCalls.length).toBe(1);
		expect((JSON.parse((createCalls[0]![0] as RequestUrlParam).body as string) as { path: string }).path).toBe("/v");
	});

	it("binds the pending-picked folder name instead of the vault name, and clears the pending field", async () => {
		const spy = (await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("create_folder_v2")) {
				// create_folder_v2 is idempotent, so a picked existing folder resolves here too.
				const body = JSON.parse((opts as RequestUrlParam).body as string) as { path: string };
				return Promise.resolve(mockRes({ metadata: dbxFolder("picked", body.path) }));
			}
			return Promise.resolve(mockRes({}));
		});
		const { provider } = await makeProvider(CONNECTED);
		const res = await provider.resolveRemoteVault(
			{} as never,
			settingsWith({ accessTokenExpiry: Date.now() + 3_600_000, pendingPickedFolderPath: "Picked" }),
			"vaultName",
		);

		expect(res.backendUpdates).toMatchObject({
			remoteVaultFolderId: "id:picked",
			pendingPickedFolderPath: "",
		});
		// The picked name (not the vault name) drove the find-or-create path.
		const createCall = spy.mock.calls.find((c) => String((c[0] as RequestUrlParam).url).includes("create_folder_v2"));
		expect((JSON.parse((createCall![0] as RequestUrlParam).body as string) as { path: string }).path).toBe("/Picked");
	});

	it("rejects binding when the chosen name collides with an existing FILE (not a folder)", async () => {
		// create_folder_v2 conflicts with an existing file; createFolder's idempotent path
		// then resolves to that FILE's metadata. resolveRemoteVault must NOT bind a file id.
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("create_folder_v2")) {
				return Promise.resolve(mockRes({ error_summary: "path/conflict/file/..", error: { ".tag": "path" } }, { status: 409 }));
			}
			if (url.includes("get_metadata")) return Promise.resolve(mockRes(dbxFile("collide", "/Notes")));
			return Promise.resolve(mockRes({}));
		});
		const { provider } = await makeProvider(CONNECTED);
		await expect(
			provider.resolveRemoteVault(
				{} as never,
				settingsWith({ accessTokenExpiry: Date.now() + 3_600_000, pendingPickedFolderPath: "Notes" }),
				"vaultName",
			),
		).rejects.toThrow(/already exists in the app folder/);
	});

	it("does NOT touch the remote folder on a local vault rename (id binds them)", async () => {
		const spy = await spyRequestUrl(); // no impl needed — no request should be made
		const { provider } = await makeProvider(CONNECTED);
		const res = await provider.resolveRemoteVault(
			{} as never,
			settingsWith({ remoteVaultFolderId: "id:vault" }),
			"new",
		);

		// The remote folder is bound by id, so it's kept as-is on a local vault rename.
		expect(res.backendUpdates).toMatchObject({
			remoteVaultFolderId: "id:vault",
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

describe("DropboxProvider.readBackendState", () => {
	it("persists refreshed token expiry but NEVER a cursor (the cursor co-commits with the cache in IDB)", async () => {
		const { provider } = await makeProvider(CONNECTED);
		// The delta cursor is no longer in settings (ADR 0001 — it commits atomically
		// with the file-map cache via the FS's commitCheckpoint), so readBackendState
		// takes no FS and never returns a `cursor` key.
		const state = provider.readBackendState();
		expect(state).not.toHaveProperty("cursor");
		expect(state).not.toHaveProperty("remoteVaultRootPath");
	});
});

describe("DropboxProvider.disconnect", () => {
	it("clears both token secrets and resets backend data", async () => {
		const { provider, store } = await makeProvider(CONNECTED);
		const data = await provider.disconnect(settingsWith({ remoteVaultFolderId: "id:x" }));
		expect(store.getSecret("air-sync-dropbox-refresh-token")).toBe("");
		expect(store.getSecret("air-sync-dropbox-access-token")).toBe("");
		expect(data).toMatchObject({ remoteVaultFolderId: "" });
	});
});

describe("DropboxProvider.clearPluginSecrets", () => {
	it("sweeps both token secrets without a network call (used by the backend-switch reset)", async () => {
		const { provider, store } = await makeProvider(CONNECTED);
		// switchBackend calls clearPluginSecrets on EVERY registered backend, including
		// one that was authed but never bound (so disconnect's revoke never ran). Without
		// this, a leftover Dropbox token would linger under air-sync-dropbox-* keys.
		provider.clearPluginSecrets();
		expect(store.getSecret("air-sync-dropbox-refresh-token")).toBe("");
		expect(store.getSecret("air-sync-dropbox-access-token")).toBe("");
	});
});
