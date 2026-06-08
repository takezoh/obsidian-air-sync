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
let fakeResetCheckpoint: ReturnType<typeof vi.fn>;

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
	fakeResetCheckpoint = vi.fn().mockResolvedValue(undefined);
	fakeFs = {
		name: "test-remote",
		list: vi.fn().mockResolvedValue([]),
		stat: vi.fn().mockResolvedValue(null),
		read: vi.fn(),
		write: vi.fn(),
		mkdir: vi.fn(),
		delete: vi.fn(),
		rename: vi.fn(),
		// A full checkpoint capability (all-or-nothing). BackendManager only calls
		// resetCheckpoint; the other three are present so the object is a faithful
		// IncrementalCheckpoint, and getChangedPaths matches createMockFs's empty-delta
		// default (not null) so the two mocks model the capability the same way.
		checkpoint: {
			getChangedPaths: vi.fn().mockResolvedValue({ modified: [], deleted: [] }),
			resetCheckpoint: fakeResetCheckpoint,
			hasCheckpoint: vi.fn().mockResolvedValue(false),
			commitCheckpoint: vi.fn().mockResolvedValue(undefined),
		},
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
		disconnect: vi.fn().mockResolvedValue({}),
		clearPluginSecrets: vi.fn(),
		// A full folder-pick capability (all-or-nothing — see WebFolderPicker). The
		// "no folder picker" case deletes it; the rest override one half.
		picker: {
			startWebFolderPick: vi.fn().mockResolvedValue({}),
			completeWebFolderPick: vi.fn().mockResolvedValue({ backendUpdates: {} }),
		},
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
		// The per-target checkpoint store (cursor + cache) is cleared via the live FS,
		// so no stale checkpoint survives the disconnect (works for custom OAuth too).
		expect(fakeResetCheckpoint).toHaveBeenCalledTimes(1);

		// After disconnect, re-init should not trigger another callback
		// (lastBackendIdentity was reset to null)
		(deps.onIdentityChanged as ReturnType<typeof vi.fn>).mockClear();
		await mgr.initBackend();
		expect(deps.onIdentityChanged).not.toHaveBeenCalled();
	});

	it("clears the orphaned checkpoint store on disconnect when there is no live FS", async () => {
		// An expired/error-state backend has remoteVaultFolderId bound but no live FS.
		// Disconnect must still clear the per-target store (by settings key) so a stale
		// checkpoint can't survive and mislead a later reconnect to the same folder.
		fakeProvider.isConnected = () => false; // initBackend won't build an FS
		fakeProvider.createFs = () => null;
		const clearCheckpointStore = vi.fn().mockResolvedValue(undefined);
		fakeProvider.clearCheckpointStore = clearCheckpointStore;

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend(); // remoteFs stays null (isConnected === false)
		await mgr.disconnectBackend();

		// No live FS → the by-key store clear runs instead of the FS reset.
		expect(clearCheckpointStore).toHaveBeenCalledTimes(1);
		expect(fakeResetCheckpoint).not.toHaveBeenCalled();
	});

	it("resets the new target's checkpoint on identity change", async () => {
		// The cursor lives with the cache in the per-target store now (ADR 0001), so an
		// identity change drops it via the freshly-built FS's resetCheckpoint(), forcing
		// the next sync to cold-reconcile against the (just-cleared) baseline.
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend(); // identity = "test:folder-A" (first init, no reset)
		expect(fakeResetCheckpoint).not.toHaveBeenCalled();

		fakeProvider.getIdentity = () => "test:folder-B";
		await mgr.initBackend();

		expect(fakeResetCheckpoint).toHaveBeenCalledTimes(1);
	});

	it("clears stale baselines on the first init after a cross-reload backend switch", async () => {
		// A fresh manager == a plugin reload: the in-memory identity is gone, but the
		// identity the state was last reconciled against survives in settings. So a
		// custom→built-in switch must still be detected on this first init — otherwise
		// the new target silently reuses the old backend's baselines (nothing uploads).
		fakeProvider.getIdentity = () => "test:folder-NEW";
		const settings = mockSettings({ lastSyncedIdentity: "other:folder-OLD" });
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend(); // first init of this instance

		expect(deps.onIdentityChanged).toHaveBeenCalledTimes(1);
		expect(fakeResetCheckpoint).toHaveBeenCalledTimes(1);
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
		fakeProvider.createFs = () => {
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
		fakeProvider.createFs = () => {
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

	it("clears the old target's checkpoint store on a backend switch", async () => {
		// User requirement: switching backends drops the per-target store (cursor +
		// cache) alongside settings and secrets, so no orphaned checkpoint lingers.
		const settings = mockSettings({ backendData: { remoteVaultFolderId: "FID" } });
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);
		await mgr.initBackend(); // live FS present (fakeProvider.isConnected → true)

		await mgr.switchBackend("other");

		// Cleared via the live (old-backend) FS before backendData is wiped.
		expect(fakeResetCheckpoint).toHaveBeenCalledTimes(1);
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
		fakeProvider.isConnected = () => false;
		let connectingDuringReset = false;
		let release!: () => void;
		let reached!: () => void;
		const blocker = new Promise<void>((r) => { release = r; });
		// Resolves when switchBackend reaches the reset — robust to microtask timing.
		const atReset = new Promise<void>((r) => { reached = r; });
		const onIdentityChanged = vi.fn().mockImplementation(async () => {
			connectingDuringReset = mgr.isConnecting();
			reached();
			await blocker;
		});
		const settings = mockSettings();
		const deps = createDeps(settings, { onIdentityChanged });
		const mgr = new BackendManager(deps);
		await mgr.initBackend();

		const done = mgr.switchBackend("other");
		await atReset;
		expect(connectingDuringReset).toBe(true); // sync gated out during the reset
		release();
		await done;
		expect(mgr.isConnecting()).toBe(false);
	});
});

describe("BackendManager — isConnected false with prior connection", () => {
	it("notifies when isConnected is false but a target is bound (identity present)", async () => {
		fakeProvider.isConnected = () => false;
		// A bound target ⇒ the provider reports a non-null identity — the
		// backend-agnostic equivalent of "a remote folder is set". The disconnect
		// notice is gated on this identity, not on any one backend's settings field.
		fakeProvider.getIdentity = () => "test:folder-123";

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

	it("does not notify when isConnected is false and no target is bound (no identity)", async () => {
		fakeProvider.isConnected = () => false;
		// No target bound ⇒ the provider reports a null identity, so a
		// never-configured backend never nags about expired auth.
		fakeProvider.getIdentity = () => null;

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).not.toHaveBeenCalled();
		expect(deps.onDisconnected).toHaveBeenCalled();
	});
});

describe("BackendManager — web folder pick", () => {
	it("startBackendFolderPick persists the provider's returned state", async () => {
		const settings = mockSettings();
		const startSpy = vi.fn().mockResolvedValue({ pendingFolderPickState: "S" });
		fakeProvider.picker!.startWebFolderPick = startSpy;
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);
		await mgr.initBackend();

		await mgr.startBackendFolderPick();

		expect(startSpy).toHaveBeenCalled();
		expect(settings.backendData).toMatchObject({ pendingFolderPickState: "S" });
	});

	it("notifies when the backend has no folder picker", async () => {
		const settings = mockSettings();
		delete fakeProvider.picker;
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);
		await mgr.initBackend();

		await mgr.startBackendFolderPick();

		expect(deps.notify).toHaveBeenCalledWith("This backend has no folder picker.");
	});

	it("completeBackendFolderPick binds the result, drops the checkpoint (→ cold sync), and re-inits", async () => {
		const settings = mockSettings();
		// Identity derives from the bound folder, so changing it is detected on re-init.
		fakeProvider.getIdentity = () => {
			const id = settings.backendData.remoteVaultFolderId as string | undefined;
			return id ? `test:${id}` : "test:folder-A";
		};
		const completeSpy = vi.fn().mockResolvedValue({
			backendUpdates: { remoteVaultFolderId: "id:new", pendingFolderPickState: "" },
		});
		fakeProvider.picker!.completeWebFolderPick = completeSpy;
		const deps = createDeps(settings);
		const onConnected = deps.onConnected as ReturnType<typeof vi.fn>;
		const refreshSettingsDisplay = deps.refreshSettingsDisplay as ReturnType<typeof vi.fn>;
		const saveSettings = deps.saveSettings as ReturnType<typeof vi.fn>;
		const mgr = new BackendManager(deps);
		await mgr.initBackend();
		onConnected.mockClear();
		fakeResetCheckpoint.mockClear();

		await mgr.completeBackendFolderPick({ id: "id:new", state: "S" });

		expect(completeSpy).toHaveBeenCalledWith(
			{ id: "id:new", state: "S" }, settings, expect.anything(),
		);
		expect(settings.backendData).toMatchObject({ remoteVaultFolderId: "id:new" });
		// Changing folders is an identity change → re-init drops the prior checkpoint via
		// the FS (cursor lives with the cache now), so the next sync runs cold.
		expect(fakeResetCheckpoint).toHaveBeenCalledTimes(1);
		expect(saveSettings).toHaveBeenCalled();
		expect(onConnected).toHaveBeenCalled(); // re-init created a fresh FS
		expect(refreshSettingsDisplay).toHaveBeenCalled();
	});

	it("completeBackendFolderPick holds the connecting flag across the bind", async () => {
		const settings = mockSettings();
		let connectingDuringBind = false;
		let release!: () => void;
		const blocker = new Promise<void>((r) => { release = r; });
		const mgr = new BackendManager(createDeps(settings));
		await mgr.initBackend();
		fakeProvider.picker!.completeWebFolderPick = vi.fn().mockImplementation(async () => {
			connectingDuringBind = mgr.isConnecting();
			await blocker;
			return { backendUpdates: { remoteVaultFolderId: "id:new", pendingFolderPickState: "" } };
		});

		const done = mgr.completeBackendFolderPick({ id: "id:new", state: "S" });
		await Promise.resolve();
		expect(connectingDuringBind).toBe(true); // sync is gated out during the bind
		release();
		await done;
		expect(mgr.isConnecting()).toBe(false);
	});

	it("completeBackendFolderPick notifies and drops the pick when a connect/rebind is in flight", async () => {
		const settings = mockSettings();
		let release!: () => void;
		const blocker = new Promise<void>((r) => { release = r; });
		const completeSpy = vi.fn();
		fakeProvider.picker!.completeWebFolderPick = completeSpy;
		const deps = createDeps(settings);
		// Hold initBackend mid-flight on its first-time saveSettings so `connecting`
		// stays true while we fire the folder pick.
		vi.mocked(deps.saveSettings).mockImplementation(async () => { await blocker; });
		const mgr = new BackendManager(deps);
		const initPromise = mgr.initBackend(); // connecting = true while saveSettings blocks

		await mgr.completeBackendFolderPick({ id: "id:new", state: "S" });

		expect(deps.notify).toHaveBeenCalledWith("Busy connecting — reopen the folder picker in a moment.");
		expect(completeSpy).not.toHaveBeenCalled();
		release();
		await initPromise;
	});

	it("completeBackendFolderPick notifies and does not re-init on a rejected selection", async () => {
		const settings = mockSettings();
		fakeProvider.picker!.completeWebFolderPick = vi.fn().mockRejectedValue(new Error("inaccessible folder"));
		const deps = createDeps(settings);
		const notify = deps.notify as ReturnType<typeof vi.fn>;
		const onConnected = deps.onConnected as ReturnType<typeof vi.fn>;
		const mgr = new BackendManager(deps);
		await mgr.initBackend();
		onConnected.mockClear();

		await mgr.completeBackendFolderPick({ id: "id:bad", state: "S" });

		expect(notify).toHaveBeenCalledWith("Folder selection failed: inaccessible folder");
		expect(onConnected).not.toHaveBeenCalled();
	});
});

