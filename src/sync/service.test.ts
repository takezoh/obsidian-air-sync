import { describe, it, expect, vi } from "vitest";
import "fake-indexeddb/auto";
import type { SmartSyncSettings } from "../settings";
import { SyncService, SyncServiceDeps, getErrorInfo, isRateLimitError } from "./service";
import { LocalChangeDetector } from "./local-change-detector";
import type { SyncStateStore } from "./state";
import { createMockFs, addFile } from "../__mocks__/sync-test-helpers";

function mockSettings(overrides: Partial<SmartSyncSettings> = {}): SmartSyncSettings {
	return {
		vaultId: `test-${Math.random()}`,
		backendType: "none",
		ignorePatterns: [],
		syncDotPaths: [],
		conflictStrategy: "keep_newer",
		enableThreeWayMerge: false,
		autoSyncIntervalMinutes: 0,
		mobileMaxFileSizeMB: 10,
		enableLogging: false,
		logLevel: "info",
		backendData: {},
		...overrides,
	};
}

function createMockDeps(overrides: Partial<SyncServiceDeps> = {}): SyncServiceDeps {
	return {
		getSettings: () => mockSettings(),
		saveSettings: vi.fn().mockResolvedValue(undefined),
		localFs: () => createMockFs("local"),
		remoteFs: () => createMockFs("remote"),
		backendProvider: () => null,
		onStatusChange: vi.fn(),
		onProgress: vi.fn(),
		notify: vi.fn(),
		resolveConflict: vi.fn().mockResolvedValue("keep_newer"),
		resolveConflictBatch: vi.fn().mockResolvedValue(null),
		isMobile: () => false,
		...overrides,
	};
}

describe("SyncService", () => {
	it("calls notify when remoteFs is not available", async () => {
		const deps = createMockDeps({ remoteFs: () => null });
		const service = new SyncService(deps);

		await service.runSync();

		expect(deps.notify).toHaveBeenCalledWith("Not connected to a remote backend");
		expect(deps.onStatusChange).toHaveBeenCalledWith("not_connected");
		await service.close();
	});

	it("calls notify with sync results after successful sync", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		// Both sides empty — nothing to sync
		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		await service.runSync();

		expect(deps.notify).toHaveBeenCalledWith("Everything up to date");
		await service.close();
	});

	it("isExcluded respects ignore patterns", () => {
		const configDir = ".obsidian"; // eslint-disable-line obsidianmd/hardcoded-config-path
		const deps = createMockDeps({
			getSettings: () => mockSettings({
				ignorePatterns: [`${configDir}/**`, "*.tmp"],
			}),
		});
		const service = new SyncService(deps);

		expect(service.isExcluded(`${configDir}/plugins/test`)).toBe(true);
		expect(service.isExcluded("notes/hello.md")).toBe(false);
	});

	it("isExcluded supports negation patterns", () => {
		const deps = createMockDeps({
			getSettings: () => mockSettings({
				ignorePatterns: ["secret/**", "!secret/public/", "!secret/public/**"],
			}),
		});
		const service = new SyncService(deps);

		expect(service.isExcluded("secret/key.pem")).toBe(true);
		expect(service.isExcluded("secret/public/readme.md")).toBe(false);
	});
});

describe("SyncService — per-file errors do not trigger retry", () => {
	it("reports partial_error without throwing when only per-file errors occur", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		// Add a file to local that will fail to push (not readable from localFs
		// because we won't add content — but we add entity via list)
		const badEntity = {
			path: "bad.md",
			isDirectory: false,
			size: 5,
			mtime: 1000,
			hash: "",
		};
		localFs.files.set("bad.md", {
			content: new TextEncoder().encode("data").buffer as ArrayBuffer,
			entity: badEntity,
		});

		// Make read throw for this file
		const origRead = localFs.read.bind(localFs);
		localFs.read = async (path: string) => {
			if (path === "bad.md") throw new Error("disk error");
			return origRead(path);
		};

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		// Should NOT throw — per-file errors are handled gracefully
		await service.runSync();

		expect(deps.onStatusChange).toHaveBeenCalledWith("partial_error");
		await service.close();
	});
});

