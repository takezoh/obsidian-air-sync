import { describe, it, expect } from "vitest";
import { PCloudMetadataCache, flattenPCloudListing } from "./metadata-cache";
import { pcFile, pcFolder } from "./test-helpers";

/** A recursive listfolder root: a.md, sub/, sub/b.md */
function makeRoot() {
	return pcFolder(0, "/", 0, [
		pcFile(1, "a.md", 0),
		pcFolder(2, "sub", 0, [pcFile(3, "b.md", 2)]),
	]);
}

// Mirror the production build path (PCloudFs.fullList → flattenPCloudListing →
// the base buildFromFiles), so the cache tests exercise exactly what sync uses.
function makeCache(): PCloudMetadataCache {
	const cache = new PCloudMetadataCache("0");
	cache.buildFromFiles(flattenPCloudListing(makeRoot()));
	return cache;
}

describe("build from a listfolder tree", () => {
	it("builds relative paths from the nested tree", () => {
		const cache = makeCache();
		expect(cache.hasFile("a.md")).toBe(true);
		expect(cache.hasFile("sub")).toBe(true);
		expect(cache.hasFile("sub/b.md")).toBe(true);
		expect(cache.isFolder("sub")).toBe(true);
		expect(cache.isFolder("a.md")).toBe(false);
		expect(cache.size).toBe(3);
	});

	it("maintains a children index and id↔path mapping", () => {
		const cache = makeCache();
		expect(cache.getChildren("")?.has("a.md")).toBe(true);
		expect(cache.getChildren("sub")?.has("sub/b.md")).toBe(true);
		expect(cache.getPathById("f3")).toBe("sub/b.md");
		expect(cache.getPathById("d2")).toBe("sub");
	});
});

describe("resolvePathFromCache", () => {
	it("resolves a top-level entry against the root folderid", () => {
		const cache = makeCache();
		expect(cache.resolvePathFromCache(pcFile(9, "c.md", 0))).toBe("c.md");
	});
	it("resolves a nested entry via its parentfolderid", () => {
		const cache = makeCache();
		expect(cache.resolvePathFromCache(pcFile(9, "c.md", 2))).toBe("sub/c.md");
	});
	it("returns null for an unknown parent (outside the synced subtree)", () => {
		const cache = makeCache();
		expect(cache.resolvePathFromCache(pcFile(9, "c.md", 999))).toBeNull();
	});
});

describe("removeTree", () => {
	it("removes a folder and all descendants", () => {
		const cache = makeCache();
		cache.removeTree("sub");
		expect(cache.hasFile("sub")).toBe(false);
		expect(cache.hasFile("sub/b.md")).toBe(false);
		expect(cache.getPathById("f3")).toBeUndefined();
	});
});

describe("rewriteChildPaths", () => {
	it("rewrites descendant paths when a folder moves", () => {
		const cache = makeCache();
		cache.rewriteChildPaths("sub", "renamed");
		expect(cache.getPathById("f3")).toBe("renamed/b.md");
	});
});

describe("applyFileChange / applyFileChangeDetectMove", () => {
	it("adds a new file resolved under a known folder", () => {
		const cache = makeCache();
		cache.applyFileChange(pcFile(4, "c.md", 2));
		expect(cache.hasFile("sub/c.md")).toBe(true);
	});

	it("detects a folder rename and reports the old path + descendants", () => {
		const cache = makeCache();
		const result = cache.applyFileChangeDetectMove(pcFolder(2, "renamed", 0));
		expect(result.oldPath).toBe("sub");
		expect(result.newPath).toBe("renamed");
		expect(result.wasFolder).toBe(true);
		expect(result.oldDescendants).toContain("sub/b.md");
		// children followed the move
		expect(cache.hasFile("renamed/b.md")).toBe(true);
		expect(cache.hasFile("sub/b.md")).toBe(false);
	});

	it("drops a stale entry when it can no longer resolve under root", () => {
		const cache = makeCache();
		// a.md (fileid 1) reparented to an unknown folder → leaves the subtree
		cache.applyFileChange(pcFile(1, "a.md", 999));
		expect(cache.hasFile("a.md")).toBe(false);
	});
});

describe("id-collision (data-loss guard)", () => {
	it("detects a same-name replace via the diff path without orphaning the old id", () => {
		const cache = makeCache(); // "a.md" = f1
		// modify*/create event resolves a different id onto the occupied path. The
		// occupant (f1) and its subtree are evicted so a later deletefile diff for f1
		// cannot reverse-resolve onto the live path and remove the wrong entry.
		cache.applyFileChange(pcFile(9, "a.md", 0));
		expect(cache.getPathById("f1")).toBeUndefined();
		expect(cache.getFile("a.md")?.id).toBe("f9");

		// ...so a stale delete for f1 can't remove the live entry.
		const stalePath = cache.getPathById("f1");
		if (stalePath) cache.removeTree(stalePath);
		expect(cache.hasFile("a.md")).toBe(true);
		expect(cache.getFile("a.md")?.id).toBe("f9");
	});
});

describe("toEntity", () => {
	it("delegates to pcloudEntryToEntity (opaque checksum for files)", () => {
		const cache = makeCache();
		const entity = cache.toEntity("a.md", cache.getFile("a.md")!);
		expect(entity.remoteChecksum?.algo).toBe("opaque");
		expect(entity.backendMeta).toEqual({ pcloudId: "f1" });
	});
});