describe("BackendManager — bind default remote vault", () => {
	it("resolves the default folder, drops the checkpoint (→ cold sync), and re-inits", async () => {
		const settings = mockSettings();
		fakeProvider.getIdentity = () => {
			const id = settings.backendData.remoteVaultFolderId as string | undefined;
			return id ? `test:${id}` : "test:folder-A";
		};
		const resolveSpy = vi.fn().mockResolvedValue({
			backendUpdates: { remoteVaultFolderId: "id:default" },
		});
		fakeProvider.resolveRemoteVault = resolveSpy;
		const deps = createDeps(settings);
		const onConnected = deps.onConnected as ReturnType<typeof vi.fn>;
		const mgr = new BackendManager(deps);
		await mgr.initBackend();
		onConnected.mockClear();
		fakeResetCheckpoint.mockClear();

		await mgr.bindDefaultRemoteVault();

		expect(resolveSpy).toHaveBeenCalledWith(
			expect.anything(), settings, "Test Vault", expect.anything(),
		);
		expect(settings.backendData).toMatchObject({ remoteVaultFolderId: "id:default" });
		expect(fakeResetCheckpoint).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledWith("Remote folder updated");
		expect(onConnected).toHaveBeenCalled(); // re-init created a fresh FS
		expect(deps.refreshSettingsDisplay).toHaveBeenCalled();
	});

	it("notifies and does not re-init on a failed resolve", async () => {
		const settings = mockSettings();
		fakeProvider.resolveRemoteVault = vi.fn().mockRejectedValue(new Error("drive down"));
		const deps = createDeps(settings);
		const onConnected = deps.onConnected as ReturnType<typeof vi.fn>;
		const mgr = new BackendManager(deps);
		await mgr.initBackend();
		onConnected.mockClear();

		await mgr.bindDefaultRemoteVault();

		expect(deps.notify).toHaveBeenCalledWith("Folder selection failed: drive down");
		expect(onConnected).not.toHaveBeenCalled();
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

		// saveSettings is awaited during initBackend (first-time identity persist), so it
		// observes the connecting flag mid-flight.
		vi.mocked(deps.saveSettings).mockImplementation(async () => {
			connectingDuringInit = mgr.isConnecting();
			await blocker;
		});

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
		fakeProvider.createFs = () => {
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

		vi.mocked(deps.saveSettings).mockImplementation(async () => {
			await blocker;
		});

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

		// Hold initBackend mid-flight on its first-time saveSettings so `connecting`
		// stays true while completeBackendConnect is attempted.
		vi.mocked(deps.saveSettings).mockImplementation(async () => { await blocker; });

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