describe("SyncService — mobile filtering", () => {
	const mobilePatterns = ["*", "!*/", "!**/*.md", "!**/*.canvas", "!**/*.base"];

	it("isExcluded allows .md files with mobile patterns", () => {
		const deps = createMockDeps({
			getSettings: () => mockSettings({ ignorePatterns: mobilePatterns }),
		});
		const service = new SyncService(deps);

		expect(service.isExcluded("notes/hello.md")).toBe(false);
		expect(service.isExcluded("folder/diagram.canvas")).toBe(false);
		expect(service.isExcluded("folder/view.base")).toBe(false);
	});

	it("isExcluded blocks non-matching files with mobile patterns", () => {
		const deps = createMockDeps({
			getSettings: () => mockSettings({ ignorePatterns: mobilePatterns }),
		});
		const service = new SyncService(deps);

		expect(service.isExcluded("assets/image.png")).toBe(true);
		expect(service.isExcluded("data/file.pdf")).toBe(true);
	});

	it("isExcluded allows all files with empty patterns", () => {
		const deps = createMockDeps({
			getSettings: () => mockSettings({ ignorePatterns: [] }),
		});
		const service = new SyncService(deps);

		expect(service.isExcluded("assets/image.png")).toBe(false);
		expect(service.isExcluded("data/file.pdf")).toBe(false);
	});

	it("skips large files on mobile during sync", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		// Small .md file — should sync
		addFile(localFs, "notes/small.md", "hello", 1000);

		// Large .md file (> 10 MB) — should be skipped on mobile
		const bigEntity = {
			path: "notes/big.md",
			isDirectory: false,
			size: 11 * 1024 * 1024, // 11 MB
			mtime: 1000,
			hash: "",
		};
		localFs.files.set("notes/big.md", {
			content: new ArrayBuffer(100), // actual content doesn't matter
			entity: bigEntity,
		});

		const deps = createMockDeps({
			isMobile: () => true,
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		await service.runSync();

		// big.md should NOT be pushed to remote
		expect(remoteFs.files.has("notes/big.md")).toBe(false);
		// small.md should be pushed
		expect(remoteFs.files.has("notes/small.md")).toBe(true);
		await service.close();
	});

	it("syncs large files on desktop", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		const bigEntity = {
			path: "notes/big.md",
			isDirectory: false,
			size: 11 * 1024 * 1024,
			mtime: 1000,
			hash: "",
		};
		localFs.files.set("notes/big.md", {
			content: new TextEncoder().encode("big content").buffer as ArrayBuffer,
			entity: bigEntity,
		});

		const deps = createMockDeps({
			isMobile: () => false,
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		await service.runSync();

		// On desktop, large files should be synced
		expect(remoteFs.files.has("notes/big.md")).toBe(true);
		await service.close();
	});
});

describe("SyncService — initial sync hash resolution", () => {
	it("resolves identical files as no_action on initial sync", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		// Add identical content to both sides
		addFile(localFs, "notes/same.md", "identical content", 1000);
		addFile(remoteFs, "notes/same.md", "identical content", 2000);

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		await service.runSync();

		// Identical content should result in no_action — no changes to either side
		expect(deps.notify).toHaveBeenCalledWith("Everything up to date");
		await service.close();
	});

	it("detects different files as conflict on initial sync", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		// Add different content to both sides
		addFile(localFs, "notes/diff.md", "local content", 1000);
		addFile(remoteFs, "notes/diff.md", "remote content", 2000);

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		await service.runSync();

		// Different content should trigger conflict resolution (keep_newer default)
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("conflicts")
		);
		await service.close();
	});
});

describe("getErrorInfo (M2)", () => {
	it("extracts retry-after from a plain object headers", () => {
		const err = { status: 429, headers: { "retry-after": "30" } };
		const info = getErrorInfo(err);
		expect(info.status).toBe(429);
		expect(info.retryAfter).toBe(30);
	});

	it("extracts retry-after from a Fetch API Headers object", () => {
		const headers = new Headers();
		headers.set("retry-after", "60");
		const err = { status: 429, headers };
		const info = getErrorInfo(err);
		expect(info.status).toBe(429);
		expect(info.retryAfter).toBe(60);
	});

	it("returns null retryAfter when headers has no retry-after", () => {
		const headers = new Headers();
		const err = { status: 500, headers };
		const info = getErrorInfo(err);
		expect(info.status).toBe(500);
		expect(info.retryAfter).toBeNull();
	});

	it("handles Retry-After with capital case in plain object", () => {
		const err = { status: 429, headers: { "Retry-After": "10" } };
		const info = getErrorInfo(err);
		expect(info.retryAfter).toBe(10);
	});

	it("parses Retry-After as HTTP-date", () => {
		const futureDate = new Date(Date.now() + 120_000).toUTCString();
		const err = { status: 429, headers: { "retry-after": futureDate } };
		const info = getErrorInfo(err);
		expect(info.retryAfter).toBeGreaterThan(0);
		expect(info.retryAfter).toBeLessThanOrEqual(120);
	});

	it("returns null for invalid Retry-After value", () => {
		const err = { status: 429, headers: { "retry-after": "not-a-date-or-number" } };
		const info = getErrorInfo(err);
		expect(info.retryAfter).toBeNull();
	});

	it("clamps past HTTP-date to 0", () => {
		const pastDate = new Date(Date.now() - 60_000).toUTCString();
		const err = { status: 429, headers: { "retry-after": pastDate } };
		const info = getErrorInfo(err);
		expect(info.retryAfter).toBe(0);
	});
});


