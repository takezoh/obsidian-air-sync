import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import type { DriveFile } from "./types";
import { spyRequestUrl, mockRes } from "./test-helpers";
import type { GoogleDriveFsInternal, GoogleDriveFsCacheInternal } from "./test-helpers";

vi.mock("obsidian");

describe("GoogleDriveFs folder rename child path rewrite", () => {
	it("rewrites child paths when a folder is renamed via incremental changes", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "folder1", name: "oldFolder", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "file1", name: "child.txt", mimeType: "text/plain", parents: ["folder1"] },
				{ id: "file2", name: "deep.txt", mimeType: "text/plain", parents: ["folder1"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					{
						type: "file",
						fileId: "folder1",
						removed: false,
						file: { id: "folder1", name: "newFolder", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
					},
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");

		// Initial list to populate cache
		const initial = await fs.list();
		expect(initial.map((e) => e.path).sort()).toEqual([
			"oldFolder",
			"oldFolder/child.txt",
			"oldFolder/deep.txt",
		]);

		// Apply incremental change that renames oldFolder → newFolder
		await fs.getChangedPaths();
		const updated = await fs.list();
		const paths = updated.map((e) => e.path).sort();

		expect(paths).toContain("newFolder");
		expect(paths).toContain("newFolder/child.txt");
		expect(paths).toContain("newFolder/deep.txt");
		expect(paths).not.toContain("oldFolder");
		expect(paths).not.toContain("oldFolder/child.txt");
	});
});

describe("GoogleDriveFs fullScan empty-listing safety", () => {
	it("proceeds with an empty cache when a genuinely empty root still exists", async () => {
		const { GoogleDriveFs } = await import("./index");
		const getFile = vi.fn().mockResolvedValue({
			id: "root", name: "vault", mimeType: "application/vnd.google-apps.folder",
		});
		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			getFile,
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		const entries = await fs.list();

		expect(entries).toEqual([]);
		// An empty listing is confirmed against the live folder, not trusted blindly.
		expect(getFile).toHaveBeenCalledWith("root");
	});

	it("aborts (throws) instead of reporting an empty remote when the root is gone (404)", async () => {
		const { GoogleDriveFs } = await import("./index");
		const getFile = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			getFile,
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		// A deleted/trashed root must NOT surface as an empty remote — that would make
		// the cold reconcile mass-delete every local file. The scan throws so sync aborts.
		await expect(fs.list()).rejects.toThrow(/Not Found/);
	});

	it("aborts when the root has been moved to Trash (getFile returns trashed:true)", async () => {
		const { GoogleDriveFs } = await import("./index");
		const getFile = vi.fn().mockResolvedValue({
			id: "root", name: "vault", mimeType: "application/vnd.google-apps.folder", trashed: true,
		});
		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			getFile,
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await expect(fs.list()).rejects.toThrow(/Trash/);
	});
});

describe("GoogleDriveFs.ensureFolder file collision", () => {
	it("throws when a path segment is a file not a folder", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "file1", name: "docs", mimeType: "text/plain", parents: ["root"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");

		// Populate cache
		await fs.list();

		// Trying to mkdir docs/sub should fail because "docs" is a file
		await expect(fs.mkdir("docs/sub")).rejects.toThrow(
			'Cannot create directory "docs/sub": "docs" is a file'
		);
	});
});

describe("GoogleDriveFs.write remoteChecksum", () => {
	it("includes remoteChecksum (md5) when returned by Drive API", async () => {
		const uploadResult = {
			id: "file1",
			name: "test.md",
			mimeType: "text/plain",
			modifiedTime: "2024-01-01T00:00:00.000Z",
			size: "5",
			md5Checksum: "abc123hash",
		};
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			() => Promise.resolve(mockRes(uploadResult))
		);

		const { GoogleDriveFs } = await import("./index");
		const { DriveClient } = await import("./client");
		const client = new DriveClient(() => Promise.resolve("access"));
		const fs = new GoogleDriveFs(client, "root");

		(fs as unknown as GoogleDriveFsInternal).initialized = true;

		const content = new TextEncoder().encode("hello").buffer.slice(0);
		const result = await fs.write("test.md", content, Date.now());

		expect(result.remoteChecksum).toEqual({ algo: "md5", value: "abc123hash" });
		expect(result.backendMeta?.driveId).toBe("file1");

		mockRequestUrl.mockRestore();
	});

	it("handles missing remoteChecksum (Google Docs) gracefully", async () => {
		const uploadResult = {
			id: "doc1",
			name: "doc.gdoc",
			mimeType: "application/vnd.google-apps.document",
			modifiedTime: "2024-01-01T00:00:00.000Z",
		};
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			(opts: string | { url: string }) => {
				const url = typeof opts === "string" ? opts : opts.url;
				if (url.includes("uploadType=")) return Promise.resolve(mockRes(uploadResult));
				return Promise.resolve(mockRes({ files: [] }));
			}
		);

		const { GoogleDriveFs } = await import("./index");
		const { DriveClient } = await import("./client");
		const client = new DriveClient(() => Promise.resolve("access"));
		const fs = new GoogleDriveFs(client, "root");

		(fs as unknown as GoogleDriveFsInternal).initialized = true;

		const content = new TextEncoder().encode("hello").buffer.slice(0);
		const result = await fs.write("doc.gdoc", content, Date.now());

		expect(result.remoteChecksum).toBeUndefined();
		expect(result.backendMeta?.driveId).toBe("doc1");

		mockRequestUrl.mockRestore();
	});
});

