import { describe, it, expect, vi } from "vitest";
import "fake-indexeddb/auto";
import { SyncOrchestrator } from "./orchestrator";
import type { SyncOrchestratorDeps } from "./orchestrator";
import { LocalChangeTracker } from "./local-tracker";
import {
	createMockFs,
	addFile,
	mockSettings as baseMockSettings,
} from "../__mocks__/sync-test-helpers";
import type { AirSyncSettings } from "../settings";
import { AuthError } from "../fs/errors";

// Make retry backoff instant: the retry tests assert behaviour (retry count,
// status), not wall-clock timing, and real exponential backoff + jitter added
// ~4s to the suite. `sleep` is the only export stubbed; the retry policy
// (decideRetry) and the error classifier (fs/errors classifyHttpError) stay real.
// Mocking sleep — rather than fake timers — avoids interfering with
// fake-indexeddb's async scheduling.
vi.mock("./error", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./error")>();
	return { ...actual, sleep: () => Promise.resolve() };
});

// A vault's configDir is user-configurable, so tests use a value distinct from
// the (arbitrary) Obsidian default to prove the logic doesn't hardcode it. It's
// dot-prefixed like every real configDir, since that's what puts it under the
// syncDotPaths scope gate in the first place.
const TEST_CONFIG_DIR = ".cfg";
// Distinct from the real manifest id ("air-sync") to prove the exclusion logic
// derives it from deps rather than hardcoding it.
const TEST_PLUGIN_ID = "test-plugin";

function mockSettings(): AirSyncSettings {
	// Unique vaultId per call keeps each orchestrator's fake-indexeddb store isolated.
	return baseMockSettings({
		backendType: "none",
		vaultId: `test-${Math.random()}`,
	});
}

function createDeps(
	overrides: Partial<SyncOrchestratorDeps> = {},
): SyncOrchestratorDeps {
	const localFs = createMockFs("local");
	const remoteFs = createMockFs("remote");
	return {
		getSettings: () => mockSettings(),
		saveSettings: vi.fn().mockResolvedValue(undefined),
		configDir: () => TEST_CONFIG_DIR,
		pluginId: () => TEST_PLUGIN_ID,
		localFs: () => localFs,
		remoteFs: () => remoteFs,
		backendProvider: () => null,
		onStatusChange: vi.fn(),
		onProgress: vi.fn(),
		notify: vi.fn(),
		isMobile: () => false,
		localTracker: new LocalChangeTracker(),
		...overrides,
	};
}

/** Minimal IBackendProvider double exposing only what the orchestrator uses. */
function mockProvider(
	over: Partial<import("../fs/backend").IBackendProvider> & { type?: string },
): import("../fs/backend").IBackendProvider {
	return {
		type: "test",
		...over,
	} as unknown as import("../fs/backend").IBackendProvider;
}