describe("isRateLimitError", () => {
	it("returns true for 403 with rateLimitExceeded reason", () => {
		const err = {
			status: 403,
			json: {
				error: {
					errors: [{ domain: "usageLimits", reason: "rateLimitExceeded", message: "Rate Limit Exceeded" }],
					code: 403,
					message: "Rate Limit Exceeded",
				},
			},
		};
		expect(isRateLimitError(err)).toBe(true);
	});

	it("returns true for 403 with userRateLimitExceeded reason", () => {
		const err = {
			status: 403,
			json: {
				error: {
					errors: [{ domain: "usageLimits", reason: "userRateLimitExceeded", message: "User Rate Limit Exceeded" }],
					code: 403,
					message: "User Rate Limit Exceeded",
				},
			},
		};
		expect(isRateLimitError(err)).toBe(true);
	});

	it("returns true for 403 with dailyLimitExceeded reason", () => {
		const err = {
			status: 403,
			json: {
				error: {
					errors: [{ domain: "usageLimits", reason: "dailyLimitExceeded", message: "Daily Limit Exceeded" }],
					code: 403,
					message: "Daily Limit Exceeded",
				},
			},
		};
		expect(isRateLimitError(err)).toBe(true);
	});

	it("returns false for 403 with insufficient permissions", () => {
		const err = {
			status: 403,
			json: {
				error: {
					errors: [{ domain: "global", reason: "insufficientPermissions", message: "Insufficient permissions" }],
					code: 403,
					message: "Insufficient permissions",
				},
			},
		};
		expect(isRateLimitError(err)).toBe(false);
	});

	it("returns false when no json property exists", () => {
		const err = { status: 403, message: "Forbidden" };
		expect(isRateLimitError(err)).toBe(false);
	});

	it("returns false for null/undefined", () => {
		expect(isRateLimitError(null)).toBe(false);
		expect(isRateLimitError(undefined)).toBe(false);
	});
});

describe("SyncService — bulk conflict resolution", () => {
	it("calls resolveConflictBatch when 5+ conflicts with ask strategy", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		for (let i = 0; i < 5; i++) {
			addFile(localFs, `file${i}.md`, `local content ${i}`, 1000);
			addFile(remoteFs, `file${i}.md`, `remote content ${i}`, 2000);
		}

		const resolveConflictBatch = vi.fn().mockResolvedValue("keep_local");
		const resolveConflict = vi.fn().mockResolvedValue("keep_newer");

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
			resolveConflictBatch,
			resolveConflict,
			getSettings: () => mockSettings({ conflictStrategy: "ask" }),
		});
		const service = new SyncService(deps);

		await service.runSync();

		expect(resolveConflictBatch).toHaveBeenCalledTimes(1);
		expect(resolveConflict).not.toHaveBeenCalled();
		await service.close();
	});

	it("does not call resolveConflictBatch when fewer than 5 conflicts", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		for (let i = 0; i < 4; i++) {
			addFile(localFs, `file${i}.md`, `local content ${i}`, 1000);
			addFile(remoteFs, `file${i}.md`, `remote content ${i}`, 2000);
		}

		const resolveConflictBatch = vi.fn().mockResolvedValue(null);
		const resolveConflict = vi.fn().mockResolvedValue("keep_newer");

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
			resolveConflictBatch,
			resolveConflict,
			getSettings: () => mockSettings({ conflictStrategy: "ask" }),
		});
		const service = new SyncService(deps);

		await service.runSync();

		expect(resolveConflictBatch).not.toHaveBeenCalled();
		expect(resolveConflict).toHaveBeenCalledTimes(4);
		await service.close();
	});

	it("does not call resolveConflictBatch when strategy is not ask", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		for (let i = 0; i < 5; i++) {
			addFile(localFs, `file${i}.md`, `local content ${i}`, 1000);
			addFile(remoteFs, `file${i}.md`, `remote content ${i}`, 2000);
		}

		const resolveConflictBatch = vi.fn().mockResolvedValue(null);

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
			resolveConflictBatch,
		});
		const service = new SyncService(deps);

		await service.runSync();

		expect(resolveConflictBatch).not.toHaveBeenCalled();
		await service.close();
	});
});

