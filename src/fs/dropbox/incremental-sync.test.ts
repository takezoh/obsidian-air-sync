import { describe, it, expect, vi } from "vitest";
import { DropboxMetadataCache } from "./metadata-cache";
import { applyDropboxDelta } from "./incremental-sync";
import type { DropboxClient } from "./client";
import type { DropboxListFolderResponse } from "./types";
import { DropboxApiError } from "./types";
import { dbxFile, dbxFolder, dbxDeleted } from "./test-helpers";

vi.mock("obsidian");

/**
 * Split a delta's changedPaths into modified (still cached) vs deleted (gone) —
 * mirrors how CachingRemoteFs classifies them after applyDropboxDelta runs. (The
 * classification moved to the base; this local helper keeps these unit tests focused
 * on the Dropbox delta's effect on the cache + the changedPaths set.)
 */
function classify(cache: DropboxMetadataCache, changedPaths: Set<string>) {
	const modified: string[] = [];
	const deleted: string[] = [];
	for (const path of changedPaths) (cache.hasFile(path) ? modified : deleted).push(path);
	return { modified, deleted };
}

/** A DropboxClient stub whose `listFolderContinue` replays staged pages. */
function fakeClient(pages: DropboxListFolderResponse[]): DropboxClient {
	let i = 0;
	return {
		listFolderContinue: () => {
			const page = pages[i++];
			if (!page) throw new Error("no more pages");
			return Promise.resolve(page);
		},
	} as unknown as DropboxClient;
}

/** A DropboxClient stub whose `listFolderContinue` throws a cursor reset. */
function resetClient(): DropboxClient {
	return {
		listFolderContinue: () => {
			throw new DropboxApiError("reset", 409, "reset/...");
		},
	} as unknown as DropboxClient;
}

function seededCache() {
	const cache = new DropboxMetadataCache("/root");
	cache.buildFromFiles([
		dbxFile("1", "/root/a.md"),
		dbxFolder("2", "/root/dir"),
		dbxFile("3", "/root/dir/b.md"),
	]);
	return cache;
}

function page(entries: DropboxListFolderResponse["entries"], cursor = "next"): DropboxListFolderResponse {
	return { entries, cursor, has_more: false };
}