describe("GoogleDriveFs.write stale-cache guard for new paths", () => {
	it("does not clobber a concurrent delta that created the same path during upload", async () => {
		const uploadResult: DriveFile = {
			id: "uploaded-id",
			name: "new.md",
			mimeType: "text/plain",
			modifiedTime: "2024-01-01T00:00:00.000Z",
			size: "5",
		};

		const { GoogleDriveFs } = await import("./index");
		const { DriveClient } = await import("./client");
		const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

		const client = new DriveClient(() => Promise.resolve("access"));
		const fs = new GoogleDriveFs(
			client,
			"root",
			mockLogger as unknown as import("../../logging/logger").Logger,
		);
		(fs as unknown as GoogleDriveFsInternal).initialized = true;

		const cache = (fs as unknown as {
			cache: {
				setFile(p: string, f: DriveFile): void;
				getFile(p: string): DriveFile | undefined;
			};
		}).cache;

		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			(opts: string | { url: string }) => {
				const url = typeof opts === "string" ? opts : opts.url;
				if (url.includes("uploadType=")) {
					// Phase 2 (upload) runs outside the cache mutex. Simulate a concurrent
					// delta landing a DIFFERENT file at the same path while it is in flight.
					cache.setFile("new.md", {
						id: "delta-id",
						name: "new.md",
						mimeType: "text/plain",
						modifiedTime: "2024-02-02T00:00:00.000Z",
					});
					return Promise.resolve(mockRes(uploadResult));
				}
				return Promise.resolve(mockRes({ files: [] }));
			},
		);

		const content = new TextEncoder().encode("hello").buffer.slice(0);
		await fs.write("new.md", content, Date.now());

		// The concurrent delta's entry survives — the upload did not overwrite it.
		// (The in-memory cursor advanced past the delta, so the next cycle re-detects
		// our write; no data is lost.)
		expect(cache.getFile("new.md")?.id).toBe("delta-id");
		expect(mockLogger.warn).toHaveBeenCalledWith(
			"Skipping stale cache update for write",
			{ path: "new.md" },
		);

		mockRequestUrl.mockRestore();
	});
});

describe("GoogleDriveFs.rename stale-cache guard for the destination", () => {
	it("does not clobber a concurrent delta that occupied newPath during the move", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { DriveClient } = await import("./client");
		const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

		const client = new DriveClient(() => Promise.resolve("access"));
		const fs = new GoogleDriveFs(
			client,
			"root",
			mockLogger as unknown as import("../../logging/logger").Logger,
		);
		(fs as unknown as GoogleDriveFsInternal).initialized = true;

		const cache = (fs as unknown as {
			cache: {
				setFile(p: string, f: DriveFile): void;
				getFile(p: string): DriveFile | undefined;
				getPathById(id: string): string | undefined;
			};
		}).cache;
		cache.setFile("old.md", {
			id: "f1", name: "old.md", mimeType: "text/plain", modifiedTime: "2024-01-01T00:00:00.000Z",
		});

		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			(opts: string | { url: string }) => {
				const url = typeof opts === "string" ? opts : opts.url;
				if (url.includes("/files/f1")) {
					// Phase 2 (the PATCH move) runs outside the cache mutex. Simulate a
					// concurrent delta landing a DIFFERENT file at the destination path.
					cache.setFile("new.md", {
						id: "delta-id", name: "new.md", mimeType: "text/plain", modifiedTime: "2024-02-02T00:00:00.000Z",
					});
					return Promise.resolve(mockRes({
						id: "f1", name: "new.md", mimeType: "text/plain", modifiedTime: "2024-01-01T00:00:00.000Z",
					}));
				}
				return Promise.resolve(mockRes({ files: [] }));
			},
		);

		await fs.rename("old.md", "new.md");

		// The concurrent delta's entry survives and its id stays correctly mapped —
		// the move did not overwrite it or strand "delta-id" in idToPath.
		expect(cache.getFile("new.md")?.id).toBe("delta-id");
		expect(cache.getPathById("delta-id")).toBe("new.md");
		expect(mockLogger.warn).toHaveBeenCalledWith(
			"Skipping stale cache update for rename",
			{ path: "new.md" },
		);

		mockRequestUrl.mockRestore();
	});
});

