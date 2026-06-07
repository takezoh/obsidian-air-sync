import { describe, it, expect, vi, beforeEach } from "vitest";
import { BackendManager, BackendManagerDeps } from "./backend-manager";
import type { IBackendProvider } from "./backend";
import type { AirSyncSettings } from "../settings";
import type { IFileSystem } from "./interface";
import type { Logger } from "../logging/logger";
import { AuthError } from "./errors";
import { mockSettings } from "../__mocks__/sync-test-helpers";

// Mock the registry to return our fake provider
vi.mock("./registry", () => ({
	getBackendProvider: (type: string) => {
		if (type === "test") return fakeProvider;
		if (type === "other") return otherProvider;
		return undefined;
	},
	getAllBackendProviders: () => [fakeProvider, otherProvider].filter(Boolean),
}));

let fakeProvider: IBackendProvider;
let otherProvider: IBackendProvider;
let fakeFs: IFileSystem;

function createDeps(
	settings: AirSyncSettings,
	overrides: Partial<BackendManagerDeps> = {},
): BackendManagerDeps {
	const noopLogger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		flush: vi.fn(),
	} as unknown as Logger;

	return {
		getSettings: () => settings,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		getApp: (() => ({})) as unknown as BackendManagerDeps["getApp"],
		getLogger: () => noopLogger,
		getVaultName: () => "Test Vault",
		onConnected: vi.fn(),
		onDisconnected: vi.fn(),
		onIdentityChanged: vi.fn().mockResolvedValue(undefined),
		notify: vi.fn(),
		refreshSettingsDisplay: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	fakeFs = {
		name: "test-remote",
		list: vi.fn().mockResolvedValue([]),
		stat: vi.fn().mockResolvedValue(null),
		read: vi.fn(),
		write: vi.fn(),
		mkdir: vi.fn(),
		delete: vi.fn(),
		rename: vi.fn(),
	} as unknown as IFileSystem;

	fakeProvider = {
		type: "test",
		displayName: "Test",
		auth: {
			isAuthenticated: () => true,
			startAuth: vi.fn(),
			completeAuth: vi.fn(),
		},
		createFs: () => fakeFs,
		isConnected: () => true,
		getIdentity: () => "test:folder-A",
		resetTargetState: vi.fn(),
		disconnect: vi.fn().mockResolvedValue({}),
		clearPluginSecrets: vi.fn(),
	};
	otherProvider = {
		type: "other",
		displayName: "Other",
		auth: { isAuthenticated: () => false, startAuth: vi.fn(), completeAuth: vi.fn() },
		createFs: () => null,
		isConnected: () => false,
		getIdentity: () => null,
		disconnect: vi.fn().mockResolvedValue({}),
		clearPluginSecrets: vi.fn(),
	};
});

describe("BackendManager — identity change triggers onIdentityChanged", () => {
	it("does not call onIdentityChanged on first initBackend call", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.onIdentityChanged).not.toHaveBeenCalled();
		expect(deps.onConnected).toHaveBeenCalled();
	});

	it("calls onIdentityChanged when identity changes between initBackend calls", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend(); // identity = "test:folder-A"

		// Change identity
		fakeProvider.getIdentity = () => "test:folder-B";
		await mgr.initBackend();

		expect(deps.onIdentityChanged).toHaveBeenCalledTimes(1);
	});

	it("does not call onIdentityChanged when identity stays the same", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();
		await mgr.initBackend();

		expect(deps.onIdentityChanged).not.toHaveBeenCalled();
	});

	it("calls onIdentityChanged and resets identity on disconnect", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();
		await mgr.disconnectBackend();

		expect(deps.onIdentityChanged).toHaveBeenCalledTimes(1);

		// After disconnect, re-init should not trigger another callback
		// (lastBackendIdentity was reset to null)
		(deps.onIdentityChanged as ReturnType<typeof vi.fn>).mockClear();
		await mgr.initBackend();
		expect(deps.onIdentityChanged).not.toHaveBeenCalled();
	});

	it("calls provider.resetTargetState on identity change", async () => {
		const resetSpy = vi.fn();
		fakeProvider.resetTargetState = resetSpy;

		const settings = mockSettings({
			backendData: { changesStartPageToken: "old-token", other: "keep" },
		});
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend(); // identity = "test:folder-A"

		fakeProvider.getIdentity = () => "test:folder-B";
		await mgr.initBackend();

		expect(resetSpy).toHaveBeenCalledTimes(1);
		expect(resetSpy).toHaveBeenCalledWith(settings);
	});

	it("clears stale baselines on the first init after a cross-reload backend switch", async () => {
		// A fresh manager == a plugin reload: the in-memory identity is gone, but the
		// identity the state was last reconciled against survives in settings. So a
		// custom→built-in switch must still be detected on this first init — otherwise
		// the new target silently reuses the old backend's baselines (nothing uploads).
		const resetSpy = vi.fn();
		fakeProvider.resetTargetState = resetSpy;
		fakeProvider.getIdentity = () => "test:folder-NEW";
		const settings = mockSettings({ lastSyncedIdentity: "other:folder-OLD" });
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend(); // first init of this instance

		expect(deps.onIdentityChanged).toHaveBeenCalledTimes(1);
		expect(resetSpy).toHaveBeenCalledTimes(1);
		expect(settings.lastSyncedIdentity).toBe("test:folder-NEW");
	});

	it("persists the synced identity on first init when none was stored", async () => {
		const settings = mockSettings(); // lastSyncedIdentity == ""
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.onIdentityChanged).not.toHaveBeenCalled();
		expect(settings.lastSyncedIdentity).toBe("test:folder-A");
	});

	it("forgets the persisted identity on disconnect", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();
		expect(settings.lastSyncedIdentity).toBe("test:folder-A");

		await mgr.disconnectBackend();
		expect(settings.lastSyncedIdentity).toBe("");
	});
});

