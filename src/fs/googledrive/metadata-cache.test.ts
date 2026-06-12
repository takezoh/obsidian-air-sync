import { describe, it, expect, vi } from "vitest";
import { GoogleDriveMetadataCache } from "./metadata-cache";
import type { GoogleDriveFile } from "./types";
import { FOLDER_MIME } from "./types";

function makeGoogleDriveFile(overrides: Partial<GoogleDriveFile> & { id: string; name: string }): GoogleDriveFile {
	return { mimeType: "text/plain", ...overrides };
}

function makeFolder(overrides: Partial<GoogleDriveFile> & { id: string; name: string }): GoogleDriveFile {
	return { ...overrides, mimeType: FOLDER_MIME };
}

const ROOT = "root-id";

function makeCache(logger?: Parameters<typeof GoogleDriveMetadataCache.prototype.applyFileChange>[0] extends GoogleDriveFile ? never : unknown) {
	return new GoogleDriveMetadataCache(ROOT, logger as never);
}

// ── static parentPath ──

describe("GoogleDriveMetadataCache.parentPath", () => {
	it("returns empty string for root-level items", () => {
		expect(GoogleDriveMetadataCache.parentPath("file.txt")).toBe("");
	});

	it("returns parent for one-level nesting", () => {
		expect(GoogleDriveMetadataCache.parentPath("docs/file.txt")).toBe("docs");
	});

	it("returns parent for deep nesting", () => {
		expect(GoogleDriveMetadataCache.parentPath("a/b/c/d.txt")).toBe("a/b/c");
	});
});

// ── empty cache queries ──

describe("empty cache queries", () => {
	it("returns undefined/false/0 for all queries", () => {
		const cache = makeCache();
		expect(cache.getFile("x")).toBeUndefined();
		expect(cache.hasFile("x")).toBe(false);
		expect(cache.isFolder("x")).toBe(false);
		expect(cache.getPathById("id")).toBeUndefined();
		expect(cache.getChildren("x")).toBeUndefined();
		expect(cache.size).toBe(0);
		expect([...cache.entries()]).toEqual([]);
	});
});

// ── setFile ──

describe("setFile", () => {
	it("adds file to all indices", () => {
		const cache = makeCache();
		const file = makeGoogleDriveFile({ id: "f1", name: "a.txt" });
		cache.setFile("a.txt", file);

		expect(cache.getFile("a.txt")).toBe(file);
		expect(cache.hasFile("a.txt")).toBe(true);
		expect(cache.getPathById("f1")).toBe("a.txt");
		expect(cache.size).toBe(1);
	});

	it("registers folders", () => {
		const cache = makeCache();
		cache.setFile("docs", makeFolder({ id: "d1", name: "docs" }));
		expect(cache.isFolder("docs")).toBe(true);
	});

	it("overwrites existing entry", () => {
		const cache = makeCache();
		cache.setFile("a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt" }));
		const updated = makeGoogleDriveFile({ id: "f2", name: "a.txt" });
		cache.setFile("a.txt", updated);

		expect(cache.getFile("a.txt")).toBe(updated);
		expect(cache.getPathById("f2")).toBe("a.txt");
		expect(cache.size).toBe(1);
	});

	it("maintains children index", () => {
		const cache = makeCache();
		cache.setFile("docs", makeFolder({ id: "d1", name: "docs" }));
		cache.setFile("docs/a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt" }));

		const kids = cache.getChildren("docs");
		expect(kids?.has("docs/a.txt")).toBe(true);
	});
});

// ── removeEntry ──

describe("removeEntry", () => {
	it("removes from all indices", () => {
		const cache = makeCache();
		cache.setFile("a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt" }));
		cache.removeEntry("a.txt");

		expect(cache.hasFile("a.txt")).toBe(false);
		expect(cache.getPathById("f1")).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it("cleans up empty children set", () => {
		const cache = makeCache();
		cache.setFile("docs", makeFolder({ id: "d1", name: "docs" }));
		cache.setFile("docs/a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt" }));
		cache.removeEntry("docs/a.txt");

		expect(cache.getChildren("docs")).toBeUndefined();
	});

	it("does not throw for non-existent path", () => {
		const cache = makeCache();
		expect(() => cache.removeEntry("nope")).not.toThrow();
	});
});

// ── bulkLoad ──

describe("bulkLoad", () => {
	it("loads multiple files with correct indices", () => {
		const cache = makeCache();
		cache.bulkLoad([
			["a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt" })],
			["docs", makeFolder({ id: "d1", name: "docs" })],
			["docs/b.txt", makeGoogleDriveFile({ id: "f2", name: "b.txt" })],
		]);

		expect(cache.size).toBe(3);
		expect(cache.isFolder("docs")).toBe(true);
		expect(cache.getChildren("docs")?.has("docs/b.txt")).toBe(true);
	});
});

