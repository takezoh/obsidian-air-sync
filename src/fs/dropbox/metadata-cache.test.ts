import { describe, it, expect } from "vitest";
import { DropboxMetadataCache } from "./metadata-cache";
import { dbxFile, dbxFolder } from "./test-helpers";

function makeCache() {
	return new DropboxMetadataCache("/root");
}

describe("DropboxMetadataCache.relativize", () => {
	it("relativizes an absolute path under the root, preserving display casing", () => {
		const cache = makeCache();
		expect(cache.relativize({ path_lower: "/root/notes/a.md", path_display: "/root/Notes/A.md" })).toBe("Notes/A.md");
	});

	it("matches the root case-insensitively", () => {
		const cache = new DropboxMetadataCache("/Root/Vault");
		expect(cache.relativize({ path_lower: "/root/vault/x.md", path_display: "/Root/Vault/x.md" })).toBe("x.md");
	});

	it("returns '' for the root folder itself and null for outside paths", () => {
		const cache = makeCache();
		expect(cache.relativize({ path_lower: "/root", path_display: "/root" })).toBe("");
		expect(cache.relativize({ path_lower: "/other/x.md", path_display: "/other/x.md" })).toBeNull();
	});
});

describe("DropboxMetadataCache.buildFromFiles", () => {
	it("builds a path tree from a flat recursive listing", () => {
		const cache = makeCache();
		cache.buildFromFiles([
			dbxFolder("2", "/root/dir"),
			dbxFile("1", "/root/a.md"),
			dbxFile("3", "/root/dir/b.md"),
		]);
		expect(cache.size).toBe(3);
		expect(cache.isFolder("dir")).toBe(true);
		expect([...cache.getChildren("")!]).toEqual(expect.arrayContaining(["a.md", "dir"]));
		expect([...cache.getChildren("dir")!]).toEqual(["dir/b.md"]);
	});

	it("skips deleted tombstones and the root folder entry", () => {
		const cache = makeCache();
		cache.buildFromFiles([
			dbxFolder("0", "/root"),
			{ ".tag": "deleted", name: "x.md", path_lower: "/root/x.md", path_display: "/root/x.md" },
			dbxFile("1", "/root/keep.md"),
		]);
		expect(cache.size).toBe(1);
		expect(cache.hasFile("keep.md")).toBe(true);
	});
});

describe("DropboxMetadataCache.removeTree / rewriteChildPaths", () => {
	it("removeTree drops an entry and all descendants", () => {
		const cache = makeCache();
		cache.buildFromFiles([dbxFolder("2", "/root/dir"), dbxFile("3", "/root/dir/b.md")]);
		cache.removeTree("dir");
		expect(cache.hasFile("dir")).toBe(false);
		expect(cache.hasFile("dir/b.md")).toBe(false);
		expect(cache.getPathById("id:3")).toBeUndefined();
	});

	it("rewriteChildPaths reparents descendants and their id index", () => {
		const cache = makeCache();
		cache.buildFromFiles([dbxFolder("2", "/root/dir"), dbxFile("3", "/root/dir/b.md")]);
		cache.removeEntry("dir");
		cache.setEntry("renamed", dbxFolder("2", "/root/renamed"));
		cache.rewriteChildPaths("dir", "renamed");
		expect(cache.hasFile("renamed/b.md")).toBe(true);
		expect(cache.hasFile("dir/b.md")).toBe(false);
		expect(cache.getPathById("id:3")).toBe("renamed/b.md");
	});
});

describe("DropboxMetadataCache.setEntry id eviction", () => {
	it("evicts the prior id when a path is overwritten by a different id", () => {
		const cache = makeCache();
		cache.setEntry("a.md", dbxFile("1", "/root/a.md"));
		cache.setEntry("a.md", dbxFile("2", "/root/a.md")); // same path, different id
		expect(cache.getPathById("id:1")).toBeUndefined();
		expect(cache.getPathById("id:2")).toBe("a.md");
	});

	it("evicts the old subtree when a folder is replaced by a different entry at the same path (no tombstone)", () => {
		const cache = makeCache();
		cache.buildFromFiles([
			dbxFolder("d1", "/root/data"),
			dbxFile("c1", "/root/data/child.txt"),
		]);

		// A delta upserts a FILE at "data" with a different id and NO preceding delete.
		cache.setEntry("data", dbxFile("f9", "/root/data"));

		expect(cache.getFile("data")?.id).toBe("id:f9");
		expect(cache.isFolder("data")).toBe(false);
		// The displaced folder's descendant is gone, not orphaned as a phantom path.
		expect(cache.hasFile("data/child.txt")).toBe(false);
		expect(cache.getPathById("id:d1")).toBeUndefined();
		expect(cache.getPathById("id:c1")).toBeUndefined();
	});
});