describe("BackendManager — auth error notification on initBackend", () => {
	it("notifies user when initBackend fails with AuthError", async () => {
		fakeProvider.resolveRemoteVault = () => {
			throw new AuthError("Token refresh failed", 400);
		};

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).toHaveBeenCalledWith(
			"Authentication expired. Please reconnect in settings.",
		);
	});

	it("does not notify for non-auth errors", async () => {
		fakeProvider.resolveRemoteVault = () => {
			const err = new Error("Network error");
			(err as Error & { status: number }).status = 503;
			throw err;
		};

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).not.toHaveBeenCalled();
	});
});

describe("BackendManager — switchBackend (hard reset)", () => {
	it("is a no-op when the new type equals the current", async () => {
		const clearSpy = vi.fn();
		fakeProvider.clearPluginSecrets = clearSpy;
		const settings = mockSettings(); // backendType "test"
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);
		await mgr.initBackend();

		await mgr.switchBackend("test");

		expect(clearSpy).not.toHaveBeenCalled();
		expect(settings.backendType).toBe("test");
	});

	it("wipes backendData, clears identity, and clears sync state", async () => {
		const onIdentityChanged = vi.fn().mockResolvedValue(undefined);
		const settings = mockSettings({
			backendData: { remoteVaultFolderId: "FID", customClientId: "ref" },
		});
		const deps = createDeps(settings, { onIdentityChanged });
		const mgr = new BackendManager(deps);
		await mgr.initBackend();
		onIdentityChanged.mockClear();

		await mgr.switchBackend("other");

		expect(settings.backendData).toEqual({});
		expect(settings.lastSyncedIdentity).toBe("");
		expect(settings.backendType).toBe("other");
		expect(onIdentityChanged).toHaveBeenCalledTimes(1);
	});

	it("sweeps plugin-owned tokens for every registered backend", async () => {
		const clearSpy = vi.fn();
		const otherClearSpy = vi.fn();
		fakeProvider.clearPluginSecrets = clearSpy;
		otherProvider.clearPluginSecrets = otherClearSpy;
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);
		await mgr.initBackend();

		await mgr.switchBackend("other");

		expect(clearSpy).toHaveBeenCalled();
		expect(otherClearSpy).toHaveBeenCalled();
	});

	it("best-effort revokes the old backend only when it was connected", async () => {
		const disconnectSpy = vi.fn().mockResolvedValue({});
		fakeProvider.disconnect = disconnectSpy;
		const settings = mockSettings({ backendData: { remoteVaultFolderId: "FID" } });
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);
		await mgr.initBackend();

		await mgr.switchBackend("other"); // fakeProvider.isConnected → true
		expect(disconnectSpy).toHaveBeenCalledTimes(1);
	});

	it("does not revoke the old backend when it was not connected", async () => {
		const disconnectSpy = vi.fn().mockResolvedValue({});
		fakeProvider.disconnect = disconnectSpy;
		fakeProvider.isConnected = () => false;
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);
		await mgr.initBackend();

		await mgr.switchBackend("other");
		expect(disconnectSpy).not.toHaveBeenCalled();
	});

	it("leaves the new backend disconnected (must reconnect)", async () => {
		const onDisconnected = vi.fn();
		const settings = mockSettings();
		const deps = createDeps(settings, { onDisconnected });
		const mgr = new BackendManager(deps);
		await mgr.initBackend();

		await mgr.switchBackend("other"); // otherProvider.isConnected → false

		expect(mgr.getRemoteFs()).toBeNull();
		expect(onDisconnected).toHaveBeenCalled();
	});

	it("holds the connecting flag across the reset (gates concurrent syncs)", async () => {
		// isConnected=false skips the revoke so onIdentityChanged is the first suspension.
		fakeProvider.isConnected = () => false;
		let connectingDuringReset = false;
		let release!: () => void;
		const blocker = new Promise<void>((r) => { release = r; });
		const onIdentityChanged = vi.fn().mockImplementation(async () => {
			connectingDuringReset = mgr.isConnecting();
			await blocker;
		});
		const settings = mockSettings();
		const deps = createDeps(settings, { onIdentityChanged });
		const mgr = new BackendManager(deps);
		await mgr.initBackend();

		const done = mgr.switchBackend("other");
		await Promise.resolve();
		expect(connectingDuringReset).toBe(true); // sync gated out during the reset
		release();
		await done;
		expect(mgr.isConnecting()).toBe(false);
	});
});