describe("SyncService — clearSyncState", () => {
	it("clears all sync records from the state store", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		// Add a file and sync it so state store has records
		addFile(localFs, "file.md", "content", 1000);

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		await service.runSync();
		// Verify state store has records
		const recordsBefore = await service.state.getAll();
		expect(recordsBefore.length).toBeGreaterThan(0);

		await service.clearSyncState();

		const recordsAfter = await service.state.getAll();
		expect(recordsAfter.length).toBe(0);
		await service.close();
	});
});

describe("SyncService — mass deletion safety net (ratio-based)", () => {
	it("triggers when more than half of local files would be deleted", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		// Add 20 files — first sync pushes them to remote
		for (let i = 0; i < 20; i++) {
			addFile(localFs, `file${i}.md`, `content ${i}`, 1000);
		}

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		await service.runSync();
		expect(await service.state.getAll()).toHaveLength(20);

		// Delete 12 of 20 files from remote (60% > 50% threshold)
		for (let i = 0; i < 12; i++) {
			remoteFs.files.delete(`file${i}.md`);
		}

		await service.runSync();

		// Local files should NOT be deleted — safety net triggered
		for (let i = 0; i < 12; i++) {
			expect(localFs.files.has(`file${i}.md`)).toBe(true);
		}

		// State was cleared and files re-pushed
		for (let i = 0; i < 12; i++) {
			expect(remoteFs.files.has(`file${i}.md`)).toBe(true);
		}

		await service.close();
	});

	it("does not trigger when exactly half or fewer files would be deleted", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		// Add 20 files
		for (let i = 0; i < 20; i++) {
			addFile(localFs, `file${i}.md`, `content ${i}`, 1000);
		}

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		await service.runSync();

		// Delete 10 of 20 (50% = not more than half, so should NOT trigger)
		for (let i = 0; i < 10; i++) {
			remoteFs.files.delete(`file${i}.md`);
		}

		await service.runSync();

		// Deletions should propagate normally
		for (let i = 0; i < 10; i++) {
			expect(localFs.files.has(`file${i}.md`)).toBe(false);
		}
		// Remaining files untouched
		for (let i = 10; i < 20; i++) {
			expect(localFs.files.has(`file${i}.md`)).toBe(true);
		}

		await service.close();
	});
});

describe("SyncService — mass deletion safety net", () => {
	it("aborts sync when all local files would be deleted (stale state)", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		// Add 10 files only to local — first sync pushes them to remote
		for (let i = 0; i < 10; i++) {
			addFile(localFs, `file${i}.md`, `content ${i}`, 1000);
		}

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		// First sync pushes files to remote and creates state records
		await service.runSync();
		const recordsAfterSync = await service.state.getAll();
		expect(recordsAfterSync.length).toBe(10);

		// Now simulate switching to an empty remote folder:
		// remote is empty, but local still has files and state has records
		remoteFs.files.clear();

		// Run sync again — safety net triggers, clears state, then retry
		// pushes all files to the "new" empty remote (correct behavior)
		await service.runSync();

		// Local files should NOT be deleted
		for (let i = 0; i < 10; i++) {
			expect(localFs.files.has(`file${i}.md`)).toBe(true);
		}

		// Files should be re-pushed to remote on retry
		for (let i = 0; i < 10; i++) {
			expect(remoteFs.files.has(`file${i}.md`)).toBe(true);
		}

		await service.close();
	});

	it("does not trigger for normal partial deletions", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		// Add 10 files only to local — first sync pushes them
		for (let i = 0; i < 10; i++) {
			addFile(localFs, `file${i}.md`, `content ${i}`, 1000);
		}

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		await service.runSync();

		// Delete only 3 files from remote (partial, not all)
		remoteFs.files.delete("file0.md");
		remoteFs.files.delete("file1.md");
		remoteFs.files.delete("file2.md");

		await service.runSync();

		// Should NOT trigger the safety net — partial deletion is normal
		expect(deps.onStatusChange).toHaveBeenCalledWith("idle");

		await service.close();
	});
});