// ── clear ──

describe("clear", () => {
	it("empties all data structures", () => {
		const cache = makeCache();
		cache.setFile("a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt" }));
		cache.clear();

		expect(cache.size).toBe(0);
		expect(cache.hasFile("a.txt")).toBe(false);
		expect(cache.getPathById("f1")).toBeUndefined();
	});
});

// ── exportRecords ──

describe("exportRecords", () => {
	it("exports with isFolder flag", () => {
		const cache = makeCache();
		cache.setFile("docs", makeFolder({ id: "d1", name: "docs" }));
		cache.setFile("a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt" }));

		const records = cache.exportRecords();
		expect(records).toHaveLength(2);
		const folder = records.find((r) => r.path === "docs");
		const file = records.find((r) => r.path === "a.txt");
		expect(folder?.isFolder).toBe(true);
		expect(file?.isFolder).toBe(false);
	});
});

// ── collectDescendants ──

describe("collectDescendants", () => {
	it("returns empty for leaf node", () => {
		const cache = makeCache();
		cache.setFile("a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt" }));
		expect(cache.collectDescendants("a.txt")).toEqual([]);
	});

	it("returns direct children", () => {
		const cache = makeCache();
		cache.setFile("docs", makeFolder({ id: "d1", name: "docs" }));
		cache.setFile("docs/a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt" }));
		cache.setFile("docs/b.txt", makeGoogleDriveFile({ id: "f2", name: "b.txt" }));

		const desc = cache.collectDescendants("docs");
		expect(desc.sort()).toEqual(["docs/a.txt", "docs/b.txt"]);
	});

	it("returns deeply nested descendants", () => {
		const cache = makeCache();
		cache.setFile("a", makeFolder({ id: "d1", name: "a" }));
		cache.setFile("a/b", makeFolder({ id: "d2", name: "b" }));
		cache.setFile("a/b/c.txt", makeGoogleDriveFile({ id: "f1", name: "c.txt" }));

		const desc = cache.collectDescendants("a");
		expect(desc.sort()).toEqual(["a/b", "a/b/c.txt"]);
	});

	it("returns empty for non-existent path", () => {
		const cache = makeCache();
		expect(cache.collectDescendants("nope")).toEqual([]);
	});
});

// ── findRelevantParentId ──

describe("findRelevantParentId", () => {
	it("prefers rootFolderId", () => {
		const cache = makeCache();
		cache.setFile("docs", makeFolder({ id: "d1", name: "docs" }));
		expect(cache.findRelevantParentId([ROOT, "d1"], { has: (id: string) => cache.hasId(id) })).toBe(ROOT);
	});

	it("falls back to known ID", () => {
		const cache = makeCache();
		cache.setFile("docs", makeFolder({ id: "d1", name: "docs" }));
		const knownIds = { has: (id: string) => id === "d1" };
		expect(cache.findRelevantParentId(["unknown", "d1"], knownIds)).toBe("d1");
	});

	it("returns undefined when no match", () => {
		const cache = makeCache();
		expect(cache.findRelevantParentId(["x", "y"], { has: () => false })).toBeUndefined();
	});
});

// ── resolvePathFromCache ──

describe("resolvePathFromCache", () => {
	it("resolves root-level file", () => {
		const cache = makeCache();
		const file = makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: [ROOT] });
		expect(cache.resolvePathFromCache(file)).toBe("a.txt");
	});

	it("resolves nested file", () => {
		const cache = makeCache();
		cache.setFile("docs", makeFolder({ id: "d1", name: "docs" }));
		const file = makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["d1"] });
		expect(cache.resolvePathFromCache(file)).toBe("docs/a.txt");
	});

	it("returns null for empty parents", () => {
		const cache = makeCache();
		expect(cache.resolvePathFromCache(makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: [] }))).toBeNull();
	});

	it("returns null for unknown parent", () => {
		const cache = makeCache();
		expect(cache.resolvePathFromCache(makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["unknown"] }))).toBeNull();
	});
});

// ── resolveFilePathCached ──

