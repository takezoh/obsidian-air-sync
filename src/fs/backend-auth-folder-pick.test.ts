import { describe, it, expect, vi } from "vitest";
import { completeAuthFolderPick } from "./backend-auth-folder-pick";
import type { BackendAuthFolderPickContext } from "./backend-auth-folder-pick";
import { Logger } from "../logging/logger";
import type { RawFsAdapter } from "./raw-fs";
import { mockSettings } from "../__mocks__/sync-test-helpers";

function realLogger(adapter: RawFsAdapter): Logger {
	return new Logger(
		adapter,
		() => mockSettings({ enableLogging: true, logLevel: "debug" }),
		"desktop",
	);
}

function createLogAdapter(): RawFsAdapter & { written: Map<string, string> } {
	const written = new Map<string, string>();
	const dirs = new Set<string>();
	return {
		written,
		exists: (path) => Promise.resolve(written.has(path) || dirs.has(path)),
		read: (path) => Promise.resolve(written.get(path) ?? ""),
		write: (path, data) => { written.set(path, data); return Promise.resolve(); },
		mkdir: (path) => { dirs.add(path); return Promise.resolve(); },
	};
}

async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

function createContext(
	overrides: Partial<BackendAuthFolderPickContext> = {},
): { context: BackendAuthFolderPickContext; adapter: ReturnType<typeof createLogAdapter>; notify: ReturnType<typeof vi.fn> } {
	const adapter = createLogAdapter();
	const notify = vi.fn();
	const context: BackendAuthFolderPickContext = {
		input: "obsidian://air-sync-auth?code=abc",
		params: { id: "FID", state: "STATE-1" },
		settings: mockSettings({ enableLogging: true, logLevel: "debug" }),
		auth: {
			isAuthenticated: () => true,
			startAuth: vi.fn(),
			completeAuth: vi.fn().mockResolvedValue({}),
		},
		picker: {
			startWebFolderPick: vi.fn(),
			completeWebFolderPick: vi.fn().mockResolvedValue({ backendUpdates: { remoteVaultFolderId: "FID" } }),
		},
		logger: realLogger(adapter),
		saveSettings: vi.fn().mockResolvedValue(undefined),
		resetAll: vi.fn().mockResolvedValue(undefined),
		closeRemoteFs: vi.fn(),
		notify,
		...overrides,
	};
	return { context, adapter, notify };
}

describe("completeAuthFolderPick", () => {
	it("binds the picked folder and notifies success", async () => {
		const { context, notify } = createContext();

		const result = await completeAuthFolderPick(context);

		expect(result).toBe(true);
		expect(context.closeRemoteFs).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Remote folder updated");
	});

	it("puts a pre-sync-cycle auth failure on disk without any caller flush", async () => {
		// Issue #82: this path fails before any sync cycle runs, so nothing else
		// flushes it. The Notice shows and the line silently stays in memory.
		const { context, adapter, notify } = createContext({
			auth: {
				isAuthenticated: () => false,
				startAuth: vi.fn(),
				completeAuth: vi.fn().mockRejectedValue(new Error("bad code")),
			},
		});

		const result = await completeAuthFolderPick(context);
		await drainMicrotasks();

		expect(result).toBe(false);
		expect(notify).toHaveBeenCalledWith("Authorization failed: bad code");
		const files = [...adapter.written.keys()].filter((p) => p.endsWith(".log"));
		expect(files).toHaveLength(1);
		expect(adapter.written.get(files[0]!)).toContain("Authorization failed");
	});

	it("puts the trashed-folder Picker rejection on disk without any caller flush", async () => {
		// The exact live scenario from #82: auth succeeds, completeWebFolderPick
		// rejects (e.g. a trashed folder), and the error never reached the log file.
		const { context, adapter, notify } = createContext({
			picker: {
				startWebFolderPick: vi.fn(),
				completeWebFolderPick: vi.fn().mockRejectedValue(
					new Error("That folder is in Google Drive's Trash. Restore it, or pick a different folder."),
				),
			},
		});

		const result = await completeAuthFolderPick(context);
		await drainMicrotasks();

		expect(result).toBe(false);
		expect(notify).toHaveBeenCalledWith(
			"Folder selection failed: That folder is in Google Drive's Trash. Restore it, or pick a different folder.",
		);
		const files = [...adapter.written.keys()].filter((p) => p.endsWith(".log"));
		expect(files).toHaveLength(1);
		expect(adapter.written.get(files[0]!)).toContain("Folder selection failed");
	});
});
