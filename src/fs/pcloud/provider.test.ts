import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import type { AirSyncSettings } from "../../settings";
import { spyRequestUrl, mockRes, createMockSecretStore } from "./test-helpers";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

const ACCESS_KEY = "air-sync-pcloud-access-token";

function settings(pcloud: Record<string, unknown> = {}): AirSyncSettings {
	return {
		vaultId: "v1",
		backendType: "pcloud",
		conflictStrategy: "auto_merge",
		ignorePatterns: [],
		enableThreeWayMerge: true,
		syncDotPaths: [],
		mobileMaxFileSizeMB: 10,
		screenWakeLockOnSync: false,
		enableLogging: false,
		logLevel: "info",
		backendData: { pcloud },
	};
}

async function makeProvider(secrets: Record<string, string> = {}) {
	const { PCloudProvider } = await import("./provider");
	return new PCloudProvider(createMockSecretStore(secrets));
}

describe("PCloudProvider connection state", () => {
	it("isConnected requires both an access token and a remote vault folder", async () => {
		const noToken = await makeProvider();
		expect(noToken.isConnected(settings({ remoteVaultFolderId: "9" }))).toBe(false);

		const connected = await makeProvider({ [ACCESS_KEY]: "TOK" });
		expect(connected.isConnected(settings({ remoteVaultFolderId: "9" }))).toBe(true);
		expect(connected.isConnected(settings({}))).toBe(false);
	});

	it("getIdentity is folder-scoped", async () => {
		const provider = await makeProvider();
		expect(provider.getIdentity(settings({ remoteVaultFolderId: "9" }))).toBe("pcloud:9");
		expect(provider.getIdentity(settings({}))).toBeNull();
	});

	it("hasCheckpoint reflects a stored diffId; resetTargetState clears it", async () => {
		const provider = await makeProvider();
		expect(provider.hasCheckpoint(settings({ diffId: "5" }))).toBe(true);
		const s = settings({ diffId: "5" });
		provider.resetTargetState(s);
		expect(s.backendData.pcloud?.diffId).toBeUndefined();
	});
});

describe("PCloudProvider.createFs", () => {
	it("returns null without a token or folder", async () => {
		const provider = await makeProvider();
		expect(provider.createFs({} as never, settings({ remoteVaultFolderId: "9" }))).toBeNull();
	});

	it("creates a PCloudFs and restores the diff cursor", async () => {
		const { PCloudFs } = await import("./index");
		const provider = await makeProvider({ [ACCESS_KEY]: "TOK" });
		const fs = provider.createFs({} as never, settings({ remoteVaultFolderId: "9", diffId: "77" }));
		expect(fs).toBeInstanceOf(PCloudFs);
		expect((fs as InstanceType<typeof PCloudFs>).diffId).toBe("77");
	});
});

describe("PCloudProvider.readBackendState", () => {
	it("commits the diff cursor only on a successful checkpoint", async () => {
		const { PCloudFs } = await import("./index");
		const { PCloudClient } = await import("./client");
		const provider = await makeProvider({ [ACCESS_KEY]: "TOK" });
		const fs = new PCloudFs(new PCloudClient(() => "TOK", () => "api.pcloud.com"), "9");
		fs.diffId = "101";
		expect(provider.readBackendState(fs, true)).toEqual({ diffId: "101" });
		expect(provider.readBackendState(fs, false)).toEqual({});
	});
});

describe("PCloudProvider.resolveRemoteVault", () => {
	it("creates /obsidian-air-sync/<vault> and returns its folder id", async () => {
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("name=obsidian-air-sync")) {
				return Promise.resolve(mockRes({ result: 0, metadata: { id: "d100", name: "obsidian-air-sync", isfolder: true, folderid: 100 } }));
			}
			return Promise.resolve(mockRes({ result: 0, metadata: { id: "d200", name: "MyVault", isfolder: true, folderid: 200 } }));
		});
		const provider = await makeProvider({ [ACCESS_KEY]: "TOK" });
		const res = await provider.resolveRemoteVault({} as never, settings({}), "MyVault");
		expect(res.backendUpdates).toEqual({ remoteVaultFolderId: "200", lastKnownVaultName: "MyVault" });
	});

	it("renames the existing folder when the vault was renamed locally", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ result: 0, metadata: { id: "d200", name: "NewName", isfolder: true, folderid: 200 } }),
		);
		const provider = await makeProvider({ [ACCESS_KEY]: "TOK" });
		const res = await provider.resolveRemoteVault(
			{} as never,
			settings({ remoteVaultFolderId: "200", lastKnownVaultName: "OldName" }),
			"NewName",
		);
		expect(spy.mock.calls[0]![0]).toMatchObject({});
		const url = (spy.mock.calls[0]![0] as RequestUrlParam).url;
		expect(url).toContain("/renamefolder?");
		expect(url).toContain("toname=NewName");
		expect(res.backendUpdates.remoteVaultFolderId).toBe("200");
	});
});

describe("PCloudProvider.disconnect", () => {
	it("clears the access secret and resets backend data", async () => {
		const store = createMockSecretStore({ [ACCESS_KEY]: "TOK" });
		const { PCloudProvider } = await import("./provider");
		const provider = new PCloudProvider(store);
		const reset = await provider.disconnect(settings({ remoteVaultFolderId: "9", diffId: "5" }));
		expect(store.getSecret(ACCESS_KEY)).toBe("");
		expect(reset).toMatchObject({ remoteVaultFolderId: "", diffId: "", apiHost: "" });
	});
});