describe("GoogleDriveFs.commitCheckpoint persistence-failure safety", () => {
	it("propagates a failed flush and keeps the buffer so the cursor is not committed ahead of the cache", async () => {
		const { GoogleDriveFs } = await import("./index");
		type Store = import("../../store/metadata-store").MetadataStore<DriveFile>;

		const allFiles = [
			{ id: "f1", name: "docs", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
			{ id: "file1", name: "note.md", mimeType: "text/plain", parents: ["f1"], modifiedTime: "2024-01-01T00:00:00.000Z", size: "100" },
		];
		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue(allFiles),
			getChangesStartToken: vi.fn().mockResolvedValue("token-abc"),
		} as never;

		const saveAll = vi.fn().mockRejectedValue(new Error("quota exceeded"));
		const failingStore = {
			open: vi.fn().mockResolvedValue(undefined),
			loadAll: vi.fn().mockResolvedValue({ files: [], meta: new Map() }),
			saveAll,
			putFiles: vi.fn().mockRejectedValue(new Error("quota exceeded")),
			deleteFiles: vi.fn().mockRejectedValue(new Error("quota exceeded")),
			close: vi.fn().mockResolvedValue(undefined),
		} as unknown as Store;

		const fs = new GoogleDriveFs(mockClient, "root", undefined, failingStore);
		await fs.list(); // fullScan → pendingFullPersist = true

		// The flush fails. commitCheckpoint MUST reject rather than swallow — the
		// orchestrator awaits it before committing the (advanced) cursor, so a throw
		// aborts that commit and keeps the persisted cache and committed cursor in step.
		await expect(fs.commitCheckpoint()).rejects.toThrow(/quota exceeded/);
		expect(saveAll).toHaveBeenCalledTimes(1);

		// The buffer is RETAINED (not cleared on failure), so when the store recovers
		// the next clean cycle re-attempts the full flush. If the buffer had been
		// cleared on failure, pendingFullPersist would be false and this second commit
		// would persist nothing (saveAll would stay at 1).
		saveAll.mockResolvedValueOnce(undefined);
		await fs.commitCheckpoint();
		expect(saveAll).toHaveBeenCalledTimes(2);
	});
});

