import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, createMockSecretStore, odFolder } from "./test-helpers";
import { GraphApiError } from "./types";
import type { AirSyncSettings } from "../../settings";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

async function makeProvider(secrets: Record<string, string> = {}) {
	const { OneDriveProvider } = await import("./provider");
	const store = createMockSecretStore(secrets);
	return { provider: new OneDriveProvider(store), store };
}

function settingsWith(onedrive: Record<string, unknown> = {}): AirSyncSettings {
	return { vaultId: "vault-1", backendData: onedrive } as unknown as AirSyncSettings;
}

const CONNECTED = { "air-sync-onedrive-refresh-token": "RT", "air-sync-onedrive-access-token": "AT" };
const FRESH = { accessTokenExpiry: Date.now() + 3_600_000 };

const APP_ROOT_URL = "/me/drive/special/approot";

describe("OneDriveProvider.isConnected / getIdentity", () => {
	it("requires a token and a resolved remote vault folder id", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.isConnected(settingsWith({}))).toBe(false);
		expect(provider.isConnected(settingsWith({ remoteVaultFolderId: "id9" }))).toBe(true);
	});

	it("derives identity from the folder id", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.getIdentity(settingsWith({ remoteVaultFolderId: "id9" }))).toBe("onedrive:id9");
		expect(provider.getIdentity(settingsWith({}))).toBeNull();
	});
});

describe("OneDriveProvider.classifyError", () => {
	it("maps 507 insufficient storage to permission and 503 to transient", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.classifyError(new GraphApiError("full", 507, "quotaLimitReached")).kind).toBe("permission");
		expect(provider.classifyError(new GraphApiError("down", 503, "serviceNotAvailable")).kind).toBe("transient");
	});
});

describe("OneDriveProvider.resolveRemoteVault", () => {
	it("find-or-creates approot:/<vaultName> on first connect when no name is pending", async () => {
		const spy = (await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const o = typeof opts === "string" ? { url: opts } : opts;
			const url = String(o.url);
			if (url.endsWith(APP_ROOT_URL)) return Promise.resolve(mockRes(odFolder("approot", "approot", "drive")));
			// getChildByName(approot, "v") → 404 (does not yet exist) → triggers create.
			if (url.includes("approot:/v:") || url.includes("/approot:/v")) {
				return Promise.resolve(mockRes({ error: { code: "itemNotFound" } }, { status: 404 }));
			}
			if (o.method === "POST") return Promise.resolve(mockRes(odFolder("vaultid", "v", "approot")));
			return Promise.resolve(mockRes({}));
		});
		const { provider } = await makeProvider(CONNECTED);
		const res = await provider.resolveRemoteVault({} as never, settingsWith(FRESH), "v");

		expect(res.backendUpdates).toMatchObject({ remoteVaultFolderId: "vaultid", pendingPickedFolderPath: "" });
		// A folder named "v" was created under the app root.
		const createCall = spy.mock.calls.find((c) => (c[0] as RequestUrlParam).method === "POST");
		const body = JSON.parse((createCall![0] as RequestUrlParam).body as string) as { name: string };
		expect(body.name).toBe("v");
	});

	it("binds an existing pending-picked folder instead of the vault name", async () => {
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const o = typeof opts === "string" ? { url: opts } : opts;
			const url = String(o.url);
			if (url.endsWith(APP_ROOT_URL)) return Promise.resolve(mockRes(odFolder("approot", "approot", "drive")));
			// getChildByName(approot, "Picked") → exists → bound directly (no create).
			return Promise.resolve(mockRes(odFolder("pickedid", "Picked", "approot")));
		});
		const { provider } = await makeProvider(CONNECTED);
		const res = await provider.resolveRemoteVault(
			{} as never,
			settingsWith({ ...FRESH, pendingPickedFolderPath: "Picked" }),
			"vaultName",
		);
		expect(res.backendUpdates).toMatchObject({ remoteVaultFolderId: "pickedid", pendingPickedFolderPath: "" });
	});

	it("does NOT touch the remote folder on a local vault rename (id binds them)", async () => {
		const spy = await spyRequestUrl(); // no request should be made
		const { provider } = await makeProvider(CONNECTED);
		const res = await provider.resolveRemoteVault({} as never, settingsWith({ remoteVaultFolderId: "vaultid" }), "new");
		expect(res.backendUpdates).toMatchObject({ remoteVaultFolderId: "vaultid" });
		expect(spy).not.toHaveBeenCalled();
	});

	it("refuses an empty vault name instead of collapsing to the app root", async () => {
		const spy = await spyRequestUrl();
		const { provider } = await makeProvider(CONNECTED);
		await expect(provider.resolveRemoteVault({} as never, settingsWith(FRESH), "   ")).rejects.toThrow(/vault name is empty/);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("OneDriveProvider.getRemoteVaultDisplayPath", () => {
	it("resolves the bound folder's current display path from its id (not persisted)", async () => {
		(await spyRequestUrl()).mockResolvedValue(
			mockRes({ id: "vaultid", name: "MyVault", parentReference: { id: "approot", path: "/drive/root:/Apps/Air Sync" } }),
		);
		const { provider } = await makeProvider(CONNECTED);
		const path = await provider.getRemoteVaultDisplayPath(settingsWith({ remoteVaultFolderId: "vaultid", ...FRESH }));
		expect(path).toBe("/Apps/Air Sync/MyVault");
	});

	it("returns null when no folder is bound", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(await provider.getRemoteVaultDisplayPath(settingsWith({}))).toBeNull();
	});
});

describe("OneDriveProvider.readBackendState", () => {
	it("never returns a cursor (the cursor co-commits with the cache in IDB)", async () => {
		const { provider } = await makeProvider(CONNECTED);
		const state = provider.readBackendState();
		expect(state).not.toHaveProperty("cursor");
	});
});

describe("OneDriveProvider.disconnect / clearPluginSecrets", () => {
	it("clears both token secrets and resets backend data", async () => {
		const { provider, store } = await makeProvider(CONNECTED);
		const data = await provider.disconnect(settingsWith({ remoteVaultFolderId: "x" }));
		expect(store.getSecret("air-sync-onedrive-refresh-token")).toBe("");
		expect(store.getSecret("air-sync-onedrive-access-token")).toBe("");
		expect(data).toMatchObject({ remoteVaultFolderId: "", pendingPickedFolderPath: "" });
	});

	it("sweeps both token secrets without a network call (backend-switch reset)", async () => {
		const { provider, store } = await makeProvider(CONNECTED);
		provider.clearPluginSecrets();
		expect(store.getSecret("air-sync-onedrive-refresh-token")).toBe("");
		expect(store.getSecret("air-sync-onedrive-access-token")).toBe("");
	});
});
