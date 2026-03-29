import { describe, it, expect, beforeEach } from "vitest";
import { LocalChangeTracker } from "./local-tracker";

describe("LocalChangeTracker", () => {
	let tracker: LocalChangeTracker;

	beforeEach(() => {
		tracker = new LocalChangeTracker();
	});

	describe("markDirty", () => {
		it("adds a path to the dirty set", () => {
			tracker.markDirty("notes/hello.md");
			expect(tracker.getDirtyPaths().has("notes/hello.md")).toBe(true);
		});

		it("adding the same path twice results in a single entry", () => {
			tracker.markDirty("a.md");
			tracker.markDirty("a.md");
			expect(tracker.getDirtyPaths().size).toBe(1);
		});

		it("adds multiple distinct paths", () => {
			tracker.markDirty("a.md");
			tracker.markDirty("b.md");
			tracker.markDirty("c.md");
			expect(tracker.getDirtyPaths().size).toBe(3);
		});
	});

	describe("getDirtyPaths", () => {
		it("returns an empty set initially", () => {
			expect(tracker.getDirtyPaths().size).toBe(0);
		});

		it("returns a readonly view of dirty paths", () => {
			tracker.markDirty("a.md");
			const paths = tracker.getDirtyPaths();
			expect(paths.has("a.md")).toBe(true);
		});
	});

	describe("acknowledge", () => {
		it("removes acknowledged paths from the dirty set", () => {
			tracker.markDirty("a.md");
			tracker.markDirty("b.md");
			tracker.acknowledge(["a.md"]);
			expect(tracker.getDirtyPaths().has("a.md")).toBe(false);
			expect(tracker.getDirtyPaths().has("b.md")).toBe(true);
		});

		it("sets initialized to true", () => {
			expect(tracker.isInitialized()).toBe(false);
			tracker.acknowledge([]);
			expect(tracker.isInitialized()).toBe(true);
		});

		it("retains dirty paths not in the acknowledged set", () => {
			tracker.markDirty("a.md");
			tracker.markDirty("b.md");
			tracker.markDirty("c.md");
			tracker.acknowledge(["a.md", "c.md"]);
			expect(tracker.getDirtyPaths().size).toBe(1);
			expect(tracker.getDirtyPaths().has("b.md")).toBe(true);
		});

		it("ignores paths that are not dirty", () => {
			tracker.markDirty("a.md");
			tracker.acknowledge(["b.md"]);
			expect(tracker.getDirtyPaths().has("a.md")).toBe(true);
			expect(tracker.getDirtyPaths().size).toBe(1);
		});

		it("accepts any Iterable (Set)", () => {
			tracker.markDirty("a.md");
			tracker.acknowledge(new Set(["a.md"]));
			expect(tracker.getDirtyPaths().size).toBe(0);
		});

		it("paths marked dirty after acknowledge remain dirty", () => {
			tracker.acknowledge([]);
			tracker.markDirty("new.md");
			expect(tracker.getDirtyPaths().has("new.md")).toBe(true);
			expect(tracker.isInitialized()).toBe(true);
		});
	});

	describe("markRenamed", () => {
		it("records rename pair and marks both paths dirty", () => {
			tracker.markRenamed("new.md", "old.md");
			expect(tracker.getRenamePairs().get("new.md")).toBe("old.md");
			expect(tracker.getDirtyPaths().has("old.md")).toBe(true);
			expect(tracker.getDirtyPaths().has("new.md")).toBe(true);
		});

		it("collapses rename chain A→B→C into A→C", () => {
			tracker.markRenamed("b.md", "a.md");
			tracker.markRenamed("c.md", "b.md");
			expect(tracker.getRenamePairs().has("b.md")).toBe(false);
			expect(tracker.getRenamePairs().get("c.md")).toBe("a.md");
		});

		it("is no-op when renamed back to original (A→B→A)", () => {
			tracker.markRenamed("b.md", "a.md");
			tracker.markRenamed("a.md", "b.md");
			expect(tracker.getRenamePairs().size).toBe(0);
		});

		it("handles multiple independent renames", () => {
			tracker.markRenamed("b.md", "a.md");
			tracker.markRenamed("d.md", "c.md");
			expect(tracker.getRenamePairs().size).toBe(2);
			expect(tracker.getRenamePairs().get("b.md")).toBe("a.md");
			expect(tracker.getRenamePairs().get("d.md")).toBe("c.md");
		});
	});

	describe("acknowledge with rename pairs", () => {
		it("clears rename pairs when newPath is acknowledged", () => {
			tracker.markRenamed("new.md", "old.md");
			tracker.acknowledge(["new.md", "old.md"]);
			expect(tracker.getRenamePairs().size).toBe(0);
		});

		it("retains rename pair if newPath is not acknowledged", () => {
			tracker.markRenamed("new.md", "old.md");
			tracker.acknowledge(["old.md"]);
			expect(tracker.getRenamePairs().get("new.md")).toBe("old.md");
		});
	});

	describe("markFolderRenamed", () => {
		it("records folder rename pair", () => {
			tracker.markFolderRenamed("B", "A");
			expect(tracker.getFolderRenamePairs().get("B")).toBe("A");
		});

		it("collapses folder rename chain A→B→C into A→C", () => {
			tracker.markFolderRenamed("B", "A");
			tracker.markFolderRenamed("C", "B");
			expect(tracker.getFolderRenamePairs().has("B")).toBe(false);
			expect(tracker.getFolderRenamePairs().get("C")).toBe("A");
		});

		it("is no-op when folder renamed back to original (A→B→A)", () => {
			tracker.markFolderRenamed("B", "A");
			tracker.markFolderRenamed("A", "B");
			expect(tracker.getFolderRenamePairs().size).toBe(0);
		});

		it("acknowledge clears all folder rename pairs", () => {
			tracker.markFolderRenamed("B", "A");
			tracker.markFolderRenamed("D", "C");
			tracker.acknowledge([]);
			expect(tracker.getFolderRenamePairs().size).toBe(0);
		});
	});

	describe("isInitialized", () => {
		it("returns false before any acknowledge call", () => {
			expect(tracker.isInitialized()).toBe(false);
		});

		it("returns true after acknowledge is called", () => {
			tracker.acknowledge([]);
			expect(tracker.isInitialized()).toBe(true);
		});

		it("remains true after subsequent markDirty calls", () => {
			tracker.acknowledge([]);
			tracker.markDirty("a.md");
			expect(tracker.isInitialized()).toBe(true);
		});
	});
});
