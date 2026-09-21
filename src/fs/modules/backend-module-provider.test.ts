import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type {
	BackendModule,
	RemoteBackendAdapter,
} from "../../backend-api";
import { BACKEND_MODULE_API_VERSION } from "../../backend-api";
import type { AirSyncSettings } from "../../settings";
import type { ISecretStore } from "../secret-store";
import type { BackendPlatformInfo } from "../backend";
import { googleDriveModule } from "../googledrive/module";
import { dropboxModule } from "../dropbox/module";
import { oneDriveModule } from "../onedrive/module";
import { BackendModuleProvider } from "./backend-module-provider";
import type { BackendModuleProviderDeps } from "./backend-module-provider";
import { ManagedRemoteFs } from "../managed/managed-remote-fs";

vi.mock("obsidian");

const PLATFORM: BackendPlatformInfo = {
	mobile: false,
};

function settingsWith(backendData: Record<string, unknown>): AirSyncSettings {
	return { vaultId: "vault-1", backendType: "googledrive", backendData } as unknown as AirSyncSettings;
}

function makeProvider(
	moduleId: "googledrive" | "dropbox",
	settings: AirSyncSettings,
	getSecretImpl: (key: string) => string | null,
) {
	const getSecret = vi.fn(getSecretImpl);
	const secretStore: ISecretStore = {
		getSecret,
		setSecret: vi.fn(),
	};
	const deps: BackendModuleProviderDeps = {
		getSettings: () => settings,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		getApp: (() => ({})) as BackendModuleProviderDeps["getApp"],
		getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as never,
		getVaultName: () => "Vault",
		secretStore,
		platform: PLATFORM,
		sink: vi.fn(),
	};
	const module = moduleId === "googledrive" ? googleDriveModule : dropboxModule;
	return { provider: new BackendModuleProvider(module, deps), getSecret };
}

describe("BackendModuleProvider — identity and target", () => {
	it("composes identity from the canonical module id and the bound target", () => {
		const settings = settingsWith({ authMode: "default", remoteVaultFolderId: "FID" });
		const { provider } = makeProvider("googledrive", settings, () => null);
		expect(provider.type).toBe("googledrive");
		expect(provider.getIdentity(settings)).toBe("googledrive:FID");
	});
});

describe("BackendModuleProvider — custom OAuth routing", () => {
	it("Google custom resolves its client credentials as user-owned secret references", async () => {
		const settings = settingsWith({
			authMode: "custom",
			remoteVaultFolderId: "FID",
			customClientId: "my-client-secret",
			customClientSecret: "my-client-secret-2",
		});
		const { provider, getSecret } = makeProvider(
			"googledrive",
			settings,
			(key) => (key === "my-client-secret" ? "CID" : key === "my-client-secret-2" ? "CS" : null),
		);

		await provider.prepare();

		// The REFERENCE NAME is the physical key; the plugin never fabricates a
		// `-token` key for a `secret_reference` field.
		expect(getSecret).toHaveBeenCalledWith("my-client-secret");
		expect(getSecret).toHaveBeenCalledWith("my-client-secret-2");
		expect(getSecret).not.toHaveBeenCalledWith("air-sync-googledrive-customClientId-token");
	});

	it("Dropbox custom treats its app key as a public value, not a SecretStorage reference", async () => {
		const settings = settingsWith({
			authMode: "custom",
			remoteVaultFolderId: "id:folder",
			customClientId: "PUBLIC-APP-KEY",
		});
		const { provider, getSecret } = makeProvider("dropbox", settings, (key) =>
			key.includes("refresh") ? "RT" : key.includes("access") ? "AT" : null,
		);

		await provider.prepare();

		expect(getSecret).not.toHaveBeenCalledWith("PUBLIC-APP-KEY");
		// Tokens keep their legacy `-custom` physical namespace.
		expect(getSecret).toHaveBeenCalledWith("air-sync-dropbox-custom-refresh-token");
	});
});

describe("BackendModuleProvider — token namespace", () => {
	it("keeps OneDrive custom tokens under the legacy -custom keys", () => {
		const settings = settingsWith({ authMode: "custom", remoteVaultFolderId: "id:folder" });
		const getSecret = vi.fn((key: string) => (key === "air-sync-onedrive-custom-refresh-token" ? "RT" : null));
		const setSecret = vi.fn();
		const store: ISecretStore = { getSecret, setSecret };
		const deps: BackendModuleProviderDeps = {
			getSettings: () => settings,
			saveSettings: vi.fn().mockResolvedValue(undefined),
			getApp: (() => ({})) as BackendModuleProviderDeps["getApp"],
			getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as never,
			getVaultName: () => "Vault",
			secretStore: store,
			platform: PLATFORM,
			sink: vi.fn(),
		};
		const provider = new BackendModuleProvider(oneDriveModule, deps);

		expect(provider.hasCredentials()).toBe(true);
		provider.clearPluginSecrets();
		expect(setSecret).toHaveBeenCalledWith("air-sync-onedrive-custom-refresh-token", "");
		expect(setSecret).toHaveBeenCalledWith("air-sync-onedrive-refresh-token", "");
	});
});

