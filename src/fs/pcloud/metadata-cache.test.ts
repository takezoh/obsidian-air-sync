import { describe, it, expect } from "vitest";
import { PCloudMetadataCache } from "./metadata-cache";
import { pcFile, pcFolder } from "./test-helpers";

/** A recursive listfolder root: a.md, sub/, sub/b.md */
function makeRoot() {
	return pcFolder(0, "/", 0, [
		pcFile(1, "a.md", 0),
		pcFolder(2, "sub", 0, [pcFile(3, "b.md", 2)]),
	]);
}

function makeCache(): PCloudMetadataCache {
	const cache = new PCloudMetadataCache("0");
	cache.buildFromListFolder(makeRoot());
	return cache;
}

describe("buildFromListFolder", () => {
	it("builds relative paths from the nested tree", () => {
		const cache = makeCache();
		expect(cache.hasEntry("a.md")).toBe(true);
		expect(cache.hasEntry("sub")).toBe(true);
		expect(cache.hasEntry("sub/b.md")).toBe(true);
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
		expect(cache.hasEntry("sub")).toBe(false);
		expect(cache.hasEntry("sub/b.md")).toBe(false);
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

describe("applyEntryChange / applyEntryDetectMove", () => {
	it("adds a new file resolved under a known folder", () => {
		const cache = makeCache();
		cache.applyEntryChange(pcFile(4, "c.md", 2));
		expect(cache.hasEntry("sub/c.md")).toBe(true);
	});

	it("detects a folder rename and reports the old path + descendants", () => {
		const cache = makeCache();
		const result = cache.applyEntryDetectMove(pcFolder(2, "renamed", 0));
		expect(result.oldPath).toBe("sub");
		expect(result.newPath).toBe("renamed");
		expect(result.wasFolder).toBe(true);
		expect(result.oldDescendants).toContain("sub/b.md");
		// children followed the move
		expect(cache.hasEntry("renamed/b.md")).toBe(true);
		expect(cache.hasEntry("sub/b.md")).toBe(false);
	});

	it("drops a stale entry when it can no longer resolve under root", () => {
		const cache = makeCache();
		// a.md (fileid 1) reparented to an unknown folder → leaves the subtree
		cache.applyEntryChange(pcFile(1, "a.md", 999));
		expect(cache.hasEntry("a.md")).toBe(false);
	});
});

describe("setEntry id-collision (data-loss guard)", () => {
	it("evicts the stale id when a path is overwritten by a different id", () => {
		const cache = makeCache(); // "a.md" is held by f1
		// f9 lands on the same path (e.g. a delete+recreate of the same name
		// collapsed across a diff gap, or a move that frees the name).
		cache.setEntry("a.md", pcFile(9, "a.md", 0));

		// The stale f1 id must no longer reverse-resolve to the live path...
		expect(cache.getPathById("f1")).toBeUndefined();
		expect(cache.getPathById("f9")).toBe("a.md");

		// ...so a later deletefile diff for the old id f1 cannot remove the live entry.
		const stalePath = cache.getPathById("f1");
		if (stalePath) cache.removeTree(stalePath);
		expect(cache.hasEntry("a.md")).toBe(true);
		expect(cache.getEntry("a.md")?.id).toBe("f9");
	});

	it("detects a same-name replace via the diff path without orphaning the old id", () => {
		const cache = makeCache(); // "a.md" = f1
		// modify*/create event resolves a different id onto the occupied path.
		cache.applyEntryChange(pcFile(9, "a.md", 0));
		expect(cache.getPathById("f1")).toBeUndefined();
		expect(cache.getEntry("a.md")?.id).toBe("f9");
	});
});

describe("entryToEntity", () => {
	it("delegates to pcloudEntryToEntity (opaque checksum for files)", () => {
		const cache = makeCache();
		const entity = cache.entryToEntity("a.md", cache.getEntry("a.md")!);
		expect(entity.remoteChecksum?.algo).toBe("opaque");
		expect(entity.backendMeta).toEqual({ pcloudId: "f1" });
	});
});