describe("SyncOrchestrator", () => {
	describe("isSyncing()", () => {
		it("returns false when not syncing", async () => {
			const deps = createDeps();
			const orchestrator = new SyncOrchestrator(deps);
			expect(orchestrator.isSyncing()).toBe(false);
			await orchestrator.close();
		});

		it("returns true while sync is running", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			let resolveSync!: () => void;
			const syncStarted = new Promise<void>((res) => {
				resolveSync = res;
			});

			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			// Intercept list to block sync and capture isSyncing state
			let isSyncingDuringSync = false;
			const orchestrator = new SyncOrchestrator(deps);
			vi.spyOn(localFs, "list").mockImplementationOnce(() => {
				isSyncingDuringSync = orchestrator.isSyncing();
				resolveSync();
				return Promise.resolve([]);
			});

			const syncPromise = orchestrator.runSync();
			await syncStarted;
			expect(isSyncingDuringSync).toBe(true);
			await syncPromise;
			await orchestrator.close();
		});
	});

	describe("runSync()", () => {
		it("does not notify when remoteFs is not available", async () => {
			const debugFn = vi.fn();
			const deps = createDeps({
				remoteFs: () => null,
				logger: {
					debug: debugFn,
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
				} as unknown as import("../logging/logger").Logger,
			});
			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();
			expect(deps.notify).not.toHaveBeenCalled();
			expect(deps.onStatusChange).toHaveBeenCalledWith("not_connected");
			expect(debugFn).toHaveBeenCalledWith(
				"runSync: skipped — no remote backend",
			);
			await orchestrator.close();
		});

		it("does not show sync completion notice when logging is disabled", async () => {
			const deps = createDeps();
			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();
			expect(deps.notify).not.toHaveBeenCalled();
			expect(deps.onStatusChange).toHaveBeenCalledWith("idle");
			await orchestrator.close();
		});

		it("shows sync completion notice when logging is enabled", async () => {
			const settings = { ...mockSettings(), showSyncNotifications: true };
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();
			expect(deps.notify).toHaveBeenCalledWith("Everything up to date");
			expect(deps.onStatusChange).toHaveBeenCalledWith("idle");
			await orchestrator.close();
		});

		it("queues a pending sync when called while locked", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			let callCount = 0;
			let unblockFirst!: () => void;
			const blocker = new Promise<void>((res) => {
				unblockFirst = res;
			});

			vi.spyOn(localFs, "list").mockImplementation(async () => {
				callCount++;
				if (callCount === 1) await blocker;
				return [];
			});

			const orchestrator = new SyncOrchestrator(deps);
			const first = orchestrator.runSync();
			// Give the first sync time to enter the mutex and start
			await new Promise((res) => setTimeout(res, 10));
			const second = orchestrator.runSync(); // should set syncPending since mutex is held
			unblockFirst();
			await first;
			await second;
			expect(callCount).toBeGreaterThanOrEqual(2);
			await orchestrator.close();
		});

		it("notifies once for a coalesced burst (no duplicate up-to-date notice)", async () => {
			// A second trigger arriving mid-sync (e.g. mobile resume firing both
			// focus and visibilitychange) sets syncPending and runs another cycle.
			// The burst must emit a single notice, not one per cycle.
			const settings = { ...mockSettings(), showSyncNotifications: true };
			const deps = createDeps({ getSettings: () => settings });
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			let callCount = 0;
			let unblockFirst!: () => void;
			const blocker = new Promise<void>((res) => {
				unblockFirst = res;
			});
			vi.spyOn(localFs, "list").mockImplementation(async () => {
				callCount++;
				if (callCount === 1) await blocker;
				return [];
			});

			const orchestrator = new SyncOrchestrator(deps);
			const first = orchestrator.runSync();
			await new Promise((res) => setTimeout(res, 10));
			const second = orchestrator.runSync(); // sets syncPending while locked
			unblockFirst();
			await first;
			await second;

			expect(callCount).toBeGreaterThanOrEqual(2);
			expect(deps.notify).toHaveBeenCalledTimes(1);
			expect(deps.notify).toHaveBeenCalledWith("Everything up to date");
			await orchestrator.close();
		});

		it("sets status to error and notifies on AuthError", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			const authErr = new AuthError("Unauthorized", 401);
			vi.spyOn(localFs, "list").mockRejectedValue(authErr);

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			expect(deps.onStatusChange).toHaveBeenCalledWith("error");
			expect(deps.notify).toHaveBeenCalledWith(
				"Authentication error. Please reconnect in settings.",
			);
			await orchestrator.close();
		});

		it("retries on transient error and succeeds", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			let attempt = 0;
			vi.spyOn(localFs, "list").mockImplementation(async () => {
				attempt++;
				if (attempt === 1) throw new Error("transient");
				return await Promise.resolve([]);
			});

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			expect(attempt).toBe(2);
			expect(deps.onStatusChange).toHaveBeenCalledWith("idle");
			await orchestrator.close();
		});

		it("fails after MAX_RETRIES and sets error status", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			vi.spyOn(localFs, "list").mockRejectedValue(
				new Error("network down"),
			);

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			expect(deps.onStatusChange).toHaveBeenCalledWith("error");
			expect(deps.notify).toHaveBeenCalledWith(
				expect.stringContaining("Sync error:"),
			);
			await orchestrator.close();
		});

		it("excludes files matching ignore patterns", async () => {
			const settings = mockSettings();
			settings.ignorePatterns = ["*.tmp"];
			const deps = createDeps({ getSettings: () => settings });
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			addFile(localFs, "file.tmp", "ignored");
			addFile(localFs, "file.md", "included");

			let filteredCount = 0;
			const origList = localFs.list.bind(localFs);
			vi.spyOn(localFs, "list").mockImplementation(async () => {
				const result = await origList();
				filteredCount = result.filter((f) => !f.isDirectory).length;
				return result;
			});

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			expect(filteredCount).toBe(2); // both files listed
			// but file.tmp would be excluded from sync — check notify shows only md synced
			expect(deps.onStatusChange).toHaveBeenCalledWith("idle");
			await orchestrator.close();
		});

		it("does not pull a remote-only hidden path outside syncDotPaths", async () => {
			const settings = mockSettings();
			settings.syncDotPaths = [];
			const deps = createDeps({ getSettings: () => settings });
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			// A hidden path present only on the remote (e.g. another device's logs).
			addFile(remoteFs, ".airsync/logs/d/x.log", "log");

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			// Out of scope → never pulled locally, and not deleted from the remote.
			expect(localFs.files.has(".airsync/logs/d/x.log")).toBe(false);
			expect(remoteFs.files.has(".airsync/logs/d/x.log")).toBe(true);
			expect(deps.onStatusChange).toHaveBeenCalledWith("idle");
			await orchestrator.close();
		});

		it("skips when backend is connecting", async () => {
			const deps = createDeps({ isBackendConnecting: () => true });
			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();
			expect(deps.notify).not.toHaveBeenCalled();
			expect(deps.onStatusChange).not.toHaveBeenCalled();
			await orchestrator.close();
		});

		it("runs normally when backend is not connecting", async () => {
			const settings = mockSettings();
			settings.showSyncNotifications = true;
			const deps = createDeps({
				isBackendConnecting: () => false,
				getSettings: () => settings,
			});
			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();
			expect(deps.notify).toHaveBeenCalledWith("Everything up to date");
			await orchestrator.close();
		});

		it("optimizes rename pair into rename_remote action", async () => {
			const settings = { ...mockSettings(), showSyncNotifications: true };
			const deps = createDeps({ getSettings: () => settings });
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			// Add files with matching hash so optimizer can verify content unchanged
			const localEntity = addFile(localFs, "new.md", "content", 1000);
			localEntity.hash = "h1";
			const remoteEntity = addFile(remoteFs, "old.md", "content", 1000);
			remoteEntity.hash = "h1";

			// Set up tracker with rename pair (do NOT initialize — cold mode
			// lists all files so the "local deleted" entry survives filtering)
			deps.localTracker.markRenamed("new.md", "old.md");

			const orchestrator = new SyncOrchestrator(deps);
			// Seed baseline for old.md so change detector sees it as previously synced
			await orchestrator.state.put({
				path: "old.md",
				hash: "h1",
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: 7,
				remoteSize: 7,
				syncedAt: 900,
			});

			const renameSpy = vi.spyOn(remoteFs, "rename");
			await orchestrator.runSync();

			expect(renameSpy).toHaveBeenCalledWith("old.md", "new.md");
			expect(deps.notify).toHaveBeenCalledWith(
				expect.stringContaining("renamed"),
			);
			await orchestrator.close();
		});

		it("acknowledges dirty paths after sync", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			// Initialize the tracker (it is empty here, so nothing is cleared), THEN
			// dirty file.md — so file.md is genuinely dirty going into runSync and the
			// post-sync assertion proves runSync's end-of-cycle acknowledge cleared it
			// (not the setup). Ordering matters: marking before initializing would let
			// the initialize snapshot clear file.md, making the assertion vacuous.
			deps.localTracker.acknowledge(deps.localTracker.snapshot()); // initialize tracker
			deps.localTracker.markDirty("file.md");

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			expect(deps.localTracker.getDirtyPaths().size).toBe(0);
			await orchestrator.close();
		});

		it("a markDirty arriving mid-cycle survives the cycle's acknowledge", async () => {
			// A fresh tracker + empty store runs a COLD cycle, which lists the vault.
			// Fire a markDirty from inside that list() — i.e. AFTER the cycle captured
			// its snapshot — to simulate the user editing while a sync is in flight.
			// The cycle must not sweep this path: it was never part of this cycle, so
			// it must stay dirty (keeping it on the HOT path for the next cycle).
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			let fired = false;
			vi.spyOn(localFs, "list").mockImplementation(() => {
				if (!fired) {
					fired = true;
					deps.localTracker.markDirty("mid-cycle.md");
				}
				return Promise.resolve([]);
			});

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			// RED on the old acknowledge(getDirtyPaths()) (swept); GREEN once the
			// cycle acknowledges only its start-of-cycle snapshot.
			expect(deps.localTracker.getDirtyPaths().has("mid-cycle.md")).toBe(true);
			await orchestrator.close();
		});
	});

	describe("adaptive transfer concurrency (wiring)", () => {
		const rateLimit = () => Object.assign(new Error("rate limited"), { status: 429 });

		it("retries a rate-limited transfer in-cycle, so the cycle completes clean", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			addFile(localFs, "a.md", "content"); // local-only ⇒ push

			const origWrite = remoteFs.write.bind(remoteFs);
			let attempts = 0;
			const writeSpy = vi.spyOn(remoteFs, "write").mockImplementation((p, c, m) =>
				++attempts === 1 ? Promise.reject(rateLimit()) : origWrite(p, c, m));

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			// classifyError (provider-less ⇒ classifyHttpError: 429 ⇒ rateLimit) + per-action
			// retry are wired end-to-end ⇒ the push retries once and the cycle is clean.
			expect(writeSpy).toHaveBeenCalledTimes(2);
			expect(deps.onStatusChange).toHaveBeenCalledWith("idle");
			expect(deps.onStatusChange).not.toHaveBeenCalledWith("partial_error");
			await orchestrator.close();
		});

		it("a persistent rate-limit fails the file in ONE cycle (no cycle-level retry storm)", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			addFile(localFs, "a.md", "content");

			const writeSpy = vi.spyOn(remoteFs, "write").mockRejectedValue(rateLimit());
			let listCalls = 0;
			const origList = localFs.list.bind(localFs);
			vi.spyOn(localFs, "list").mockImplementation(() => { listCalls++; return origList(); });

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			// Per-action: up to MAX_ACTION_RETRIES attempts then result.failed (a return, not a
			// throw) ⇒ executeWithRetry does NOT re-run the cycle. One cold scan, one list.
			expect(writeSpy).toHaveBeenCalledTimes(3);
			expect(listCalls).toBe(1);
			expect(deps.onStatusChange).toHaveBeenCalledWith("partial_error");
			await orchestrator.close();
		});
	});

	describe("pullSingle()", () => {
		it("pulls a remote file and saves sync record", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			addFile(remoteFs, "note.md", "remote content", 2000);

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.pullSingle("note.md");

			expect(localFs.files.has("note.md")).toBe(true);
			const record = await orchestrator.state.get("note.md");
			expect(record).toBeDefined();
			expect(record?.path).toBe("note.md");
			await orchestrator.close();
		});

		it("acknowledges path after pull", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			addFile(remoteFs, "note.md", "content", 2000);
			deps.localTracker.markDirty("note.md");

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.pullSingle("note.md");

			expect(deps.localTracker.getDirtyPaths().has("note.md")).toBe(
				false,
			);
			await orchestrator.close();
		});

		it("logs error but does not throw on pull failure", async () => {
			const errorSpy = vi.fn();
			const deps = createDeps({
				logger: {
					debug: vi.fn(),
					info: vi.fn(),
					warn: vi.fn(),
					error: errorSpy,
					flush: vi.fn().mockResolvedValue(undefined),
				} as unknown as SyncOrchestratorDeps["logger"],
			});
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			vi.spyOn(remoteFs, "stat").mockResolvedValue({
				path: "note.md",
				isDirectory: false,
				size: 10,
				mtime: 1000,
				hash: "",
			});
			vi.spyOn(remoteFs, "read").mockRejectedValue(
				new Error("network error"),
			);

			const orchestrator = new SyncOrchestrator(deps);
			await expect(
				orchestrator.pullSingle("note.md"),
			).resolves.toBeUndefined();
			expect(errorSpy).toHaveBeenCalledWith(
				"pullSingle: failed",
				expect.objectContaining({ path: "note.md" }),
			);
			await orchestrator.close();
		});

		it("skips when remote file is not found", async () => {
			const warnSpy = vi.fn();
			const deps = createDeps({
				logger: {
					debug: vi.fn(),
					info: vi.fn(),
					warn: warnSpy,
					error: vi.fn(),
					flush: vi.fn().mockResolvedValue(undefined),
				} as unknown as SyncOrchestratorDeps["logger"],
			});
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			// remote file does not exist

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.pullSingle("missing.md");

			expect(localFs.files.has("missing.md")).toBe(false);
			expect(warnSpy).toHaveBeenCalled();
			await orchestrator.close();
		});

		it("runs pullSingle within mutex (exclusive with runSync)", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			addFile(remoteFs, "note.md", "content", 2000);

			const orchestrator = new SyncOrchestrator(deps);

			// Start runSync first, then immediately call pullSingle
			// pullSingle should wait because mutex is held
			let syncStarted = false;
			vi.spyOn(localFs, "list").mockImplementation(() => {
				syncStarted = true;
				return Promise.resolve([]);
			});

			const syncPromise = orchestrator.runSync();
			const pullPromise = orchestrator.pullSingle("note.md");

			await Promise.all([syncPromise, pullPromise]);

			expect(syncStarted).toBe(true);
			await orchestrator.close();
		});
	});

	describe("shouldSync()", () => {
		it("returns true when remote is available and not locked or connecting", () => {
			const deps = createDeps();
			const orchestrator = new SyncOrchestrator(deps);
			expect(orchestrator.shouldSync()).toBe(true);
		});

		it("returns false when remote is null", () => {
			const deps = createDeps({ remoteFs: () => null });
			const orchestrator = new SyncOrchestrator(deps);
			expect(orchestrator.shouldSync()).toBe(false);
		});

		it("returns false when backend is connecting", () => {
			const deps = createDeps({ isBackendConnecting: () => true });
			const orchestrator = new SyncOrchestrator(deps);
			expect(orchestrator.shouldSync()).toBe(false);
		});

		it("returns true when backend is not connecting", () => {
			const deps = createDeps({ isBackendConnecting: () => false });
			const orchestrator = new SyncOrchestrator(deps);
			expect(orchestrator.shouldSync()).toBe(true);
		});
	});

	describe("isExcluded()", () => {
		it("returns true for ignored paths", () => {
			const settings = mockSettings();
			settings.ignorePatterns = [".config/**"];
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);

			expect(orchestrator.isExcluded(".config/settings")).toBe(true);
			expect(orchestrator.isExcluded("notes/hello.md")).toBe(false);
		});

		it("always excludes OS-junk files on every backend, regardless of ignore/dot settings", () => {
			const settings = mockSettings();
			settings.ignorePatterns = [];
			settings.syncDotPaths = [".DS_Store", "Anime"]; // even opted-in dot scope can't bring junk back
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);

			expect(orchestrator.isExcluded("Anime/desktop.ini")).toBe(true);
			expect(orchestrator.isExcluded("a/Thumbs.db")).toBe(true);
			expect(orchestrator.isExcluded(".DS_Store")).toBe(true);
			expect(orchestrator.isExcluded("notes/hello.md")).toBe(false);
		});

		it("excludes hidden paths not opted into syncDotPaths (scope gate)", () => {
			const settings = mockSettings();
			settings.syncDotPaths = [];
			settings.ignorePatterns = [];
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);

			expect(orchestrator.isExcluded(".airsync/logs/x.log")).toBe(true);
			expect(orchestrator.isExcluded("notes/hello.md")).toBe(false);
		});

		it("includes a hidden path once opted into syncDotPaths", () => {
			const settings = mockSettings();
			settings.syncDotPaths = [".airsync"];
			settings.ignorePatterns = [];
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);

			expect(orchestrator.isExcluded(".airsync/logs/x.log")).toBe(false);
		});

		it("requires passing BOTH gates: opted-in dot path still excluded if ignored", () => {
			const settings = mockSettings();
			settings.syncDotPaths = [".airsync"];
			settings.ignorePatterns = ["**/*.log"];
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);

			expect(orchestrator.isExcluded(".airsync/logs/x.log")).toBe(true);
		});

		it("always excludes the reserved backend metadata path, even when .airsync is opted in", () => {
			const settings = mockSettings();
			settings.syncDotPaths = [".airsync"]; // opted in — logs would sync
			settings.ignorePatterns = [];
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);

			// Reserved: never synced from either side (prevents the push→delete_local
			// data-loss path, since the remote FS hides this file).
			expect(orchestrator.isExcluded(".airsync/metadata.json")).toBe(true);
			// Sibling content under the same opted-in root still syncs.
			expect(orchestrator.isExcluded(".airsync/logs/x.log")).toBe(false);
		});

		it("always excludes OS-junk files on every backend, regardless of ignore/syncDotPaths", () => {
			const settings = mockSettings();
			settings.syncDotPaths = []; // .DS_Store excluded even though dot paths are off-scope
			settings.ignorePatterns = []; // no user pattern needed — junk is always excluded
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);

			expect(orchestrator.isExcluded("desktop.ini")).toBe(true);
			expect(orchestrator.isExcluded("Anime/Thumbs.db")).toBe(true);
			expect(orchestrator.isExcluded("notes/.DS_Store")).toBe(true);
			// Real content is unaffected.
			expect(orchestrator.isExcluded("notes/hello.md")).toBe(false);
		});

		it("does not sync the config directory by default (enableConfigSync off)", () => {
			const settings = mockSettings();
			settings.enableConfigSync = false;
			settings.syncDotPaths = [];
			settings.ignorePatterns = [];
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);

			expect(orchestrator.isExcluded(`${TEST_CONFIG_DIR}/app.json`)).toBe(true);
		});

		it("syncs allowed config-dir paths and excludes this plugin's own data.json when enableConfigSync is on", () => {
			const settings = mockSettings();
			settings.enableConfigSync = true;
			settings.syncDotPaths = [];
			settings.ignorePatterns = [];
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);

			// Portable settings sync...
			expect(orchestrator.isExcluded(`${TEST_CONFIG_DIR}/app.json`)).toBe(false);
			expect(orchestrator.isExcluded(`${TEST_CONFIG_DIR}/plugins/some-other-plugin/data.json`)).toBe(false);
			// ...but device-specific layout and this plugin's own data.json don't.
			expect(orchestrator.isExcluded(`${TEST_CONFIG_DIR}/workspace.json`)).toBe(true);
			expect(orchestrator.isExcluded(`${TEST_CONFIG_DIR}/plugins/${TEST_PLUGIN_ID}/data.json`)).toBe(true);
		});

		it("never syncs this plugin's own data.json, even if the user's own ignorePatterns tries to un-ignore it", () => {
			const settings = mockSettings();
			settings.enableConfigSync = true;
			settings.syncDotPaths = [];
			// A broad negation a user might add to "sync everything" — without the
			// unconditional isOwnPluginDataPath check, gitignore's last-match-wins
			// semantics would let this override the built-in exclusion and leak
			// this device's backend credentials/vaultId to another device.
			settings.ignorePatterns = ["!**"];
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);

			expect(orchestrator.isExcluded(`${TEST_CONFIG_DIR}/plugins/${TEST_PLUGIN_ID}/data.json`)).toBe(true);
		});

		it("never syncs this plugin's own data.json even with enableConfigSync off, if the user manually opted the config dir into syncDotPaths", () => {
			// The pre-existing, still-fully-functional manual workflow (typing the
			// config dir into "Dot-prefixed paths to sync" without ever touching the
			// new toggle) must stay protected too — isOwnPluginDataPath is checked
			// unconditionally in isExcluded(), not gated on settings.enableConfigSync.
			const settings = mockSettings();
			settings.enableConfigSync = false;
			settings.syncDotPaths = [TEST_CONFIG_DIR];
			settings.ignorePatterns = ["!**"];
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);

			expect(orchestrator.isExcluded(`${TEST_CONFIG_DIR}/plugins/${TEST_PLUGIN_ID}/data.json`)).toBe(true);
		});
	});

	describe("getStatus()", () => {
		it("returns idle when not syncing", () => {
			const deps = createDeps();
			const orchestrator = new SyncOrchestrator(deps);
			expect(orchestrator.getStatus()).toBe("idle");
		});
	});

	describe("clearSyncState()", () => {
		it("clears the state store", async () => {
			const deps = createDeps();
			const orchestrator = new SyncOrchestrator(deps);

			// Put a record first via a sync
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			addFile(remoteFs, "a.md", "content", 1000);

			await orchestrator.runSync();
			await orchestrator.clearSyncState();

			const all = await orchestrator.state.getAll();
			expect(all).toHaveLength(0);
			await orchestrator.close();
		});
	});

	describe("layoutReady gate", () => {
		it("runSync is a no-op while the vault layout is not ready", async () => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			const listSpy = vi.spyOn(localFs, "list");
			const deps = createDeps({
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				isLayoutReady: () => false,
			});
			const orchestrator = new SyncOrchestrator(deps);

			await orchestrator.runSync();

			expect(listSpy).not.toHaveBeenCalled();
			expect(deps.onStatusChange).not.toHaveBeenCalledWith("syncing");
			await orchestrator.close();
		});

		it("runs once the layout becomes ready", async () => {
			let ready = false;
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			const deps = createDeps({
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				isLayoutReady: () => ready,
			});
			const orchestrator = new SyncOrchestrator(deps);

			await orchestrator.runSync();
			expect(deps.onStatusChange).not.toHaveBeenCalledWith("syncing");
			expect(deps.onStatusChange).not.toHaveBeenCalledWith("idle");

			ready = true;
			await orchestrator.runSync();
			expect(deps.onStatusChange).toHaveBeenCalledWith("idle");
			await orchestrator.close();
		});

		it("shouldSync is false until the layout is ready", () => {
			let ready = false;
			const deps = createDeps({ isLayoutReady: () => ready });
			const orchestrator = new SyncOrchestrator(deps);
			expect(orchestrator.shouldSync()).toBe(false);
			ready = true;
			expect(orchestrator.shouldSync()).toBe(true);
		});
	});

	describe("crash recovery via hasCheckpoint", () => {
		/**
		 * Reproduces the reported bug: a sync interrupted before pulling a remote
		 * file leaves the vault half-synced. On restart, baselines exist (so the
		 * default path is WARM) and the remote delta cursor has advanced past the
		 * un-pulled file (mock getChangedPaths reports nothing), so WARM is blind.
		 * `hasCheckpoint(settings) === false` (no committed cursor) must force a
		 * COLD full reconcile that rediscovers and pulls the orphan.
		 */
		it("hasCheckpoint=false forces a cold reconcile that pulls the un-synced file", async () => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			addFile(localFs, "synced.md", "kept", 1000);
			addFile(remoteFs, "synced.md", "kept", 1000);
			addFile(remoteFs, "orphan.md", "left behind", 1000);

			const settings = baseMockSettings({
				backendType: "test",
				vaultId: `test-${Math.random()}`,
			});
			// hasCheckpoint lives on the FS's checkpoint capability now (the cursor is
			// stored with the cache).
			remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(false);
			const deps = createDeps({
				getSettings: () => settings,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => mockProvider({}),
			});
			const orchestrator = new SyncOrchestrator(deps);

			// synced.md has a committed baseline; orphan.md has none.
			await orchestrator.state.put({
				path: "synced.md",
				hash: "",
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: 4,
				remoteSize: 4,
				syncedAt: 900,
			});

			await orchestrator.runSync();

			expect(localFs.files.has("orphan.md")).toBe(true);
			expect(await orchestrator.state.get("orphan.md")).toBeDefined();
			await orchestrator.close();
		});

		it("rescan() resets the checkpoint via the FS inside the sync cycle, then cold-reconciles", async () => {
			// The reset must run through the orchestrator's sync mutex (not be fired
			// straight at the live FS from outside) so it can't clear the cache mid-cycle
			// and corrupt an in-flight sync. After the reset, hasCheckpoint is false → cold.
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			addFile(localFs, "synced.md", "kept", 1000);
			addFile(remoteFs, "synced.md", "kept", 1000);
			addFile(remoteFs, "orphan.md", "left behind", 1000); // only a COLD reconcile finds this

			const settings = baseMockSettings({ backendType: "test", vaultId: `test-${Math.random()}` });
			// A checkpoint exists; rescan must discard it (via resetCheckpoint) to force cold.
			remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(true);
			const resetCheckpoint = vi.fn().mockImplementation(() => {
				remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(false); // reset ⇒ no checkpoint
				return Promise.resolve();
			});
			remoteFs.checkpoint!.resetCheckpoint = resetCheckpoint;

			const deps = createDeps({
				getSettings: () => settings,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => mockProvider({}),
			});
			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.state.put({
				path: "synced.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 4, remoteSize: 4, syncedAt: 900,
			});

			await orchestrator.rescan();

			expect(resetCheckpoint).toHaveBeenCalledTimes(1);
			// The forced cold reconcile rediscovered the orphan a warm/hot delta would miss.
			expect(localFs.files.has("orphan.md")).toBe(true);
			await orchestrator.close();
		});

		/**
		 * The cursor ("completed up to") must advance only when the whole pipeline
		 * succeeds. A cycle with a failed action must NOT advance the committed
		 * changesStartPageToken, so the next run still re-detects the un-pulled work.
		 */
		it("forces a cold reconcile on the cycle after a failure (in-memory cursor may have advanced past the committed one)", async () => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			addFile(localFs, "synced.md", "kept", 1000);
			addFile(localFs, "push.md", "body", 1000); // local-only → push, fails in cycle 1
			addFile(remoteFs, "synced.md", "kept", 1000);
			addFile(remoteFs, "orphan.md", "left behind", 1000); // remote-only → invisible to WARM

			const settings = baseMockSettings({
				backendType: "test",
				vaultId: `test-${Math.random()}`,
			});
			// A committed checkpoint exists, so hasCheckpoint stays true throughout —
			// the recovery must come from the post-failure cold flag, not from hasCheckpoint.
			remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(true);

			const deps = createDeps({
				getSettings: () => settings,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => mockProvider({}),
			});
			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.state.put({
				path: "synced.md",
				hash: "",
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: 4,
				remoteSize: 4,
				syncedAt: 900,
			});

			// Cycle 1: WARM (hasCheckpoint true). push.md's push fails → partial_error;
			// orphan.md is invisible to WARM (empty remote delta). The error is PERSISTENT so
			// the per-action in-cycle retry (withIoRetry) exhausts rather than self-healing a
			// one-shot transient — the failed cycle is what forces cycle 2 cold.
			vi.spyOn(remoteFs, "write").mockRejectedValue(new Error("network dropped"));
			await orchestrator.runSync();
			expect(localFs.files.has("orphan.md")).toBe(false);

			// Cycle 2 (same long-lived orchestrator): the prior failure must force a cold
			// reconcile that rediscovers orphan.md, even though hasCheckpoint is still true.
			await orchestrator.runSync();
			expect(localFs.files.has("orphan.md")).toBe(true);
			expect(await orchestrator.state.get("orphan.md")).toBeDefined();
			await orchestrator.close();
		});

		it("does not keep cold-scanning and re-pushing the same poison file after repeated identical failures", async () => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			addFile(localFs, "synced.md", "kept", 1000);
			addFile(localFs, "poison.zip", "large file", 1000);
			addFile(remoteFs, "synced.md", "kept", 1000);

			const settings = baseMockSettings({
				backendType: "test",
				vaultId: `test-${Math.random()}`,
				showSyncNotifications: true,
			});
			remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(true);

			const deps = createDeps({
				getSettings: () => settings,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => mockProvider({}),
			});
			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.state.put({
				path: "synced.md",
				hash: "",
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: 4,
				remoteSize: 4,
				syncedAt: 900,
			});

			const remoteListSpy = vi.spyOn(remoteFs, "list");
			let attempts = 0;
			const writeSpy = vi.spyOn(remoteFs, "write").mockImplementation(() => {
				attempts++;
				const headers = attempts === 1
					? "X-Goog-Upload-Status, X-Request-Id"
					: "X-Request-Id, X-Goog-Upload-Status";
				return Promise.reject(Object.assign(
					new Error(`Resumable upload: no upload URL in response (status 200; headers: ${headers})`),
					{
						permanent: true,
						permanentCode: "googledrive.resumable_upload.missing_location",
					},
				));
			});

			await orchestrator.runSync();
			await orchestrator.runSync();
			await orchestrator.runSync();

			expect(writeSpy).toHaveBeenCalledTimes(2);
			expect(remoteListSpy).toHaveBeenCalledTimes(1);
			expect(deps.onStatusChange).toHaveBeenCalledWith("partial_error");
			expect(deps.notify).toHaveBeenLastCalledWith("Sync: 1 blocked");
			await orchestrator.close();
		});

		it("does not quarantine uncoded permanent push failures", async () => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			addFile(localFs, "uncoded.md", "body", 1000);

			const settings = baseMockSettings({
				backendType: "test",
				vaultId: `test-${Math.random()}`,
			});
			remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(true);

			const deps = createDeps({
				getSettings: () => settings,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => mockProvider({}),
			});
			const orchestrator = new SyncOrchestrator(deps);
			const writeSpy = vi.spyOn(remoteFs, "write").mockRejectedValue(
				Object.assign(new Error("uncoded permanent failure"), { permanent: true })
			);

			await orchestrator.runSync();
			await orchestrator.runSync();
			await orchestrator.runSync();

			expect(writeSpy).toHaveBeenCalledTimes(3);
			expect(deps.onStatusChange).toHaveBeenCalledWith("partial_error");
			await orchestrator.close();
		});

		it.each([
			["transient", () => new Error("network dropped")],
			["rateLimit", () => Object.assign(new Error("rate limited"), { status: 429 })],
		])("does not quarantine repeated %s push failures", async (_kind, makeError) => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			addFile(localFs, "flaky.md", "body", 1000);

			const settings = baseMockSettings({
				backendType: "test",
				vaultId: `test-${Math.random()}`,
			});
			remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(true);

			const deps = createDeps({
				getSettings: () => settings,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => mockProvider({}),
			});
			const orchestrator = new SyncOrchestrator(deps);
			const originalWrite = remoteFs.write.bind(remoteFs);
			let attempts = 0;
			const writeSpy = vi.spyOn(remoteFs, "write").mockImplementation((path, content, mtime) => {
				attempts++;
				return attempts <= 6
					? Promise.reject(makeError())
					: originalWrite(path, content, mtime);
			});

			await orchestrator.runSync();
			await orchestrator.runSync();
			await orchestrator.runSync();

			expect(writeSpy).toHaveBeenCalledTimes(7);
			expect(remoteFs.files.has("flaky.md")).toBe(true);
			expect(deps.onStatusChange).toHaveBeenCalledWith("idle");
			await orchestrator.close();
		});

		it("does not quarantine persistent pull failures", async () => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			addFile(remoteFs, "remote.md", "body", 1000);

			const settings = baseMockSettings({
				backendType: "test",
				vaultId: `test-${Math.random()}`,
			});
			remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(true);

			const deps = createDeps({
				getSettings: () => settings,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => mockProvider({}),
			});
			const orchestrator = new SyncOrchestrator(deps);
			const readSpy = vi.spyOn(remoteFs, "read").mockRejectedValue(
				Object.assign(new Error("backend protocol mismatch"), { permanent: true })
			);

			await orchestrator.runSync();
			await orchestrator.runSync();
			await orchestrator.runSync();

			expect(readSpy).toHaveBeenCalledTimes(3);
			expect(deps.onStatusChange).toHaveBeenCalledWith("partial_error");
			await orchestrator.close();
		});

		it("does not advance the committed cursor when a cycle has failures", async () => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			addFile(localFs, "push.md", "body", 1000); // local-only → planned push

			// Pull/scan succeed; the push write fails → result.failed.length === 1.
			vi.spyOn(remoteFs, "write").mockRejectedValue(new Error("network dropped"));

			const settings = baseMockSettings({
				backendType: "test",
				vaultId: `test-${Math.random()}`,
			});
			remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(true);

			// The cursor now commits inside commitCheckpoint (atomically with the cache).
			// A failed cycle must NOT call it — that is exactly how the cursor is held back.
			const commitCheckpoint = vi.fn().mockResolvedValue(undefined);
			remoteFs.checkpoint!.commitCheckpoint = commitCheckpoint;
			const deps = createDeps({
				getSettings: () => settings,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => mockProvider({}),
			});
			const orchestrator = new SyncOrchestrator(deps);

			await orchestrator.runSync();

			// A failed action ⇒ the checkpoint (cursor + cache) is never committed.
			expect(commitCheckpoint).not.toHaveBeenCalled();
			await orchestrator.close();
		});

		/**
		 * The cursor commits atomically with the file map INSIDE commitCheckpoint (one
		 * IndexedDB transaction — ADR 0001). If that flush fails it must propagate so
		 * the cycle surfaces an error and the later token-state persist is skipped —
		 * nothing is committed, so a restart's replay re-detects the un-flushed work.
		 * See docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md.
		 */
		it("does not advance the committed cursor when the checkpoint flush (cache persist) fails", async () => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			// Steady state, matching baseline → a CLEAN cycle (no failed actions), so the
			// orchestrator reaches commitCheckpoint.
			addFile(localFs, "synced.md", "kept", 1000);
			addFile(remoteFs, "synced.md", "kept", 1000);

			const settings = baseMockSettings({
				backendType: "test",
				vaultId: `test-${Math.random()}`,
			});
			remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(true);

			const commitCheckpoint = vi.fn().mockRejectedValue(new Error("IndexedDB write failed"));
			remoteFs.checkpoint!.commitCheckpoint = commitCheckpoint;
			// readBackendState persists token state AFTER the checkpoint; a failed flush
			// must abort before it runs, so the cursor (committed inside commitCheckpoint)
			// is never advanced.
			const readBackendState = vi.fn().mockReturnValue({});
			const deps = createDeps({
				getSettings: () => settings,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () =>
					mockProvider({
						readBackendState: readBackendState as unknown as import("../fs/backend").IBackendProvider["readBackendState"],
					}),
			});
			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.state.put({
				path: "synced.md",
				hash: "",
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: 4,
				remoteSize: 4,
				syncedAt: 900,
			});

			await orchestrator.runSync();

			expect(commitCheckpoint).toHaveBeenCalled();
			// The flush threw → the post-checkpoint persist step never ran, and the cycle
			// surfaces an error rather than silently reporting success.
			expect(readBackendState).not.toHaveBeenCalled();
			expect(deps.onStatusChange).toHaveBeenCalledWith("error");
			await orchestrator.close();
		});
	});

	describe("scope-fingerprint forces a cold reconcile on scope change", () => {
		/**
		 * A stateful scope-fingerprint mock mirroring CachingRemoteFs's real semantics:
		 * `commitCheckpoint({scopeFingerprint})` persists it, `getScopeFingerprint()`
		 * reads back the last committed value (or the seed, or null).
		 */
		function wireScopeFingerprint(
			remoteFs: ReturnType<typeof createMockFs>,
			seed: string | null,
		): void {
			let committed = seed;
			remoteFs.checkpoint!.getScopeFingerprint = vi.fn().mockImplementation(() => Promise.resolve(committed));
			remoteFs.checkpoint!.commitCheckpoint = vi.fn().mockImplementation(
				(context?: { scopeFingerprint?: string }) => {
					if (context?.scopeFingerprint !== undefined) committed = context.scopeFingerprint;
					return Promise.resolve();
				},
			);
		}

		it("reruns cold and pulls a remote-only path once enableConfigSync widens scope", async () => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			// A remote-only file under the config dir — always existed on the remote,
			// but out of scope until enableConfigSync is turned on. The delta cursor has
			// already passed it (empty getChangedPaths), so only a forced cold reconcile
			// can surface it.
			addFile(remoteFs, `${TEST_CONFIG_DIR}/hotkeys.json`, "keys", 1000);

			const settings = baseMockSettings({
				backendType: "test",
				vaultId: `test-${Math.random()}`,
				enableConfigSync: false,
			});
			remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(true);
			wireScopeFingerprint(remoteFs, null);

			const deps = createDeps({
				getSettings: () => settings,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => mockProvider({}),
			});
			const orchestrator = new SyncOrchestrator(deps);

			// Cycle 1 with config sync off: commits a fingerprint, config dir stays
			// out of scope, nothing pulled.
			await orchestrator.runSync();
			expect(localFs.files.has(`${TEST_CONFIG_DIR}/hotkeys.json`)).toBe(false);

			// Turn on config sync — scope widens to include the config dir.
			settings.enableConfigSync = true;
			await orchestrator.runSync();

			expect(localFs.files.has(`${TEST_CONFIG_DIR}/hotkeys.json`)).toBe(true);
			await orchestrator.close();
		});

		it("does not force cold when settings are unchanged between cycles", async () => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			addFile(remoteFs, "synced.md", "kept", 1000);
			addFile(localFs, "synced.md", "kept", 1000);

			const settings = baseMockSettings({ backendType: "test", vaultId: `test-${Math.random()}` });
			remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(true);
			wireScopeFingerprint(remoteFs, null);

			const infoSpy = vi.fn();
			const deps = createDeps({
				getSettings: () => settings,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => mockProvider({}),
				logger: {
					debug: vi.fn(),
					info: infoSpy,
					warn: vi.fn(),
					error: vi.fn(),
					flush: vi.fn().mockResolvedValue(undefined),
				} as unknown as import("../logging/logger").Logger,
			});
			const orchestrator = new SyncOrchestrator(deps);

			await orchestrator.runSync(); // cycle 1: commits the fingerprint (migration)
			infoSpy.mockClear();

			await orchestrator.runSync(); // cycle 2: settings unchanged → no scope change
			const startedCall = infoSpy.mock.calls.find((c) => c[0] === "Sync started");
			expect(startedCall?.[1]).toMatchObject({ scopeChanged: false });
			await orchestrator.close();
		});

		it("treats a checkpoint with no committed fingerprint as changed (one-time migration)", async () => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			addFile(remoteFs, `${TEST_CONFIG_DIR}/hotkeys.json`, "keys", 1000);

			const settings = baseMockSettings({
				backendType: "test",
				vaultId: `test-${Math.random()}`,
				enableConfigSync: true,
			});
			// Simulates a checkpoint committed by pre-fix code: hasCheckpoint is true,
			// but getScopeFingerprint has never been set (always null).
			remoteFs.checkpoint!.hasCheckpoint = vi.fn().mockResolvedValue(true);
			wireScopeFingerprint(remoteFs, null);

			const deps = createDeps({
				getSettings: () => settings,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => mockProvider({}),
			});
			const orchestrator = new SyncOrchestrator(deps);

			await orchestrator.runSync();

			expect(localFs.files.has(`${TEST_CONFIG_DIR}/hotkeys.json`)).toBe(true);
			expect(await remoteFs.checkpoint!.getScopeFingerprint!()).not.toBeNull();
			await orchestrator.close();
		});
	});

	describe("phantom warm deletion is prevented (not recovered)", () => {
		it("does not delete a file missing from the listing but present on disk", async () => {
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			const deps = createDeps({
				localFs: () => localFs,
				remoteFs: () => remoteFs,
			});
			const orchestrator = new SyncOrchestrator(deps);

			// Steady state: a.md synced on both sides with a matching baseline.
			addFile(remoteFs, "a.md", "hello", 1000);
			addFile(localFs, "a.md", "hello", 1000); // present on disk (stat finds it)
			await orchestrator.state.put({
				path: "a.md",
				hash: "",
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: 5,
				remoteSize: 5,
				syncedAt: 900,
			});

			// Incomplete listing (index not fully loaded) — but stat() still finds
			// a.md, so the warm confirm pass cancels the would-be deletion.
			vi.spyOn(localFs, "list").mockResolvedValueOnce([]);
			await orchestrator.runSync();

			expect(remoteFs.files.has("a.md")).toBe(true); // NOT deleted
			expect(await orchestrator.state.get("a.md")).toBeDefined(); // baseline intact
			await orchestrator.close();
		});
	});
});