describe("applyDropboxDelta — official algorithm", () => {
	it("upserts files/folders and removes deleted subtrees", async () => {
		const cache = seededCache();
		const client = fakeClient([page([dbxFile("4", "/root/c.md"), dbxDeleted("/root/dir")])]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(result.newToken).toBe("next");
		expect(cache.hasFile("c.md")).toBe(true);
		expect(cache.hasFile("dir")).toBe(false);
		expect(cache.hasFile("dir/b.md")).toBe(false);

		const delta = classify(cache, result.changedPaths);
		expect(delta.modified).toContain("c.md");
		expect(delta.deleted).toEqual(expect.arrayContaining(["dir", "dir/b.md"]));
	});

	it("coalesces a same-id move into a rename and ignores the stale deleted(old)", async () => {
		const cache = seededCache();
		// Add-first ordering (the delete-first twin is covered below); either way the
		// drained delta is normalized to upserts-before-deletes, so deleted(old) is stale.
		const client = fakeClient([page([dbxFile("1", "/root/renamed.md"), dbxDeleted("/root/a.md")])]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(cache.hasFile("renamed.md")).toBe(true);
		expect(cache.hasFile("a.md")).toBe(false);
		expect(cache.getPathById("id:1")).toBe("renamed.md");
		expect(result.renamedPaths).toEqual([{ oldPath: "a.md", newPath: "renamed.md", isFolder: undefined }]);
	});

	it("rewrites child paths when a folder is renamed via the same id", async () => {
		const cache = seededCache();
		const client = fakeClient([page([dbxFolder("2", "/root/papers")])]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(cache.hasFile("papers")).toBe(true);
		expect(cache.hasFile("papers/b.md")).toBe(true);
		expect(cache.hasFile("dir/b.md")).toBe(false);
		expect(result.renamedPaths).toEqual([{ oldPath: "dir", newPath: "papers", isFolder: true }]);
	});

	// ── Order-independence (ADR 0006): Dropbox does not guarantee the moved entry
	// precedes the deleted(old) tombstone. These pin the DELETE-FIRST ordering, which
	// before the upserts-before-deletes reorder degraded a folder rename to a
	// file-by-file delete+pull of the whole subtree.

	it("coalesces a file rename even when deleted(old) arrives BEFORE the moved file", async () => {
		const cache = seededCache();
		// deleted(old) first, then the same-id add at the new path.
		const client = fakeClient([page([dbxDeleted("/root/a.md"), dbxFile("1", "/root/renamed.md")])]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(cache.hasFile("renamed.md")).toBe(true);
		expect(cache.hasFile("a.md")).toBe(false);
		expect(cache.getPathById("id:1")).toBe("renamed.md");
		expect(result.renamedPaths).toEqual([{ oldPath: "a.md", newPath: "renamed.md", isFolder: undefined }]);
	});

	it("coalesces a folder rename even when deleted(old) arrives BEFORE the moved folder", async () => {
		const cache = seededCache();
		// The reported bug's ordering: deleted(old folder) precedes the moved folder.
		const client = fakeClient([page([dbxDeleted("/root/dir"), dbxFolder("2", "/root/papers")])]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(cache.hasFile("papers")).toBe(true);
		expect(cache.hasFile("papers/b.md")).toBe(true);
		expect(cache.hasFile("dir")).toBe(false);
		expect(cache.hasFile("dir/b.md")).toBe(false);
		// One folder rename pair — NOT a per-file delete+add of the subtree.
		expect(result.renamedPaths).toEqual([{ oldPath: "dir", newPath: "papers", isFolder: true }]);
	});

	it("coalesces a folder rename when its child upsert is listed before the parent folder", async () => {
		const cache = seededCache();
		// Adversarial ordering: child add, then the old-folder delete, then the parent add.
		const client = fakeClient([
			page([
				dbxFile("3", "/root/papers/b.md"),
				dbxDeleted("/root/dir"),
				dbxFolder("2", "/root/papers"),
			]),
		]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(cache.hasFile("papers")).toBe(true);
		expect(cache.hasFile("papers/b.md")).toBe(true);
		expect(cache.hasFile("dir")).toBe(false);
		// The folder rename is reported once; the child does not produce a second pair.
		expect(result.renamedPaths).toEqual([{ oldPath: "dir", newPath: "papers", isFolder: true }]);
	});

	it("does NOT coalesce delete-then-recreate at the same path with a DIFFERENT id", async () => {
		const cache = seededCache();
		// Same path, new id: a genuine delete + create, never a rename. The recreated
		// file must survive (the trailing/leading deleted(old) must not drop it).
		const client = fakeClient([page([dbxDeleted("/root/a.md"), dbxFile("99", "/root/a.md")])]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(cache.hasFile("a.md")).toBe(true);
		expect(cache.getPathById("id:99")).toBe("a.md");
		expect(cache.getPathById("id:1")).toBeUndefined();
		expect(result.renamedPaths).toEqual([]);
		const delta = classify(cache, result.changedPaths);
		expect(delta.modified).toContain("a.md"); // surfaced as a content change, not a rename
	});

	it("surfaces an evicted child when a FOLDER is deleted and recreated at the same path with a new id", async () => {
		const cache = seededCache(); // dir(id:2) + dir/b.md(id:3)
		// Delete folder dir and recreate a NEW folder dir (different id) holding a new file.
		// The old child dir/b.md must still surface as a deletion — otherwise the local copy
		// orphans until the next full scan (the eviction happens inside setEntry, which
		// records nothing, and the stale deleted(dir) is guarded out).
		const client = fakeClient([
			page([
				dbxDeleted("/root/dir"),
				dbxFolder("5", "/root/dir"),
				dbxFile("6", "/root/dir/new.md"),
			]),
		]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(cache.getPathById("id:5")).toBe("dir"); // the recreated folder survives
		expect(cache.hasFile("dir/new.md")).toBe(true);
		expect(cache.hasFile("dir/b.md")).toBe(false); // the old child is gone
		expect(result.renamedPaths).toEqual([]); // different id ⇒ not a rename
		const delta = classify(cache, result.changedPaths);
		expect(delta.deleted).toContain("dir/b.md"); // …and reported as deleted, not silently dropped
		expect(delta.modified).toEqual(expect.arrayContaining(["dir", "dir/new.md"]));
	});

	it("surfaces an evicted child when a folder is MOVED onto a path freed by a deleted folder", async () => {
		const cache = new DropboxMetadataCache("/root");
		cache.buildFromFiles([
			dbxFolder("10", "/root/X"),
			dbxFile("11", "/root/X/keep.md"),
			dbxFolder("20", "/root/A"),
			dbxFile("21", "/root/A/c.md"),
		]);
		// Delete folder X, then move folder A onto the freed path X (same-id move A->X).
		// The displaced old child X/keep.md must surface as a deletion — the eviction
		// happens inside applyRename's setEntry, which otherwise records nothing.
		const client = fakeClient([
			page([
				dbxDeleted("/root/X"),
				dbxDeleted("/root/X/keep.md"),
				dbxFolder("20", "/root/X"),
				dbxFile("21", "/root/X/c.md"),
				dbxDeleted("/root/A"),
			]),
		]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(result.renamedPaths).toContainEqual({ oldPath: "A", newPath: "X", isFolder: true });
		expect(cache.getPathById("id:20")).toBe("X");
		expect(cache.hasFile("X/c.md")).toBe(true);
		expect(cache.hasFile("X/keep.md")).toBe(false);
		const delta = classify(cache, result.changedPaths);
		expect(delta.deleted).toContain("X/keep.md");
	});

	it("signals needsFullScan on a cursor reset", async () => {
		const cache = seededCache();
		const result = await applyDropboxDelta({ cache, client: resetClient() }, "cur");
		expect(result.needsFullScan).toBe(true);
	});

	it("throws (does not loop forever) when the server never clears has_more", async () => {
		const { LIST_PAGE_CAP } = await import("./client");
		let calls = 0;
		// Every page advertises another → an unbounded drain without the guard.
		const client = {
			listFolderContinue: () => {
				calls++;
				return Promise.resolve({ entries: [], cursor: `c${calls}`, has_more: true });
			},
		} as unknown as DropboxClient;
		const cache = seededCache();

		await expect(applyDropboxDelta({ cache, client }, "cur")).rejects.toThrow(/pagination exceeded/);
		// Bounded at the cap rather than spinning forever, and it throws (no silent truncation).
		expect(calls).toBe(LIST_PAGE_CAP);
	});

	it("ignores a delta entry for the reserved metadata path (no phantom change, no corrupt record)", async () => {
		const cache = seededCache();
		const client = fakeClient([page([dbxFile("9", "/root/.airsync/metadata.json")])]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(cache.hasFile(".airsync/metadata.json")).toBe(false);
		// The reserved path must not surface as a change of any kind.
		expect(result.changedPaths.has(".airsync/metadata.json")).toBe(false);
		const delta = classify(cache, result.changedPaths);
		expect(delta.modified).not.toContain(".airsync/metadata.json");
		expect(delta.deleted).not.toContain(".airsync/metadata.json");
	});

	it("reports a tracked entry moved outside the vault root as deleted", async () => {
		const cache = seededCache();
		// id:1 (a.md) moves to an absolute path outside /root → relativize === null.
		const client = fakeClient([page([dbxFile("1", "/elsewhere/a.md")])]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(cache.hasFile("a.md")).toBe(false);
		const delta = classify(cache, result.changedPaths);
		expect(delta.deleted).toContain("a.md");
	});
});

// The cursor-expiry full-scan-and-diff-by-id fallback (formerly computeFullScanDelta)
// now lives in CachingRemoteFs.diffById — shared by every backend and exercised by the
// Dropbox crash-safety contract (crash-safety-contract.test.ts) against the real FS.