describe("resolveFilePathCached", () => {
	it("memoizes resolved paths", () => {
		const cache = makeCache();
		const parent = makeFolder({ id: "d1", name: "docs", parents: [ROOT] });
		const child = makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["d1"] });
		const byId = new Map([["d1", parent], ["f1", child]]);
		const resolved = new Map<string, string>();

		cache.resolveFilePathCached(child, byId, resolved, new Set());
		expect(resolved.get("f1")).toBe("docs/a.txt");
		expect(resolved.get("d1")).toBe("docs");
	});

	it("detects circular references (A→B→A)", () => {
		const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const cache = new GoogleDriveMetadataCache(ROOT, logger as never);

		const a = makeFolder({ id: "a", name: "folderA", parents: ["b"] });
		const b = makeFolder({ id: "b", name: "folderB", parents: ["a"] });
		const byId = new Map([["a", a], ["b", b]]);

		const path = cache.resolveFilePathCached(a, byId, new Map(), new Set());
		expect(typeof path).toBe("string");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("Circular parent reference"),
			expect.any(Object)
		);
	});

	it("detects self-referencing parent", () => {
		const cache = makeCache();
		const file = makeGoogleDriveFile({ id: "x", name: "self", parents: ["x"] });
		const byId = new Map([["x", file]]);

		const path = cache.resolveFilePathCached(file, byId, new Map(), new Set());
		expect(path).toBe("self");
	});
});

// ── buildFromFiles ──

describe("buildFromFiles", () => {
	it("builds tree from flat list", () => {
		const cache = makeCache();
		cache.buildFromFiles([
			makeFolder({ id: "d1", name: "docs", parents: [ROOT] }),
			makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["d1"] }),
		]);

		expect(cache.size).toBe(2);
		expect(cache.getFile("docs/a.txt")).toBeDefined();
		expect(cache.isFolder("docs")).toBe(true);
	});

	it("handles circular references gracefully", () => {
		const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const cache = new GoogleDriveMetadataCache(ROOT, logger as never);

		cache.buildFromFiles([
			makeFolder({ id: "a", name: "folderA", parents: ["b"] }),
			makeFolder({ id: "b", name: "folderB", parents: ["a"] }),
		]);

		expect(cache.size).toBe(2);
	});
});

// ── rewriteChildPaths ──

describe("rewriteChildPaths", () => {
	it("rewrites direct children", () => {
		const cache = makeCache();
		cache.setFile("old", makeFolder({ id: "d1", name: "old" }));
		cache.setFile("old/a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt" }));

		cache.rewriteChildPaths("old", "new");

		expect(cache.hasFile("old/a.txt")).toBe(false);
		expect(cache.getFile("new/a.txt")).toBeDefined();
		expect(cache.getPathById("f1")).toBe("new/a.txt");
	});

	it("rewrites deeply nested descendants", () => {
		const cache = makeCache();
		cache.setFile("top", makeFolder({ id: "d1", name: "top" }));
		cache.setFile("top/mid", makeFolder({ id: "d2", name: "mid" }));
		cache.setFile("top/mid/leaf.txt", makeGoogleDriveFile({ id: "f1", name: "leaf.txt" }));

		cache.rewriteChildPaths("top", "renamed");

		expect(cache.getFile("renamed/mid")).toBeDefined();
		expect(cache.getFile("renamed/mid/leaf.txt")).toBeDefined();
		expect(cache.isFolder("renamed/mid")).toBe(true);
		expect(cache.getPathById("d2")).toBe("renamed/mid");
		expect(cache.getChildren("renamed")?.has("renamed/mid")).toBe(true);
		expect(cache.getChildren("renamed/mid")?.has("renamed/mid/leaf.txt")).toBe(true);
	});
});

// ── removeTree ──

describe("removeTree", () => {
	it("removes leaf entry", () => {
		const cache = makeCache();
		cache.setFile("a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt" }));
		cache.removeTree("a.txt");

		expect(cache.hasFile("a.txt")).toBe(false);
		expect(cache.size).toBe(0);
	});

	it("removes folder and all descendants recursively", () => {
		const cache = makeCache();
		cache.setFile("a", makeFolder({ id: "d1", name: "a" }));
		cache.setFile("a/b", makeFolder({ id: "d2", name: "b" }));
		cache.setFile("a/b/c.txt", makeGoogleDriveFile({ id: "f1", name: "c.txt" }));
		cache.setFile("a/d.txt", makeGoogleDriveFile({ id: "f2", name: "d.txt" }));

		cache.removeTree("a");

		expect(cache.size).toBe(0);
		expect(cache.getPathById("d1")).toBeUndefined();
		expect(cache.getPathById("d2")).toBeUndefined();
		expect(cache.getPathById("f1")).toBeUndefined();
		expect(cache.getPathById("f2")).toBeUndefined();
		expect(cache.isFolder("a")).toBe(false);
		expect(cache.isFolder("a/b")).toBe(false);
	});
});

// ── toEntity ──

