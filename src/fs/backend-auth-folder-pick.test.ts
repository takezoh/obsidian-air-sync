import { describe, it, expect, vi } from "vitest";
import { completeAuthFolderPick } from "./backend-auth-folder-pick";
import type { BackendAuthFolderPickContext } from "./backend-auth-folder-pick";
import type { Logger } from "../logging/logger";
import { mockSettings } from "../__mocks__/sync-test-helpers";

function createContext(overrides: Partial<BackendAuthFolderPickContext> = {}): {
	context: BackendAuthFolderPickContext;
	logger: { error: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> };
	notify: ReturnType<typeof vi.fn>;
	completeWebFolderPick: ReturnType<typeof vi.fn>;
} {
	const error = vi.fn();
	const flush = vi.fn();
	const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error, flush } as unknown as Logger;
	const notify = vi.fn();
	const completeWebFolderPick = vi.fn().mockResolvedValue({ backendUpdates: { remoteVaultFolderId: "FID" } });
	const context: BackendAuthFolderPickContext = {
		input: "obsidian://air-sync-auth?code=abc",
		params: { id: "FID", state: "STATE-1" },
		settings: mockSettings(),
		auth: {
			isAuthenticated: () => true,
			startAuth: vi.fn(),
			completeAuth: vi.fn().mockResolvedValue({}),
		},
		picker: {
			startWebFolderPick: vi.fn(),
			completeWebFolderPick,
		},
		logger,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		resetAll: vi.fn().mockResolvedValue(undefined),
		closeRemoteFs: vi.fn(),
		notify,
		...overrides,
	};
	return { context, logger: { error, flush }, notify, completeWebFolderPick };
}

describe("completeAuthFolderPick", () => {
	it("binds the picked folder and notifies success", async () => {
		const { context, notify } = createContext();

		const result = await completeAuthFolderPick(context);

		expect(result).toBe(true);
		expect(context.closeRemoteFs).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Remote folder updated");
	});

	it("logs and flushes immediately when auth itself fails, without attempting the folder pick", async () => {
		// This is a pre-sync-cycle failure -- nothing else would flush this line to
		// .airsync/logs/ otherwise, since it never reaches a sync cycle at all.
		const { context, logger, notify, completeWebFolderPick } = createContext({
			auth: {
				isAuthenticated: () => false,
				startAuth: vi.fn(),
				completeAuth: vi.fn().mockRejectedValue(new Error("bad code")),
			},
		});

		const result = await completeAuthFolderPick(context);

		expect(result).toBe(false);
		expect(completeWebFolderPick).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith("Authorization failed", { message: "bad code" });
		expect(logger.flush).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Authorization failed: bad code");
	});

	it("logs and flushes immediately when the folder pick fails after a successful auth", async () => {
		// The exact scenario a trashed-folder Picker selection hits: auth succeeds,
		// completeWebFolderPick rejects. Live-confirmed this line never reached
		// .airsync/logs/ before this function flushed its own catch block.
		const { context, logger, notify } = createContext({
			picker: {
				startWebFolderPick: vi.fn(),
				completeWebFolderPick: vi.fn().mockRejectedValue(
					new Error("That folder is in Google Drive's Trash. Restore it, or pick a different folder."),
				),
			},
		});

		const result = await completeAuthFolderPick(context);

		expect(result).toBe(false);
		expect(logger.error).toHaveBeenCalledWith("Folder selection failed", {
			message: "That folder is in Google Drive's Trash. Restore it, or pick a different folder.",
		});
		expect(logger.flush).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"Folder selection failed: That folder is in Google Drive's Trash. Restore it, or pick a different folder.",
		);
	});
});
