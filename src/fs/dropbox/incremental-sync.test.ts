import { describe, it, expect, vi } from "vitest";
import { DropboxMetadataCache } from "./metadata-cache";
import {
	applyDropboxDelta,
	classifyChangedPaths,
	computeFullScanDelta,
} from "./incremental-sync";
import type { DropboxClient } from "./client";
import type { DropboxListFolderResponse } from "./types";
import { DropboxApiError } from "./types";
import { dbxFile, dbxFolder, dbxDeleted } from "./test-helpers";

vi.mock("obsidian");

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
	cache.buildFromEntries([
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

		expect(result.newCursor).toBe("next");
		expect(cache.hasEntry("c.md")).toBe(true);
		expect(cache.hasEntry("dir")).toBe(false);
		expect(cache.hasEntry("dir/b.md")).toBe(false);

		const delta = classifyChangedPaths(cache, result.changedPaths, result.renamedPaths);
		expect(delta.modified).toContain("c.md");
		expect(delta.deleted).toEqual(expect.arrayContaining(["dir", "dir/b.md"]));
	});

	it("coalesces a same-id move into a rename and ignores the stale deleted(old)", async () => {
		const cache = seededCache();
		// The add for the moved file arrives first; the trailing deleted(old) is stale.
		const client = fakeClient([page([dbxFile("1", "/root/renamed.md"), dbxDeleted("/root/a.md")])]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(cache.hasEntry("renamed.md")).toBe(true);
		expect(cache.hasEntry("a.md")).toBe(false);
		expect(cache.getPathById("id:1")).toBe("renamed.md");
		expect(result.renamedPaths).toEqual([{ oldPath: "a.md", newPath: "renamed.md", isFolder: undefined }]);
	});

	it("rewrites child paths when a folder is renamed via the same id", async () => {
		const cache = seededCache();
		const client = fakeClient([page([dbxFolder("2", "/root/papers")])]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(cache.hasEntry("papers")).toBe(true);
		expect(cache.hasEntry("papers/b.md")).toBe(true);
		expect(cache.hasEntry("dir/b.md")).toBe(false);
		expect(result.renamedPaths).toEqual([{ oldPath: "dir", newPath: "papers", isFolder: true }]);
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

		expect(cache.hasEntry(".airsync/metadata.json")).toBe(false);
		// The reserved path must not surface as a change of any kind.
		expect(result.changedPaths.has(".airsync/metadata.json")).toBe(false);
		const delta = classifyChangedPaths(cache, result.changedPaths, result.renamedPaths);
		expect(delta.modified).not.toContain(".airsync/metadata.json");
		expect(delta.deleted).not.toContain(".airsync/metadata.json");
	});

	it("reports a tracked entry moved outside the vault root as deleted", async () => {
		const cache = seededCache();
		// id:1 (a.md) moves to an absolute path outside /root → relativize === null.
		const client = fakeClient([page([dbxFile("1", "/elsewhere/a.md")])]);
		const result = await applyDropboxDelta({ cache, client }, "cur");
		if (result.needsFullScan) throw new Error("unexpected reset");

		expect(cache.hasEntry("a.md")).toBe(false);
		const delta = classifyChangedPaths(cache, result.changedPaths, result.renamedPaths);
		expect(delta.deleted).toContain("a.md");
	});
});

describe("computeFullScanDelta", () => {
	it("derives renames and deletions from a path-by-id snapshot", () => {
		const before = new Map<string, string>([
			["id:1", "a.md"],
			["id:2", "dir"],
			["id:3", "dir/b.md"],
		]);
		const after = new DropboxMetadataCache("/root");
		after.buildFromEntries([
			dbxFile("1", "/root/a.md"), // unchanged
			dbxFolder("2", "/root/dir"),
			dbxFile("3", "/root/dir/renamed.md"), // moved
		]);
		const delta = computeFullScanDelta(before, after);
		expect(delta).not.toBeNull();
		expect(delta!.renamed).toEqual([{ oldPath: "dir/b.md", newPath: "dir/renamed.md", isFolder: undefined }]);
		expect(delta!.deleted).toContain("dir/b.md");
		expect(delta!.modified).toContain("dir/renamed.md");
	});

	it("returns null for an empty prior snapshot", () => {
		expect(computeFullScanDelta(new Map(), new DropboxMetadataCache("/root"))).toBeNull();
	});
});