describe("GoogleDriveFs multi-parent resolution", () => {
	it("resolves file with multiple parents to root when rootId is second", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{
					id: "file1",
					name: "shared.txt",
					mimeType: "text/plain",
					parents: ["outsideId", "root"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		const files = await fs.list();

		expect(files).toHaveLength(1);
		expect(files[0]!.path).toBe("shared.txt");
	});

	it("resolves nested file via known parent when first parent is unknown", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{
					id: "folder1",
					name: "docs",
					mimeType: "application/vnd.google-apps.folder",
					parents: ["root"],
				},
				{
					id: "file1",
					name: "note.md",
					mimeType: "text/plain",
					parents: ["outsideFolder", "folder1"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		const files = await fs.list();
		const paths = files.map((f) => f.path).sort();

		expect(paths).toContain("docs");
		expect(paths).toContain("docs/note.md");
	});

	it("single parent still works (regression)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{
					id: "folder1",
					name: "notes",
					mimeType: "application/vnd.google-apps.folder",
					parents: ["root"],
				},
				{
					id: "file1",
					name: "hello.md",
					mimeType: "text/plain",
					parents: ["folder1"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		const files = await fs.list();
		const paths = files.map((f) => f.path).sort();

		expect(paths).toContain("notes");
		expect(paths).toContain("notes/hello.md");
	});

	it("resolvePathFromCache handles multi-parent in incremental changes", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{
					id: "folder1",
					name: "docs",
					mimeType: "application/vnd.google-apps.folder",
					parents: ["root"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					{
						type: "file",
						fileId: "file1",
						removed: false,
						file: {
							id: "file1",
							name: "new.md",
							mimeType: "text/plain",
							parents: ["outsideId", "folder1"],
						},
					},
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");

		// Initial scan
		await fs.list();

		// Apply incremental change with multi-parent file
		await fs.getChangedPaths();
		const files = await fs.list();
		const paths = files.map((f) => f.path).sort();

		expect(paths).toContain("docs");
		expect(paths).toContain("docs/new.md");
	});
});

describe("GoogleDriveFs circular parent reference", () => {
	it("handles mutual cycle (A→B→A) without infinite loop", async () => {
		const { GoogleDriveFs } = await import("./index");
		const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "a", name: "folderA", mimeType: "application/vnd.google-apps.folder", parents: ["b"] },
				{ id: "b", name: "folderB", mimeType: "application/vnd.google-apps.folder", parents: ["a"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root", mockLogger);
		const files = await fs.list();

		// list() completes without hanging
		expect(files.length).toBe(2);
		expect((mockLogger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
			expect.stringContaining("Circular parent reference"),
			expect.any(Object)
		);
	});

	it("handles self-referencing parent (X→X) without infinite loop", async () => {
		const { GoogleDriveFs } = await import("./index");
		const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "x", name: "selfRef", mimeType: "text/plain", parents: ["x"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root", mockLogger);
		const files = await fs.list();

		expect(files.length).toBe(1);
		expect(files[0]!.path).toBe("selfRef");
		expect((mockLogger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
			expect.stringContaining("Circular parent reference"),
			expect.any(Object)
		);
	});
});

describe("GoogleDriveFs children index", () => {
	it("removeTree removes all descendants (nested folders)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "f1", name: "a", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "f2", name: "b", mimeType: "application/vnd.google-apps.folder", parents: ["f1"] },
				{ id: "file1", name: "c.txt", mimeType: "text/plain", parents: ["f2"] },
				{ id: "file2", name: "d.txt", mimeType: "text/plain", parents: ["f1"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					{ type: "file", fileId: "f1", removed: true },
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");

		// Populate cache
		const initial = await fs.list();
		expect(initial).toHaveLength(4);

		// Delete folder "a" via incremental changes
		await fs.getChangedPaths();
		const after = await fs.list();

		// All descendants should be removed
		expect(after).toHaveLength(0);
	});

	it("rewriteChildPaths correctly updates deeply nested paths", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "f1", name: "top", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "f2", name: "mid", mimeType: "application/vnd.google-apps.folder", parents: ["f1"] },
				{ id: "f3", name: "deep", mimeType: "application/vnd.google-apps.folder", parents: ["f2"] },
				{ id: "file1", name: "leaf.txt", mimeType: "text/plain", parents: ["f3"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					{
						type: "file",
						fileId: "f1",
						removed: false,
						file: { id: "f1", name: "renamed", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
					},
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();
		await fs.getChangedPaths();
		const after = await fs.list();
		const paths = after.map((e) => e.path).sort();

		expect(paths).toEqual([
			"renamed",
			"renamed/mid",
			"renamed/mid/deep",
			"renamed/mid/deep/leaf.txt",
		]);

		// Verify children index is consistent
		const cache = (fs as unknown as GoogleDriveFsCacheInternal).cache;
		expect(cache.getChildren("renamed")?.has("renamed/mid")).toBe(true);
		expect(cache.getChildren("renamed/mid")?.has("renamed/mid/deep")).toBe(true);
		expect(cache.getChildren("renamed/mid/deep")?.has("renamed/mid/deep/leaf.txt")).toBe(true);
	});

	it("listDir returns only direct children (not recursive)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "f1", name: "parent", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "f2", name: "child", mimeType: "application/vnd.google-apps.folder", parents: ["f1"] },
				{ id: "file1", name: "a.txt", mimeType: "text/plain", parents: ["f1"] },
				{ id: "file2", name: "b.txt", mimeType: "text/plain", parents: ["f2"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		const children = await fs.listDir("parent");
		const childPaths = children.map((e) => e.path).sort();

		expect(childPaths).toEqual(["parent/a.txt", "parent/child"]);
		// Should NOT include parent/child/b.txt
		expect(childPaths).not.toContain("parent/child/b.txt");
	});
});

describe("GoogleDriveFs cache persistence", () => {

	it("fullScan persists cache, loadFromCache restores it", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { MetadataStore } = await import("../../store/metadata-store");

		const allFiles = [
			{ id: "f1", name: "docs", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
			{ id: "file1", name: "note.md", mimeType: "text/plain", parents: ["f1"], modifiedTime: "2024-01-01T00:00:00.000Z", size: "100" },
		];
		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue(allFiles),
			getChangesStartToken: vi.fn().mockResolvedValue("token-abc"),
		} as never;

		const store = new MetadataStore<DriveFile>("persist-test", { dbNamePrefix: "air-sync-drive", version: 1 });

		// First instance: fullScan populates the in-memory cache; persistence is
		// deferred to the checkpoint commit (a clean cycle), not eager.
		const fs1 = new GoogleDriveFs(mockClient, "root", undefined, store);
		const files1 = await fs1.list();
		expect(files1).toHaveLength(2);
		await fs1.commitCheckpoint();

		// Second instance: should load from IDB, no fullScan needed
		const listAllFilesSpy = vi.fn();
		const mockClient2 = {
			listAllFiles: listAllFilesSpy,
			getChangesStartToken: vi.fn(),
			listChanges: vi.fn().mockResolvedValue({ changes: [], newStartPageToken: "token-abc" }),
		} as never;
		const fs2 = new GoogleDriveFs(mockClient2, "root", undefined, store);
		// createFs seeds the cursor from settings.backendData (#3, the committed value).
		fs2.changesPageToken = "token-abc";
		const files2 = await fs2.list();

		expect(files2).toHaveLength(2);
		expect(files2.map((f) => f.path).sort()).toEqual(["docs", "docs/note.md"]);
		// listAllFiles should NOT have been called (loaded from cache)
		expect(listAllFilesSpy).not.toHaveBeenCalled();
		// The #3 cursor is the single source of truth — never clobbered by #2.
		expect(fs2.changesPageToken).toBe("token-abc");

		await store.close();
	});


});

/**
 * Cursor crash-safety (ARCHITECTURE.md principle #5). The remote cursor is a
 * single source of truth in settings.backendData (#3), committed only after a
 * fully-successful pipeline. The metadata store (#2) caches only the file map.
 * After an interrupted sync, a fresh FS seeded with the last *committed* cursor
 * must re-report the un-pulled change (delta replay), and must not be polluted
 * by an eagerly-advanced #2 token.
 */
describe("GoogleDriveFs cursor consolidation (crash safety)", () => {
	const FOLDER = "application/vnd.google-apps.folder";

	it("re-reports an un-pulled remote change after a crash (cursor from #3)", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { MetadataStore } = await import("../../store/metadata-store");
		const store = new MetadataStore<DriveFile>("crash-consol", { dbNamePrefix: "air-sync-drive", version: 1 });

		const change = {
			type: "file",
			fileId: "file1",
			removed: false,
			file: { id: "file1", name: "a.md", mimeType: "text/plain", parents: ["f1"], modifiedTime: "2024-06-01T00:00:00.000Z" },
		};

		// Session 1: initial scan at "token-A"; an incremental change advances the
		// FS cursor to "token-B" — but the pull is "lost" (process killed before the
		// orchestrator commits the new cursor to #3).
		const client1 = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "f1", name: "notes", mimeType: FOLDER, parents: ["root"] },
				{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["f1"], modifiedTime: "2024-05-01T00:00:00.000Z" },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token-A"),
			listChanges: vi.fn().mockResolvedValue({ changes: [change], newStartPageToken: "token-B" }),
		} as never;
		const fs1 = new GoogleDriveFs(client1, "root", undefined, store);
		await fs1.list();
		await fs1.commitCheckpoint(); // initial scan is a clean cycle → baseline persisted at token-A
		const delta1 = await fs1.getChangedPaths();
		expect(delta1!.modified).toContain("notes/a.md"); // detected in-memory (cursor now token-B)
		// CRASH: the change is NOT committed (commitCheckpoint not called for this cycle),
		// so the #2 cache stays at token-A's baseline.

		// Session 2 (restart): a fresh FS seeded with the last COMMITTED cursor "token-A".
		const listChanges2 = vi.fn().mockResolvedValue({ changes: [change], newStartPageToken: "token-B" });
		const listAllFiles2 = vi.fn().mockResolvedValue([
			{ id: "f1", name: "notes", mimeType: FOLDER, parents: ["root"] },
			{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["f1"], modifiedTime: "2024-05-01T00:00:00.000Z" },
		]);
		const client2 = {
			listAllFiles: listAllFiles2,
			getChangesStartToken: vi.fn(),
			listChanges: listChanges2,
		} as never;
		const fs2 = new GoogleDriveFs(client2, "root", undefined, store);
		fs2.changesPageToken = "token-A"; // seeded from #3 (pre-crash committed value)

		const delta2 = await fs2.getChangedPaths();
		expect(delta2!.modified).toContain("notes/a.md"); // re-reported via replay from #3
		expect(listChanges2).toHaveBeenCalledWith("token-A", undefined); // incremental FROM #3, not #2's token-B
		expect(listAllFiles2).not.toHaveBeenCalled(); // file map restored from #2 cache, no network re-list

		await store.close();
	});

	it("re-reports an un-pulled remote DELETION after a crash (cache must not absorb it early)", async () => {
		// The hard case the modify test above doesn't cover: a remote deletion. If the
		// cache is persisted the moment the delta is applied (eager), a crash before the
		// cursor commits loads a cache that already dropped the file, and the replay from
		// the committed cursor early-returns on the now-absent path — the deletion is lost
		// forever. commit-last persistence keeps #2 at the committed cursor so the replay
		// still sees the file and re-surfaces the delete.
		const { GoogleDriveFs } = await import("./index");
		const { MetadataStore } = await import("../../store/metadata-store");
		const store = new MetadataStore<DriveFile>("crash-consol-del", { dbNamePrefix: "air-sync-drive", version: 1 });

		const initialFiles = [
			{ id: "f1", name: "notes", mimeType: FOLDER, parents: ["root"] },
			{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["f1"], modifiedTime: "2024-05-01T00:00:00.000Z" },
		];
		const delChange = { type: "file", fileId: "file1", removed: true, file: undefined };

		// Session 1: initial scan at token-A (committed), then a remote DELETE advances
		// the cursor to token-B in memory — but the cycle is killed before it commits.
		const client1 = {
			listAllFiles: vi.fn().mockResolvedValue(initialFiles),
			getChangesStartToken: vi.fn().mockResolvedValue("token-A"),
			listChanges: vi.fn().mockResolvedValue({ changes: [delChange], newStartPageToken: "token-B" }),
		} as never;
		const fs1 = new GoogleDriveFs(client1, "root", undefined, store);
		await fs1.list();
		await fs1.commitCheckpoint(); // initial scan committed → #2 holds a.md at token-A
		const delta1 = await fs1.getChangedPaths();
		expect(delta1!.deleted).toContain("notes/a.md"); // detected in-memory
		// CRASH: deletion NOT committed → #2 must still hold a.md.

		// Session 2 (restart): fresh FS seeded with the committed cursor token-A.
		const listAllFiles2 = vi.fn().mockResolvedValue(initialFiles);
		const client2 = {
			listAllFiles: listAllFiles2,
			getChangesStartToken: vi.fn(),
			listChanges: vi.fn().mockResolvedValue({ changes: [delChange], newStartPageToken: "token-B" }),
		} as never;
		const fs2 = new GoogleDriveFs(client2, "root", undefined, store);
		fs2.changesPageToken = "token-A";

		const delta2 = await fs2.getChangedPaths();
		expect(delta2!.deleted).toContain("notes/a.md"); // re-detected via replay (would be lost under eager persist)
		expect(listAllFiles2).not.toHaveBeenCalled(); // replayed from the #2 cache, no re-scan

		await store.close();
	});

	it("treats an empty store as no checkpoint: full-scans fresh and warrants no replay", async () => {
		// The cursor lives WITH the cache now (ADR 0001), committed in one transaction.
		// So there is no "cursor survives, cache empty" state to preserve: an empty store
		// means no committed checkpoint, and the FS does a fresh full scan. Losing the
		// cursor is safe — the next cold reconcile re-derives every change from the
		// SyncRecord baseline.
		const { GoogleDriveFs } = await import("./index");
		const { MetadataStore } = await import("../../store/metadata-store");
		const store = new MetadataStore<DriveFile>("edge-empty-cache", { dbNamePrefix: "air-sync-drive", version: 1 });

		const listAllFiles = vi.fn().mockResolvedValue([
			{ id: "f1", name: "notes", mimeType: FOLDER, parents: ["root"] },
		]);
		const client = {
			listAllFiles,
			getChangesStartToken: vi.fn().mockResolvedValue("token-fresh"),
			listChanges: vi.fn(),
		} as never;

		const fs = new GoogleDriveFs(client, "root", undefined, store);
		// A stale in-memory value must NOT masquerade as a committed checkpoint — the
		// checkpoint is read from the (empty) store.
		fs.changesPageToken = "token-X";
		expect(await fs.hasCheckpoint()).toBe(false);

		const delta = await fs.getChangedPaths();

		expect(listAllFiles).toHaveBeenCalledOnce(); // rebuilt via a fresh full scan
		expect(delta).toBeNull(); // fresh scan ⇒ no replay warranted
		expect(fs.changesPageToken).toBe("token-fresh"); // freshly acquired, not the stale "token-X"
		expect(await fs.hasCheckpoint()).toBe(true); // now initialized with a fresh cursor

		await store.close();
	});

	it("restores an empty-but-synced vault's checkpoint (cursor present, 0 files) without re-scanning", async () => {
		// Cursor presence — not file count — is the checkpoint signal: a vault that
		// legitimately synced down to zero files must load its cursor and replay, not
		// re-full-scan every session. This also keeps loadFromCache and hasCheckpoint
		// keyed identically on the cursor (ADR 0001).
		const { GoogleDriveFs } = await import("./index");
		const { MetadataStore } = await import("../../store/metadata-store");
		const store = new MetadataStore<DriveFile>("empty-synced", { dbNamePrefix: "air-sync-drive", version: 1 });

		// Session 1: an empty remote vault — fullScan finds 0 files but acquires a cursor.
		const client1 = {
			listAllFiles: vi.fn().mockResolvedValue([]),
			getChangesStartToken: vi.fn().mockResolvedValue("token-A"),
			getFile: vi.fn().mockResolvedValue({ id: "root", name: "vault", mimeType: FOLDER }),
		} as never;
		const fs1 = new GoogleDriveFs(client1, "root", undefined, store);
		await fs1.list();
		await fs1.commitCheckpoint(); // persist {0 files, cursor token-A} atomically

		// Session 2: a fresh FS over the same store restores the checkpoint and replays —
		// no re-scan — even though the file map is empty.
		const listAllFiles2 = vi.fn();
		const client2 = {
			listAllFiles: listAllFiles2,
			getChangesStartToken: vi.fn(),
			listChanges: vi.fn().mockResolvedValue({ changes: [], newStartPageToken: "token-A" }),
		} as never;
		const fs2 = new GoogleDriveFs(client2, "root", undefined, store);
		expect(await fs2.hasCheckpoint()).toBe(true); // cursor present in the store
		await fs2.getChangedPaths(); // replays from token-A
		expect(listAllFiles2).not.toHaveBeenCalled(); // restored from cache, no re-scan

		await store.close();
	});

	it("resetCheckpoint clears the persisted checkpoint so a fresh FS full-scans", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { MetadataStore } = await import("../../store/metadata-store");
		const store = new MetadataStore<DriveFile>("reset-cp", { dbNamePrefix: "air-sync-drive", version: 1 });

		const initialFiles = [{ id: "f1", name: "notes", mimeType: FOLDER, parents: ["root"] }];
		const client = {
			listAllFiles: vi.fn().mockResolvedValue(initialFiles),
			getChangesStartToken: vi.fn().mockResolvedValue("token-A"),
			listChanges: vi.fn().mockResolvedValue({ changes: [], newStartPageToken: "token-A" }),
			getFile: vi.fn().mockResolvedValue({ id: "root", name: "vault", mimeType: FOLDER }),
		} as never;
		const fs = new GoogleDriveFs(client, "root", undefined, store);
		await fs.list();
		await fs.commitCheckpoint();
		expect(await fs.hasCheckpoint()).toBe(true);

		await fs.resetCheckpoint();
		// In-memory checkpoint gone…
		expect(await fs.hasCheckpoint()).toBe(false);

		// …and the persisted store too: a fresh FS finds no checkpoint and full-scans.
		const fs2 = new GoogleDriveFs(client, "root", undefined, store);
		expect(await fs2.hasCheckpoint()).toBe(false);

		await store.close();
	});

	it("exposes the checkpoint lifecycle via fs.checkpoint — the path the sync engine uses", async () => {
		// The orchestrator/change-detector reach the lifecycle through `fs.checkpoint?.…`,
		// never the methods at the FS root. Every other test drives them directly on the
		// concrete class, so this is the only coverage that the `get checkpoint()` accessor
		// is wired up (returns a capability exposing all four methods).
		const { GoogleDriveFs } = await import("./index");
		const client = {
			listAllFiles: vi.fn().mockResolvedValue([]),
			getChangesStartToken: vi.fn().mockResolvedValue("token-A"),
			listChanges: vi.fn().mockResolvedValue({ changes: [], newStartPageToken: "token-A" }),
			getFile: vi.fn().mockResolvedValue({ id: "root", name: "vault", mimeType: FOLDER }),
		} as never;
		const fs = new GoogleDriveFs(client, "root", undefined, undefined);
		expect(fs.checkpoint).toBeDefined();
		expect(typeof fs.checkpoint?.getChangedPaths).toBe("function");
		expect(typeof fs.checkpoint?.hasCheckpoint).toBe("function");
		expect(typeof fs.checkpoint?.resetCheckpoint).toBe("function");
		expect(typeof fs.checkpoint?.commitCheckpoint).toBe("function");
	});
});

describe("GoogleDriveFs.getChangedPaths", () => {
	it("returns modified and deleted paths on successful incremental changes", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "f1", name: "notes", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "file1", name: "keep.md", mimeType: "text/plain", parents: ["f1"] },
				{ id: "file2", name: "remove.md", mimeType: "text/plain", parents: ["f1"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					// file1 (keep.md) is modified
					{
						type: "file",
						fileId: "file1",
						removed: false,
						file: { id: "file1", name: "keep.md", mimeType: "text/plain", parents: ["f1"], modifiedTime: "2024-06-01T00:00:00.000Z" },
					},
					// file2 (remove.md) is deleted
					{ type: "file", fileId: "file2", removed: true },
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		const result = await fs.getChangedPaths();

		expect(result).not.toBeNull();
		expect(result!.modified).toContain("notes/keep.md");
		expect(result!.deleted).toContain("notes/remove.md");
	});

	it("returns null when not initialized (triggers full scan)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const listAllFiles = vi.fn().mockResolvedValue([
			{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["root"] },
		]);
		const mockClient = {
			listAllFiles,
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		// Do NOT call list() first — fs is not initialized

		const result = await fs.getChangedPaths();

		// null means a full scan was performed
		expect(result).toBeNull();
		// Full scan should have initialized the fs
		expect(listAllFiles).toHaveBeenCalledOnce();
	});

	it("returns delta on 410 fallback (token expired)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const httpError = { status: 410, message: "Gone" };
		const listAllFiles = vi.fn().mockResolvedValue([
			{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["root"] },
		]);
		const mockClient = {
			listAllFiles,
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockRejectedValue(httpError),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		const result = await fs.getChangedPaths();

		// 410 triggers full scan with delta (no changes since cache matches)
		expect(result).not.toBeNull();
		expect(result?.modified).toEqual([]);
		expect(result?.deleted).toEqual([]);
		// A second full scan should have been triggered
		expect(listAllFiles).toHaveBeenCalledTimes(2);
	});

	it("propagates auth errors from the Drive API", async () => {
		const { GoogleDriveFs } = await import("./index");

		const authError = { status: 401, message: "Unauthorized" };
		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["root"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockRejectedValue(authError),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		await expect(fs.getChangedPaths()).rejects.toEqual(authError);
	});
});

describe("GoogleDriveFs ignores .airsync/metadata.json (backend-internal)", () => {
	const FOLDER = "application/vnd.google-apps.folder";

	function makeFs() {
		const uploadFile = vi.fn();
		const deleteFile = vi.fn();
		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "n", name: "note.md", mimeType: "text/plain", parents: ["root"] },
				{ id: "airsync", name: ".airsync", mimeType: FOLDER, parents: ["root"] },
				{ id: "meta", name: "metadata.json", mimeType: "application/json", parents: ["airsync"] },
				{ id: "logs", name: "logs", mimeType: FOLDER, parents: ["airsync"] },
				{ id: "log1", name: "d.log", mimeType: "text/plain", parents: ["logs"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			uploadFile,
			deleteFile,
		} as never;
		return { mockClient, uploadFile, deleteFile };
	}

	it("hides metadata.json from list() but keeps logs and user files", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { mockClient } = makeFs();
		const fs = new GoogleDriveFs(mockClient, "root");

		const paths = (await fs.list()).map((e) => e.path);

		expect(paths).not.toContain(".airsync/metadata.json");
		expect(paths).toContain("note.md");
		expect(paths).toContain(".airsync/logs/d.log");
	});

	it("returns null from stat() for metadata.json but resolves logs", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { mockClient } = makeFs();
		const fs = new GoogleDriveFs(mockClient, "root");

		expect(await fs.stat(".airsync/metadata.json")).toBeNull();
		expect(await fs.stat(".airsync/logs/d.log")).not.toBeNull();
	});

	it("throws from read() for metadata.json (never pulled)", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { mockClient } = makeFs();
		const fs = new GoogleDriveFs(mockClient, "root");

		await expect(fs.read(".airsync/metadata.json")).rejects.toThrow();
	});

	it("refuses to write metadata.json (never pushed through the FS layer)", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { mockClient, uploadFile } = makeFs();
		const fs = new GoogleDriveFs(mockClient, "root");

		const content = new TextEncoder().encode("{}").buffer.slice(0);
		await expect(fs.write(".airsync/metadata.json", content, 123)).rejects.toThrow();
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("ignores delete: delete() does not call the Drive API", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { mockClient, deleteFile } = makeFs();
		const fs = new GoogleDriveFs(mockClient, "root");

		await fs.delete(".airsync/metadata.json");

		expect(deleteFile).not.toHaveBeenCalled();
	});

	it("omits metadata.json from listDir of .airsync (cache never ingests it)", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { mockClient } = makeFs();
		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list(); // populate cache

		const children = (await fs.listDir(".airsync")).map((e) => e.path);
		expect(children).not.toContain(".airsync/metadata.json");
		expect(children).toContain(".airsync/logs");
	});
});
