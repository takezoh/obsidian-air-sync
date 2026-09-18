import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import { applyIncrementalChanges } from "./incremental-sync";
import type { IncrementalSyncContext } from "./incremental-sync";
import type { GoogleDriveChange, GoogleDriveChangeList, GoogleDriveFile } from "./types";
import { FOLDER_MIME } from "./types";
import { GoogleDriveMetadataCache } from "./metadata-cache";
import type { FileChangeResult } from "./metadata-cache";
import type { GoogleDriveClient } from "./client";
import type { IncrementalChangesResult } from "../caching/remote-fs";

vi.mock("obsidian");

describe("applyIncrementalChanges", () => {
	let listChanges: ReturnType<typeof vi.fn>;
	let getPathById: ReturnType<typeof vi.fn>;
	let collectDescendants: ReturnType<typeof vi.fn>;
	let removeTree: ReturnType<typeof vi.fn>;
	let applyFileChange: ReturnType<typeof vi.fn>;
	let isFolder: ReturnType<typeof vi.fn>;
	let getFile: ReturnType<typeof vi.fn>;
	let applyFileChangeDetectMove: ReturnType<typeof vi.fn>;
	let loggerInfo: ReturnType<typeof vi.fn>;
	let loggerWarn: ReturnType<typeof vi.fn>;
	let mockClient: GoogleDriveClient;
	let mockCache: GoogleDriveMetadataCache;
	let ctx: IncrementalSyncContext;

	beforeEach(() => {
		listChanges = vi.fn();
		getPathById = vi.fn();
		collectDescendants = vi.fn().mockReturnValue([]);
		removeTree = vi.fn();
		applyFileChange = vi.fn();
		isFolder = vi.fn().mockReturnValue(false);
		getFile = vi.fn().mockReturnValue(undefined);
		applyFileChangeDetectMove = vi.fn<(file: GoogleDriveFile) => FileChangeResult>().mockImplementation((file) => {
			const oldPath = (getPathById as (id: string) => string | undefined)(file.id);
			const wasFolderVal = oldPath ? (isFolder as (p: string) => boolean)(oldPath) : false;
			const oldDescendants = (oldPath && wasFolderVal)
				? (collectDescendants as (p: string) => string[])(oldPath) : [];
			(applyFileChange as (f: GoogleDriveFile) => void)(file);
			const newPath = (getPathById as (id: string) => string | undefined)(file.id);
			return { oldPath, newPath, wasFolder: wasFolderVal, oldDescendants };
		});
		loggerInfo = vi.fn();
		loggerWarn = vi.fn();

		mockClient = { listChanges } as unknown as GoogleDriveClient;
		mockCache = {
			getPathById,
			collectDescendants,
			removeTree,
			applyFileChange,
			applyFileChangeDetectMove,
			isFolder,
			getFile,
			// The projection seam a rename producer reads for the pair's identityKey.
			// Scripted `getFile` returns undefined by default, so these cases report no
			// identity — which is what a cache with nothing at that path must report.
			toEntity: (path: string, file: GoogleDriveFile) => ({
				path, pathAuthority: "actual_resolved", identityKey: file.id,
				isDirectory: file.mimeType === FOLDER_MIME, size: 0, mtime: 0, hash: "",
			}),
		} as unknown as GoogleDriveMetadataCache;

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
		const mockFile: GoogleDriveFile = {
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
			renamedPaths: [],
			// The drain now declares its contention facts on every page, including
			// the uncontended case, so the caller never has to infer their absence.
			contended: [],
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
		const mockFile: GoogleDriveFile = {
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
			expect(result.renamedPaths).toEqual([
				{ oldPath: "old/test.txt", newPath: "new/renamed.txt" },
			]);
		}
	});

	it("reports old descendant paths as deleted when folder is moved", async () => {
		const mockFolder: GoogleDriveFile = {
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

		const childFile: GoogleDriveFile = {
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

	it("throws (does not loop forever) when the server never clears nextPageToken", async () => {
		const { LIST_PAGE_CAP } = await import("./client");
		// Every page advertises another page → an unbounded drain without the guard.
		listChanges.mockResolvedValue({
			changes: [],
			nextPageToken: "more",
			newStartPageToken: undefined,
		});

		await expect(applyIncrementalChanges(ctx, "token")).rejects.toThrow(
			/pagination exceeded/,
		);
		// Bounded at the cap rather than spinning forever.
		expect(listChanges).toHaveBeenCalledTimes(LIST_PAGE_CAP);
	});

	it("reports old path as deleted when file is moved outside sync root", async () => {
		const mockFile: GoogleDriveFile = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Entered-folder re-listing — contract-entered-folder-recording and
// contract-gdrive-entered-folder-relisting.
//
// These run against a REAL GoogleDriveMetadataCache("root"), so which entries
// count as "entered" is decided by the production cache's own move/eviction
// partition rather than by a scripted getPathById sequence. Only `listChanges`
// and `listAllFiles` are mocked; they are the two provider requests this step
// makes. The mocked-cache cases above are unrelated and stay as they are.
// ─────────────────────────────────────────────────────────────────────────────

type AppliedDelta = Extract<IncrementalChangesResult, { needsFullScan: false }>;

/** The two provider requests this step makes — mocked with their real signatures. */
type ListChangesFn = (startToken: string, pageToken?: string) => Promise<GoogleDriveChangeList>;
type ListAllFilesFn = (folderId: string) => Promise<GoogleDriveFile[]>;

const FILE_MIME = "text/plain";

function gdFile(id: string, name: string, parentId: string): GoogleDriveFile {
	return { id, name, mimeType: FILE_MIME, trashed: false, parents: [parentId] };
}

function gdFolder(id: string, name: string, parentId: string): GoogleDriveFile {
	return { id, name, mimeType: FOLDER_MIME, trashed: false, parents: [parentId] };
}

/** A `changes.list` upsert carrying the file's current metadata. */
function upsert(file: GoogleDriveFile): GoogleDriveChange {
	return { type: "file", fileId: file.id, removed: false, file };
}

/** A trash tombstone: the change still carries the file, flagged `trashed`. */
function trashedChange(file: GoogleDriveFile): GoogleDriveChange {
	return { type: "file", fileId: file.id, removed: false, file: { ...file, trashed: true } };
}

/**
 * The identity a `list()`/`stat()` of `path` would report — the cache's own entity
 * projection. Rename pairs are asserted against THIS, not against the raw delta id,
 * so a projection that stopped agreeing with the id would fail the case.
 */
function projectedIdentity(cache: GoogleDriveMetadataCache, path: string): string | undefined {
	return cache.toEntity(path, cache.getFile(path)!).identityKey;
}

describe("applyIncrementalChanges — entered-folder re-listing", () => {
	let cache: GoogleDriveMetadataCache;
	let listChanges: Mock<ListChangesFn>;
	let listAllFiles: Mock<ListAllFilesFn>;
	let ctx: IncrementalSyncContext;

	beforeEach(() => {
		cache = new GoogleDriveMetadataCache("root");
		listChanges = vi.fn<ListChangesFn>();
		listAllFiles = vi.fn<ListAllFilesFn>().mockResolvedValue([]);
		ctx = {
			cache,
			client: { listChanges, listAllFiles } as unknown as GoogleDriveClient,
		};
	});

	/** Seed the real cache from a flat file list, exactly as a full scan would. */
	const seed = (...files: GoogleDriveFile[]): void => {
		cache.buildFromFiles(files);
	};

	/** Stage one `changes.list` page per argument; the last page carries the new token. */
	const stagePages = (...pages: GoogleDriveChange[][]): void => {
		pages.forEach((changes, i) => {
			const last = i === pages.length - 1;
			listChanges.mockResolvedValueOnce({
				changes,
				nextPageToken: last ? undefined : `page-${i + 1}`,
				newStartPageToken: last ? "new-token" : undefined,
			});
		});
	};

	/** Stage the subtree listing each folder id answers with (parents before children). */
	const stageListings = (byId: Record<string, GoogleDriveFile[]>): void => {
		listAllFiles.mockImplementation((id) => Promise.resolve(byId[id] ?? []));
	};

	/** The ordered folder ids `listAllFiles` was called with. */
	const listedIds = (): string[] => listAllFiles.mock.calls.map((call) => call[0]);

	const drain = async (): Promise<AppliedDelta> => {
		const result = await applyIncrementalChanges(ctx, "token");
		if (result.needsFullScan) throw new Error("unexpected full-scan fallback");
		return result;
	};

	it("witness-recording-never-tracked: a never-tracked folder entering the root is listed once", async () => {
		seed(gdFile("keep", "keep.md", "root"));
		stagePages([upsert(gdFolder("F", "F", "root"))]);
		stageListings({ F: [gdFile("a", "a.md", "F"), gdFolder("sub", "sub", "F"), gdFile("b", "b.md", "sub")] });

		await drain();

		expect(listedIds()).toEqual(["F"]);
	});

	it("witness-relist-never-tracked: the entered folder's whole subtree is reported and cached", async () => {
		seed(gdFile("keep", "keep.md", "root"));
		stagePages([upsert(gdFolder("F", "F", "root"))]);
		stageListings({ F: [gdFile("a", "a.md", "F"), gdFolder("sub", "sub", "F"), gdFile("b", "b.md", "sub")] });

		const result = await drain();

		expect([...result.changedPaths].sort()).toEqual(["F", "F/a.md", "F/sub", "F/sub/b.md"]);
		for (const path of ["F", "F/a.md", "F/sub", "F/sub/b.md"]) {
			expect(cache.hasFile(path)).toBe(true);
		}
	});

	it("witness-relist-reentry-after-move-out: a folder evicted by a move-out brings its children back on re-entry", async () => {
		seed(gdFolder("F", "F", "root"), gdFile("c", "c.md", "F"));

		stagePages([upsert(gdFolder("F", "F", "outside"))]);
		const movedOut = await drain();
		expect([...movedOut.changedPaths].sort()).toEqual(["F", "F/c.md"]);
		expect(cache.hasFile("F")).toBe(false);

		stagePages([upsert(gdFolder("F", "F", "root"))]);
		stageListings({ F: [gdFile("c", "c.md", "F")] });
		const movedBack = await drain();

		expect([...movedBack.changedPaths].sort()).toEqual(["F", "F/c.md"]);
		expect(cache.hasFile("F/c.md")).toBe(true);
	});

	it("witness-recording-evicted-within-page / witness-relist-evicted-within-page: an ancestor tombstone earlier in the page still leaves the folder entered", async () => {
		seed(gdFolder("A", "A", "root"), gdFolder("F", "F", "A"), gdFile("x", "x.md", "F"));

		// The depth sort applies A (cached depth 1) before F (cached depth 2), so
		// removeTree(A) evicts F and F then applies with no cached path at all.
		stagePages([trashedChange(gdFolder("A", "A", "root")), upsert(gdFolder("F", "F", "root"))]);
		stageListings({ F: [gdFile("x", "x.md", "F")] });

		const result = await drain();

		expect(listedIds()).toEqual(["F"]);
		expect(cache.hasFile("F/x.md")).toBe(true);
		expect(result.changedPaths).toContain("F/x.md");
	});

	it("witness-relist-child-before-parent: a child dropped before its entering parent returns through the listing", async () => {
		seed(gdFile("keep", "keep.md", "root"));
		// Both folders are uncached, so both tie at sort depth 1 and the stable sort
		// keeps S ahead of F: S's parent is unknown when S applies, so S is dropped.
		stagePages([upsert(gdFolder("S", "S", "F")), upsert(gdFolder("F", "F", "root"))]);
		stageListings({ F: [gdFolder("S", "S", "F"), gdFile("b", "b.md", "S")] });

		const result = await drain();

		expect(cache.hasFile("F/S")).toBe(true);
		expect(cache.hasFile("F/S/b.md")).toBe(true);
		expect(result.changedPaths).toContain("F/S");
		expect(result.changedPaths).toContain("F/S/b.md");
	});

	it("witness-relist-stale-path: the listing target resolves the folder's path at drain end", async () => {
		seed(gdFolder("A", "A", "root"));
		stagePages(
			[upsert(gdFolder("F", "F", "A"))],
			[upsert(gdFolder("A", "B", "root"))],
		);
		stageListings({ F: [gdFile("c", "c.md", "F")] });

		const result = await drain();

		expect(listedIds()).toEqual(["F"]);
		expect(cache.hasFile("B/F/c.md")).toBe(true);
		expect(result.changedPaths).toContain("B/F/c.md");
	});

	it("witness-relist-nested: only the topmost entered folder is listed", async () => {
		seed(gdFile("keep", "keep.md", "root"));
		stagePages(
			[upsert(gdFolder("F", "F", "root"))],
			[upsert(gdFolder("S", "S", "F"))],
		);
		// The listing itself introduces another uncached folder; it must not be listed.
		stageListings({ F: [gdFolder("T", "T", "F"), gdFile("t", "t.md", "T")] });

		await drain();

		expect(listedIds()).toEqual(["F"]);
	});

	it("witness-relist-name-prefix-sibling: a sibling whose name prefixes another's is still listed", async () => {
		seed(gdFile("keep", "keep.md", "root"));
		stagePages([upsert(gdFolder("n1", "Notes", "root")), upsert(gdFolder("n2", "Notes2", "root"))]);
		stageListings({ n1: [gdFile("a", "a.md", "n1")], n2: [gdFile("b", "b.md", "n2")] });

		const result = await drain();

		expect(listedIds()).toEqual(["n1", "n2"]);
		expect(cache.hasFile("Notes2/b.md")).toBe(true);
		expect(result.changedPaths).toContain("Notes2/b.md");
	});

	it("witness-relist-left-scope-later: an entered folder trashed later in the drain is never listed", async () => {
		seed(gdFile("keep", "keep.md", "root"));
		stagePages(
			[upsert(gdFolder("F", "F", "root"))],
			[trashedChange(gdFolder("F", "F", "root"))],
		);

		const result = await drain();

		expect(listAllFiles).not.toHaveBeenCalled();
		expect(cache.hasFile("F")).toBe(false);
		expect(result.changedPaths).toContain("F");
	});

	it("witness-relist-no-entered-folder: a delta of plain file upserts issues no listing", async () => {
		seed(gdFile("keep", "keep.md", "root"));
		stagePages([upsert(gdFile("keep", "keep.md", "root"))]);

		await drain();

		expect(listAllFiles).not.toHaveBeenCalled();
	});

	it("witness-recording-tracked-rename: renaming an already-cached folder issues no listing", async () => {
		seed(gdFolder("D", "D", "root"), gdFile("x", "x.md", "D"));
		stagePages([upsert(gdFolder("D", "E", "root"))]);

		const result = await drain();

		expect(listAllFiles).not.toHaveBeenCalled();
		expect(result.renamedPaths).toEqual([
			{ oldPath: "D", newPath: "E", isFolder: true, identityKey: projectedIdentity(cache, "E") },
		]);
		expect(result.renamedPaths[0]?.identityKey).toBe("D");
		expect(cache.hasFile("E/x.md")).toBe(true);
	});

	it("witness-relist-failure: a listing rejection propagates and stops the remaining targets", async () => {
		seed(gdFile("keep", "keep.md", "root"));
		stagePages([upsert(gdFolder("F1", "F1", "root")), upsert(gdFolder("F2", "F2", "root"))]);
		const denied = Object.assign(new Error("permission denied"), { status: 403 });
		listAllFiles.mockRejectedValueOnce(denied);

		await expect(applyIncrementalChanges(ctx, "token")).rejects.toThrow("permission denied");
		expect(listAllFiles).toHaveBeenCalledTimes(1);
	});

	it("witness-relist-sequential: the second listing starts only after the first one merges", async () => {
		seed(gdFile("keep", "keep.md", "root"));
		stagePages([upsert(gdFolder("F1", "F1", "root")), upsert(gdFolder("F2", "F2", "root"))]);
		let releaseFirst: ((files: GoogleDriveFile[]) => void) | undefined;
		const firstListing = new Promise<GoogleDriveFile[]>((resolve) => { releaseFirst = resolve; });
		listAllFiles
			.mockReturnValueOnce(firstListing)
			.mockResolvedValueOnce([gdFile("b", "b.md", "F2")]);

		const pending = applyIncrementalChanges(ctx, "token");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(listAllFiles).toHaveBeenCalledTimes(1);

		releaseFirst?.([gdFile("a", "a.md", "F1")]);
		await pending;

		expect(listedIds()).toEqual(["F1", "F2"]);
		expect(cache.hasFile("F1/a.md")).toBe(true);
		expect(cache.hasFile("F2/b.md")).toBe(true);
	});

	it("witness-relist-grant-subset: an item the grant omits from the listing stays cached", async () => {
		seed(gdFile("keep", "keep.md", "root"));
		stagePages([upsert(gdFolder("F", "F", "root")), upsert(gdFile("d", "d.md", "F"))]);
		stageListings({ F: [gdFile("v", "visible.md", "F")] });

		const result = await drain();

		expect(listAllFiles).toHaveBeenCalledTimes(1);
		expect(cache.hasFile("F/d.md")).toBe(true);
		expect(result.changedPaths).toContain("F/d.md");
		expect(cache.hasFile("F/visible.md")).toBe(true);
	});

	it("witness-relist-descendant-cached-elsewhere: a listed descendant cached elsewhere yields a rename pair", async () => {
		seed(gdFile("c", "C.md", "root"));
		stagePages([upsert(gdFolder("F", "F", "root"))]);
		stageListings({ F: [gdFile("c", "C.md", "F")] });

		const result = await drain();

		expect(result.renamedPaths).toEqual([
			{ oldPath: "C.md", newPath: "F/C.md", isFolder: undefined, identityKey: projectedIdentity(cache, "F/C.md") },
		]);
		expect(result.renamedPaths[0]?.identityKey).toBe("c");
		expect(cache.hasFile("C.md")).toBe(false);
		expect(cache.hasFile("F/C.md")).toBe(true);
	});

	it("carries the drain's standing contentions to the caller", async () => {
		// The delta route is the only route on which a user actually meets this: a
		// second same-named sibling created on drive.google.com. Without this carrier
		// the contention is announced nowhere, so an absence it caused would read as a
		// provider deletion and no repair could ever be planned.
		seed(gdFile("A1", "Test.md", "root"));
		stagePages([upsert(gdFile("B2", "Test.md", "root"))]);

		const result = await drain();

		expect(result.contended).toEqual([{
			path: "Test.md", admittedId: "A1", withheldId: "B2",
			displacedPaths: [], reason: "lowest_stable_id", owesRemediation: true,
		}]);
	});
});