describe("LocalChangeDetector — restore", () => {
	function createDetector(hasSnapshot: boolean) {
		const mockVault = { getAllLoadedFiles: () => [] } as unknown as import("obsidian").Vault;
		const mockStore = {
			loadLocalSnapshot: vi.fn().mockResolvedValue(hasSnapshot ? { files: {} } : null),
			saveLocalSnapshot: vi.fn().mockResolvedValue(undefined),
		} as unknown as SyncStateStore;
		return new LocalChangeDetector(mockVault, mockStore);
	}

	it("restore merges consumed paths back for retry", async () => {
		const detector = createDetector(true);
		await detector.initialize();

		detector.trackChange("a.md");
		detector.trackChange("b.md");
		detector.trackChange("c.md");

		const consumed = detector.consume();
		expect(consumed).not.toBeNull();
		expect(consumed!.size).toBe(3);

		// After consume, changedPaths is empty
		expect(detector.consume()!.size).toBe(0);

		// Restore the consumed paths (simulating sync failure)
		detector.restore(consumed!);

		const restored = detector.consume();
		expect(restored!.size).toBe(3);
		expect(restored!.has("a.md")).toBe(true);
		expect(restored!.has("b.md")).toBe(true);
		expect(restored!.has("c.md")).toBe(true);
	});

	it("restore merges with new runtime changes", async () => {
		const detector = createDetector(true);
		await detector.initialize();

		detector.trackChange("a.md");
		detector.trackChange("b.md");

		const consumed = detector.consume();
		expect(consumed!.size).toBe(2);

		// New change arrives during retry
		detector.trackChange("d.md");

		// Restore old consumed paths
		detector.restore(consumed!);

		const result = detector.consume();
		expect(result!.size).toBe(3);
		expect(result!.has("a.md")).toBe(true);
		expect(result!.has("b.md")).toBe(true);
		expect(result!.has("d.md")).toBe(true);
	});

	it("restore is no-op when detector is not active", async () => {
		const detector = createDetector(false);
		await detector.initialize(); // returns false, not active

		detector.restore(new Set(["a.md", "b.md"]));

		expect(detector.consume()).toBeNull();
	});
});

describe("SyncService — retry restores local delta on failure", () => {
	it("restores consumed local changes when executor throws", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		// Add files to local
		addFile(localFs, "a.md", "content a", 1000);
		addFile(localFs, "b.md", "content b", 1000);

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		// First sync succeeds — pushes files and creates state
		await service.runSync();
		expect(remoteFs.files.has("a.md")).toBe(true);
		expect(remoteFs.files.has("b.md")).toBe(true);

		// Now modify a file locally (different mtime)
		addFile(localFs, "a.md", "updated content", 2000);

		// Make remote write throw to simulate network failure
		const origWrite = remoteFs.write.bind(remoteFs);
		let writeCallCount = 0;
		remoteFs.write = async (path: string, content: ArrayBuffer, mtime: number) => {
			writeCallCount++;
			// Fail on first write attempt (from first retry), succeed on subsequent
			if (writeCallCount <= 1) throw Object.assign(new Error("Network error"), { status: 500 });
			return origWrite(path, content, mtime);
		};

		// Run sync — first attempt fails, retry should succeed
		await service.runSync();

		// The file should ultimately be synced after retry
		expect(deps.onStatusChange).toHaveBeenCalledWith("idle");
		await service.close();
	});
});

describe("SyncService — resolveEmptyHashes edge cases", () => {
	it("skips hash computation when file sizes differ", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		// 10 bytes vs 24 bytes — sizes differ
		addFile(localFs, "file.md", "short text", 1000);
		addFile(remoteFs, "file.md", "this is much longer text", 2000);

		const localReadSpy = vi.spyOn(localFs, "read");

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		await service.runSync();

		// resolveEmptyHashes skips (sizes differ), executor uses keep_newer
		// which reads remote (newer mtime) — localFs.read never called
		expect(localReadSpy).not.toHaveBeenCalled();
		// Should report conflict (hashes not resolved → conflict_both_created)
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("conflicts")
		);
		await service.close();
	});

	it("skips hash computation when one side already has a hash", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");

		// Same size but local already has a hash
		const localEntity = addFile(localFs, "file.md", "same length!", 1000);
		localEntity.hash = "pre-existing-hash";
		addFile(remoteFs, "file.md", "same length!", 2000);

		const localReadSpy = vi.spyOn(localFs, "read");

		const deps = createMockDeps({
			localFs: () => localFs,
			remoteFs: () => remoteFs,
		});
		const service = new SyncService(deps);

		await service.runSync();

		// resolveEmptyHashes requires BOTH hashes empty — local has one, so skip
		// keep_newer reads remote (newer mtime) — localFs.read never called
		expect(localReadSpy).not.toHaveBeenCalled();
		// conflict_both_created since remote hash is empty (falsy in hash comparison)
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("conflicts")
		);
		await service.close();
	});
});