describe("BackendModuleProvider — disconnect config preservation", () => {
	it("keeps custom Google credentials and its hand-typed folder id, dropping flow state", async () => {
		const settings = settingsWith({
			authMode: "custom",
			remoteVaultFolderId: "FID",
			customClientId: "my-client-secret",
			customClientSecret: "my-client-secret-2",
			customScope: "drive.file",
			pendingAuthState: "STATE",
		});
		const { provider } = makeProvider("googledrive", settings, () => null);

		await provider.disconnect(settings);

		expect(settings.backendData).toEqual({
			authMode: "custom",
			customClientId: "my-client-secret",
			customClientSecret: "my-client-secret-2",
			customScope: "drive.file",
			remoteVaultFolderId: "FID",
		});
	});

	it("a built-in selection resets to authMode only", async () => {
		const settings = settingsWith({
			authMode: "default",
			remoteVaultFolderId: "FID",
			pendingAuthState: "STATE",
		});
		const { provider } = makeProvider("googledrive", settings, () => null);

		await provider.disconnect(settings);

		expect(settings.backendData).toEqual({ authMode: "default" });
	});
});

function stubAdapter(): RemoteBackendAdapter {
	return {
		getStartCursor: () => Promise.resolve("cursor"),
		listAll: () => Promise.resolve([]),
		assertRootAlive: () => Promise.resolve(),
		getChanges: () => Promise.resolve({ kind: "cursor_invalid" } as const),
		getById: () => Promise.resolve(null),
		getByPath: () => Promise.resolve([]),
		read: () => Promise.resolve({ kind: "unverifiable", reason: "fake" } as const),
		createFile: () => Promise.reject(new Error("unused")),
		updateFile: () => Promise.reject(new Error("unused")),
		createDirectory: () => Promise.reject(new Error("unused")),
		move: () => Promise.reject(new Error("unused")),
		delete: () => Promise.resolve(),
	};
}

function fakeModule(readState?: () => Record<string, unknown>): BackendModule {
	const adapter: RemoteBackendAdapter = readState
		? Object.assign(stubAdapter(), { readState })
		: stubAdapter();
	return {
		id: "fakebackend",
		displayName: "Fake",
		version: "1.0.0",
		apiVersion: BACKEND_MODULE_API_VERSION,
		auth: {
			isAuthenticated: () => true,
			start: () => Promise.resolve({}),
			complete: () => Promise.resolve({}),
		},
		binding: {
			resolveDefault: () => Promise.resolve({ patch: {}, target: { id: "T" } }),
			getDisplayPath: () =>
				Promise.resolve({
					id: "T",
					displayPath: "/p/ath",
					warning: "This folder is in Google Drive's Trash.",
				}),
		},
		getTarget: () => ({ id: "T" }),
		createAdapter: () => Promise.resolve(adapter),
	};
}

function providerFor(module: BackendModule, settings: AirSyncSettings): BackendModuleProvider {
	const deps: BackendModuleProviderDeps = {
		getSettings: () => settings,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		getApp: (() => ({})) as BackendModuleProviderDeps["getApp"],
		getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as never,
		getVaultName: () => "Vault",
		secretStore: { getSecret: () => null, setSecret: vi.fn() },
		platform: PLATFORM,
		sink: vi.fn(),
	};
	return new BackendModuleProvider(module, deps);
}

describe("BackendModuleProvider — bound-folder display warning", () => {
	it("passes a present-but-unusable target's warning through to the display", async () => {
		const settings = settingsWith({ authMode: "default", remoteVaultFolderId: "T" });
		const provider = providerFor(fakeModule(), settings);
		await expect(provider.getRemoteVaultDisplayPath(settings)).resolves.toEqual({
			path: "/p/ath",
			warning: "This folder is in Google Drive's Trash.",
		});
	});
});

describe("BackendModuleProvider — refreshed auth state persistence", () => {
	it("carries the adapter's non-authoritative state into readBackendState", async () => {
		const settings = settingsWith({ authMode: "default", remoteVaultFolderId: "T" });
		const provider = providerFor(fakeModule(() => ({ accessTokenExpiry: 123 })), settings);
		await provider.prepare();
		expect(provider.readBackendState()).toEqual({ accessTokenExpiry: 123 });
	});

	it("returns an empty bag when the adapter exposes no state", async () => {
		const settings = settingsWith({ authMode: "default", remoteVaultFolderId: "T" });
		const provider = providerFor(fakeModule(), settings);
		await provider.prepare();
		expect(provider.readBackendState()).toEqual({});
	});
});

describe("BackendModuleProvider — prepared filesystem release", () => {
	it("closes the prepared managed filesystem on close", async () => {
		const settings = settingsWith({ authMode: "default", remoteVaultFolderId: "T" });
		const provider = providerFor(fakeModule(), settings);
		await provider.prepare();
		const closeSpy = vi.spyOn(ManagedRemoteFs.prototype, "close");

		provider.close();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		closeSpy.mockRestore();
	});

	it("closes the prepared managed filesystem on disconnect", async () => {
		const settings = settingsWith({ authMode: "default", remoteVaultFolderId: "T" });
		const provider = providerFor(fakeModule(), settings);
		await provider.prepare();
		const closeSpy = vi.spyOn(ManagedRemoteFs.prototype, "close");

		await provider.disconnect(settings);

		expect(closeSpy).toHaveBeenCalled();
		closeSpy.mockRestore();
	});
});