describe("BackendManager — isConnected false with prior connection", () => {
	it("notifies when isConnected is false but remoteVaultFolderId exists", async () => {
		fakeProvider.isConnected = () => false;

		const settings = mockSettings({
			backendData: { remoteVaultFolderId: "folder-123" },
		});
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).toHaveBeenCalledWith(
			"Authentication expired. Please reconnect in settings.",
		);
		expect(deps.onDisconnected).toHaveBeenCalled();
	});

	it("does not notify when isConnected is false and no prior connection", async () => {
		fakeProvider.isConnected = () => false;

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).not.toHaveBeenCalled();
		expect(deps.onDisconnected).toHaveBeenCalled();
	});
});

describe("BackendManager — isConnecting flag", () => {
	it("returns false before initBackend is called", () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		expect(mgr.isConnecting()).toBe(false);
	});

	it("returns true while initBackend is in progress", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		let connectingDuringInit = false;
		let resolve!: () => void;
		const blocker = new Promise<void>((r) => {
			resolve = r;
		});

		fakeProvider.resolveRemoteVault = async () => {
			connectingDuringInit = mgr.isConnecting();
			await blocker;
			return { backendUpdates: {} };
		};

		const initPromise = mgr.initBackend();

		// Wait a tick for the async code to reach the blocker
		await Promise.resolve();

		expect(connectingDuringInit).toBe(true);
		resolve();
		await initPromise;
	});

	it("returns false after initBackend completes successfully", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(mgr.isConnecting()).toBe(false);
	});

	it("returns false after initBackend fails", async () => {
		fakeProvider.resolveRemoteVault = () => {
			throw new Error("network error");
		};

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(mgr.isConnecting()).toBe(false);
	});

	it("second concurrent call to initBackend is ignored (early return)", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		let resolve!: () => void;
		const blocker = new Promise<void>((r) => {
			resolve = r;
		});

		fakeProvider.resolveRemoteVault = async () => {
			await blocker;
			return { backendUpdates: {} };
		};

		const first = mgr.initBackend();
		const second = mgr.initBackend(); // should be ignored

		resolve();
		await Promise.all([first, second]);

		// onConnected should only be called once
		expect(deps.onConnected).toHaveBeenCalledTimes(1);
	});

	it("returns true while completeBackendConnect is in progress", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		// Ensure backendProvider is set
		await mgr.initBackend();

		let connectingDuringComplete = false;
		let resolve!: () => void;
		const blocker = new Promise<void>((r) => {
			resolve = r;
		});

		fakeProvider.auth.completeAuth = async () => {
			connectingDuringComplete = mgr.isConnecting();
			await blocker;
			return {};
		};

		const completePromise = mgr.completeBackendConnect("auth-code");

		await Promise.resolve();

		expect(connectingDuringComplete).toBe(true);
		resolve();
		await completePromise;
	});

	it("returns false after completeBackendConnect completes", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		fakeProvider.auth.completeAuth = () => Promise.resolve({});

		await mgr.completeBackendConnect("auth-code");

		expect(mgr.isConnecting()).toBe(false);
	});

	it("records the synced identity after a successful connect", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);
		await mgr.initBackend(); // sets backendProvider
		settings.lastSyncedIdentity = ""; // pretend not yet recorded
		fakeProvider.auth.completeAuth = () => Promise.resolve({});

		await mgr.completeBackendConnect("auth-code");

		expect(settings.lastSyncedIdentity).toBe("test:folder-A");
	});

	it("returns false after completeBackendConnect fails", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		fakeProvider.auth.completeAuth = () => {
			throw new Error("auth failed");
		};

		await mgr.completeBackendConnect("auth-code");

		expect(mgr.isConnecting()).toBe(false);
	});

	it("completeBackendConnect is ignored when initBackend is in progress", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		let resolve!: () => void;
		const blocker = new Promise<void>((r) => {
			resolve = r;
		});

		fakeProvider.resolveRemoteVault = async () => {
			await blocker;
			return { backendUpdates: {} };
		};

		const initPromise = mgr.initBackend();

		// completeBackendConnect should be ignored since connecting is true
		const completeSpy = vi.spyOn(fakeProvider.auth, "completeAuth");
		await mgr.completeBackendConnect("auth-code");

		expect(completeSpy).not.toHaveBeenCalled();

		resolve();
		await initPromise;
	});

	it("initBackend is ignored when completeBackendConnect is in progress", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();
		(deps.onConnected as ReturnType<typeof vi.fn>).mockClear();

		let resolve!: () => void;
		const blocker = new Promise<void>((r) => {
			resolve = r;
		});

		fakeProvider.auth.completeAuth = async () => {
			await blocker;
			return {};
		};

		const completePromise = mgr.completeBackendConnect("auth-code");

		// initBackend should be ignored since connecting is true
		await mgr.initBackend();
		expect(deps.onConnected).not.toHaveBeenCalled();

		resolve();
		await completePromise;
	});
});