describe("toEntity", () => {
	it("converts file to entity", () => {
		const cache = makeCache();
		const file = makeGoogleDriveFile({ id: "f1", name: "a.txt", modifiedTime: "2024-01-01T00:00:00.000Z", size: "100", md5Checksum: "abc" });
		cache.setFile("a.txt", file);

		const entity = cache.toEntity("a.txt", file);
		expect(entity.path).toBe("a.txt");
		expect(entity.isDirectory).toBe(false);
		expect(entity.size).toBe(100);
		expect(entity.mtime).toBe(new Date("2024-01-01T00:00:00.000Z").getTime());
		expect(entity.hash).toBe("");
		expect(entity.remoteChecksum).toEqual({ algo: "md5", value: "abc" });
		expect(entity.backendMeta?.googleDriveId).toBe("f1");
	});

	it("converts folder to entity", () => {
		const cache = makeCache();
		const folder = makeFolder({ id: "d1", name: "docs" });
		cache.setFile("docs", folder);

		const entity = cache.toEntity("docs", folder);
		expect(entity.isDirectory).toBe(true);
		expect(entity.size).toBe(0);
	});

	it("handles missing modifiedTime, size, md5", () => {
		const cache = makeCache();
		const file = makeGoogleDriveFile({ id: "f1", name: "a.txt" });
		cache.setFile("a.txt", file);

		const entity = cache.toEntity("a.txt", file);
		expect(entity.mtime).toBe(0);
		expect(entity.size).toBe(0);
	});
});

// ── applyFileChange ──

describe("applyFileChange", () => {
	it("adds new file", () => {
		const cache = makeCache();
		cache.setFile("docs", makeFolder({ id: "d1", name: "docs", parents: [ROOT] }));
		const file = makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["d1"] });

		cache.applyFileChange(file);
		expect(cache.getFile("docs/a.txt")).toBe(file);
	});

	it("updates metadata for existing file", () => {
		const cache = makeCache();
		const file = makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: [ROOT], size: "100" });
		cache.setFile("a.txt", file);

		const updated = makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: [ROOT], size: "200" });
		cache.applyFileChange(updated);
		expect(cache.getFile("a.txt")?.size).toBe("200");
	});

	it("handles rename (same parent, different name)", () => {
		const cache = makeCache();
		const file = makeGoogleDriveFile({ id: "f1", name: "old.txt", parents: [ROOT] });
		cache.setFile("old.txt", file);

		const renamed = makeGoogleDriveFile({ id: "f1", name: "new.txt", parents: [ROOT] });
		cache.applyFileChange(renamed);

		expect(cache.hasFile("old.txt")).toBe(false);
		expect(cache.getFile("new.txt")).toBe(renamed);
		expect(cache.getPathById("f1")).toBe("new.txt");
	});

	it("handles move (different parent)", () => {
		const cache = makeCache();
		cache.setFile("docs", makeFolder({ id: "d1", name: "docs", parents: [ROOT] }));
		cache.setFile("archive", makeFolder({ id: "d2", name: "archive", parents: [ROOT] }));
		const file = makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["d1"] });
		cache.setFile("docs/a.txt", file);

		const moved = makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["d2"] });
		cache.applyFileChange(moved);

		expect(cache.hasFile("docs/a.txt")).toBe(false);
		expect(cache.getFile("archive/a.txt")).toBe(moved);
	});

	it("rewrites child paths on folder rename", () => {
		const cache = makeCache();
		cache.setFile("old", makeFolder({ id: "d1", name: "old", parents: [ROOT] }));
		cache.setFile("old/a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["d1"] }));

		const renamed = makeFolder({ id: "d1", name: "new", parents: [ROOT] });
		cache.applyFileChange(renamed);

		expect(cache.hasFile("old")).toBe(false);
		expect(cache.hasFile("old/a.txt")).toBe(false);
		expect(cache.getFile("new")).toBeDefined();
		expect(cache.getFile("new/a.txt")).toBeDefined();
	});

	it("removes stale entry when path cannot be resolved", () => {
		const cache = makeCache();
		const file = makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: [ROOT] });
		cache.setFile("a.txt", file);

		const unresolvable = makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["unknown"] });
		cache.applyFileChange(unresolvable);

		expect(cache.hasFile("a.txt")).toBe(false);
		expect(cache.getPathById("f1")).toBeUndefined();
	});

	it("evicts the old subtree when a folder is replaced by a file at the same path (no tombstone)", () => {
		const cache = makeCache();
		// A folder "data" with a child, then a delta upserts a FILE at "data" with a
		// different id and NO preceding `deleted` tombstone for the old folder.
		cache.setFile("data", makeFolder({ id: "d1", name: "data", parents: [ROOT] }));
		cache.setFile("data/child.txt", makeGoogleDriveFile({ id: "c1", name: "child.txt", parents: ["d1"] }));

		const replacement = makeGoogleDriveFile({ id: "f9", name: "data", parents: [ROOT] });
		cache.applyFileChange(replacement);

		// The new file is installed and the old folder's descendant is gone (not orphaned).
		expect(cache.getFile("data")).toBe(replacement);
		expect(cache.isFolder("data")).toBe(false);
		expect(cache.hasFile("data/child.txt")).toBe(false);
		// The displaced folder's id no longer points anywhere.
		expect(cache.getPathById("d1")).toBeUndefined();
		expect(cache.getPathById("c1")).toBeUndefined();
	});

	it("clears the displaced id when a file is replaced by a different file at the same path", () => {
		const cache = makeCache();
		// Google Drive allows two files with the same name (path) but different ids; a delta
		// for the second displaces the first in the cache.
		cache.setFile("a.txt", makeGoogleDriveFile({ id: "old", name: "a.txt", parents: [ROOT] }));

		const replacement = makeGoogleDriveFile({ id: "new", name: "a.txt", parents: [ROOT] });
		cache.applyFileChange(replacement);

		expect(cache.getFile("a.txt")).toBe(replacement);
		expect(cache.getPathById("new")).toBe("a.txt");
		// The displaced id is no longer mapped to the path.
		expect(cache.getPathById("old")).toBeUndefined();
	});
});

