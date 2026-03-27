import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyIncrementalChanges } from "./incremental-sync";
import type { IncrementalSyncContext } from "./incremental-sync";
import type { DriveFile } from "./types";
import { FOLDER_MIME } from "./types";
import type { DriveMetadataCache } from "./metadata-cache";
import type { DriveClient } from "./client";

vi.mock("obsidian");

describe("applyIncrementalChanges", () => {
	let listChanges: ReturnType<typeof vi.fn>;
	let getPathById: ReturnType<typeof vi.fn>;
	let collectDescendants: ReturnType<typeof vi.fn>;
	let removeTree: ReturnType<typeof vi.fn>;
	let applyFileChange: ReturnType<typeof vi.fn>;
	let isFolder: ReturnType<typeof vi.fn>;
	let getFile: ReturnType<typeof vi.fn>;
	let loggerInfo: ReturnType<typeof vi.fn>;
	let loggerWarn: ReturnType<typeof vi.fn>;
	let mockClient: DriveClient;
	let mockCache: DriveMetadataCache;
	let ctx: IncrementalSyncContext;

	beforeEach(() => {
		listChanges = vi.fn();
		getPathById = vi.fn();
		collectDescendants = vi.fn().mockReturnValue([]);
		removeTree = vi.fn();
		applyFileChange = vi.fn();
		isFolder = vi.fn().mockReturnValue(false);
		getFile = vi.fn().mockReturnValue(undefined);
		loggerInfo = vi.fn();
		loggerWarn = vi.fn();

		mockClient = { listChanges } as unknown as DriveClient;
		mockCache = {
			getPathById,
			collectDescendants,
			removeTree,
			applyFileChange,
			isFolder,
			getFile,
		} as unknown as DriveMetadataCache;

		ctx = {
			client: mockClient,
			cache: mockCache,
			logger: {
				info: loggerInfo,
				warn: loggerWarn,
				error: vi.fn(),
				debug: vi.fn(),
			} as unknown as import("../../logging/logger").Logger,
		};
	});

	it("applies incremental changes successfully", async () => {
		const mockFile: DriveFile = {
			id: "file-1",
			name: "test.txt",
			mimeType: "text/plain",
			trashed: false,
		};

		listChanges.mockResolvedValue({
			changes: [{ fileId: "file-1", file: mockFile, removed: false }],
			nextPageToken: undefined,
			newStartPageToken: "new-token-123",
		});

		getPathById.mockReturnValue("/test.txt");

		const result = await applyIncrementalChanges(ctx, "old-token");

		expect(result).toEqual({
			newToken: "new-token-123",
			needsFullScan: false,
			changedPaths: new Set(["/test.txt"]),
		});
		expect(loggerInfo).toHaveBeenCalledWith("Incremental changes applied", {
			changeCount: 1,
		});
	});

	it("falls back to full scan on 410 (token expired)", async () => {
		const error = new Error("Changes token expired");
		Object.assign(error, { status: 410 });

		listChanges.mockRejectedValue(error);

		const result = await applyIncrementalChanges(ctx, "expired-token");

		expect(result).toEqual({ needsFullScan: true, changedPaths: new Set() });
		expect(loggerInfo).toHaveBeenCalledWith(
			"Changes token expired (410), falling back to full scan"
		);
	});

	it("re-throws 401 as auth error (no fallback to full scan)", async () => {
		const error = new Error("Unauthorized");
		Object.assign(error, { status: 401 });

		listChanges.mockRejectedValue(error);

		await expect(applyIncrementalChanges(ctx, "invalid-token")).rejects.toThrow(
			"Unauthorized"
		);
	});

	it("re-throws other HTTP errors", async () => {
		const error = new Error("Internal server error");
		Object.assign(error, { status: 500 });

		listChanges.mockRejectedValue(error);

		await expect(applyIncrementalChanges(ctx, "valid-token")).rejects.toThrow(
			"Internal server error"
		);
	});

	it("re-throws non-HTTP errors", async () => {
		const error = new Error("Network error");

		listChanges.mockRejectedValue(error);

		await expect(applyIncrementalChanges(ctx, "valid-token")).rejects.toThrow(
			"Network error"
		);
	});

	it("reports old path as deleted when file is moved/renamed", async () => {
		const mockFile: DriveFile = {
			id: "file-1",
			name: "renamed.txt",
			mimeType: "text/plain",
			trashed: false,
		};

		listChanges.mockResolvedValue({
			changes: [{ fileId: "file-1", file: mockFile, removed: false }],
			nextPageToken: undefined,
			newStartPageToken: "new-token",
		});

		// Before applyFileChange: old path; after: new path
		getPathById
			.mockReturnValueOnce("old/test.txt")
			.mockReturnValueOnce("new/renamed.txt");

		const result = await applyIncrementalChanges(ctx, "token");

		expect(result.needsFullScan).toBe(false);
		if (!result.needsFullScan) {
			expect(result.changedPaths).toEqual(
				new Set(["old/test.txt", "new/renamed.txt"]),
			);
		}
	});

	it("reports old descendant paths as deleted when folder is moved", async () => {
		const mockFolder: DriveFile = {
			id: "folder-1",
			name: "moved-folder",
			mimeType: FOLDER_MIME,
			trashed: false,
		};

		listChanges.mockResolvedValue({
			changes: [{ fileId: "folder-1", file: mockFolder, removed: false }],
			nextPageToken: undefined,
			newStartPageToken: "new-token",
		});

		// oldPath capture before applyFileChange, then post-applyFileChange
		getPathById
			.mockReturnValueOnce("old/folder")
			.mockReturnValueOnce("new/moved-folder");

		isFolder.mockReturnValue(true);

		collectDescendants
			.mockReturnValueOnce(["old/folder/child.txt"])
			.mockReturnValueOnce(["new/moved-folder/child.txt"]);

		const childFile: DriveFile = {
			id: "child-1",
			name: "child.txt",
			mimeType: "text/plain",
			trashed: false,
		};
		getFile.mockReturnValueOnce(childFile);

		const result = await applyIncrementalChanges(ctx, "token");

		expect(result.needsFullScan).toBe(false);
		if (!result.needsFullScan) {
			expect(result.changedPaths).toContain("old/folder");
			expect(result.changedPaths).toContain("old/folder/child.txt");
			expect(result.changedPaths).toContain("new/moved-folder");
			expect(result.changedPaths).toContain("new/moved-folder/child.txt");
		}
	});

	it("reports old path as deleted when file is moved outside sync root", async () => {
		const mockFile: DriveFile = {
			id: "file-1",
			name: "moved-out.txt",
			mimeType: "text/plain",
			trashed: false,
		};

		listChanges.mockResolvedValue({
			changes: [{ fileId: "file-1", file: mockFile, removed: false }],
			nextPageToken: undefined,
			newStartPageToken: "new-token",
		});

		// Old path exists, but after applyFileChange the file is outside root
		getPathById
			.mockReturnValueOnce("docs/moved-out.txt")
			.mockReturnValueOnce(undefined);

		const result = await applyIncrementalChanges(ctx, "token");

		expect(result.needsFullScan).toBe(false);
		if (!result.needsFullScan) {
			expect(result.changedPaths).toEqual(new Set(["docs/moved-out.txt"]));
		}
	});
});