describe("applyFileChangeDetectMove", () => {
	it("detects file rename (same parent, different name)", () => {
		const cache = makeCache();
		cache.setFile("old.txt", makeGoogleDriveFile({ id: "f1", name: "old.txt", parents: [ROOT] }));

		const renamed = makeGoogleDriveFile({ id: "f1", name: "new.txt", parents: [ROOT] });
		const result = cache.applyFileChangeDetectMove(renamed);

		expect(result.oldPath).toBe("old.txt");
		expect(result.newPath).toBe("new.txt");
		expect(result.wasFolder).toBe(false);
		expect(result.oldDescendants).toEqual([]);
	});

	it("detects file move (different parent)", () => {
		const cache = makeCache();
		cache.setFile("docs", makeFolder({ id: "d1", name: "docs", parents: [ROOT] }));
		cache.setFile("archive", makeFolder({ id: "d2", name: "archive", parents: [ROOT] }));
		cache.setFile("docs/a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["d1"] }));

		const moved = makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["d2"] });
		const result = cache.applyFileChangeDetectMove(moved);

		expect(result.oldPath).toBe("docs/a.txt");
		expect(result.newPath).toBe("archive/a.txt");
		expect(result.wasFolder).toBe(false);
	});

	it("detects folder move with descendants", () => {
		const cache = makeCache();
		cache.setFile("src", makeFolder({ id: "d1", name: "src", parents: [ROOT] }));
		cache.setFile("src/a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["d1"] }));
		cache.setFile("src/b.txt", makeGoogleDriveFile({ id: "f2", name: "b.txt", parents: ["d1"] }));
		cache.setFile("lib", makeFolder({ id: "d2", name: "lib", parents: [ROOT] }));

		const moved = makeFolder({ id: "d1", name: "src", parents: ["d2"] });
		const result = cache.applyFileChangeDetectMove(moved);

		expect(result.oldPath).toBe("src");
		expect(result.newPath).toBe("lib/src");
		expect(result.wasFolder).toBe(true);
		expect(result.oldDescendants).toEqual(expect.arrayContaining(["src/a.txt", "src/b.txt"]));
		expect(result.oldDescendants).toHaveLength(2);
	});

	it("returns undefined oldPath for new file", () => {
		const cache = makeCache();

		const file = makeGoogleDriveFile({ id: "f1", name: "new.txt", parents: [ROOT] });
		const result = cache.applyFileChangeDetectMove(file);

		expect(result.oldPath).toBeUndefined();
		expect(result.newPath).toBe("new.txt");
		expect(result.wasFolder).toBe(false);
		expect(result.oldDescendants).toEqual([]);
	});

	it("returns undefined newPath when moved outside sync root", () => {
		const cache = makeCache();
		cache.setFile("a.txt", makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: [ROOT] }));

		const movedOut = makeGoogleDriveFile({ id: "f1", name: "a.txt", parents: ["unknown"] });
		const result = cache.applyFileChangeDetectMove(movedOut);

		expect(result.oldPath).toBe("a.txt");
		expect(result.newPath).toBeUndefined();
		expect(result.wasFolder).toBe(false);
	});
});
