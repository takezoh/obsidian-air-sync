import { describe, it, expect, beforeEach } from "vitest";
import { LocalChangeTracker, type TrackerSnapshot } from "./local-tracker";

/** Build a partial snapshot for acknowledge() tests that need a specific set. */
function mkSnap(opts: {
	dirty?: string[];
	renames?: [string, string][];
	folderRenames?: [string, string][];
} = {}): TrackerSnapshot {
	return {
		dirtyPaths: new Set(opts.dirty ?? []),
		renamePairs: new Map(opts.renames ?? []),
		folderRenamePairs: new Map(opts.folderRenames ?? []),
		initialized: true,
	};
}

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

	describe("snapshot", () => {
		it("is a frozen copy unaffected by later mutation of the live tracker", () => {
			tracker.markDirty("a.md");
			const snap = tracker.snapshot();
			tracker.markDirty("b.md");
			expect(snap.dirtyPaths.has("a.md")).toBe(true);
			expect(snap.dirtyPaths.has("b.md")).toBe(false); // captured before b.md
		});

		it("captures the initialized flag", () => {
			expect(tracker.snapshot().initialized).toBe(false);
			tracker.acknowledge(tracker.snapshot());
			expect(tracker.snapshot().initialized).toBe(true);
		});
	});

	describe("acknowledge", () => {
		it("removes acknowledged paths from the dirty set", () => {
			tracker.markDirty("a.md");
			tracker.markDirty("b.md");
			tracker.acknowledge(mkSnap({ dirty: ["a.md"] }));
			expect(tracker.getDirtyPaths().has("a.md")).toBe(false);
			expect(tracker.getDirtyPaths().has("b.md")).toBe(true);
		});

		it("sets initialized to true", () => {
			expect(tracker.isInitialized()).toBe(false);
			tracker.acknowledge(mkSnap());
			expect(tracker.isInitialized()).toBe(true);
		});

		it("retains dirty paths not in the acknowledged snapshot", () => {
			tracker.markDirty("a.md");
			tracker.markDirty("b.md");
			tracker.markDirty("c.md");
			tracker.acknowledge(mkSnap({ dirty: ["a.md", "c.md"] }));
			expect(tracker.getDirtyPaths().size).toBe(1);
			expect(tracker.getDirtyPaths().has("b.md")).toBe(true);
		});

		it("ignores snapshot paths that are not dirty", () => {
			tracker.markDirty("a.md");
			tracker.acknowledge(mkSnap({ dirty: ["b.md"] }));
			expect(tracker.getDirtyPaths().has("a.md")).toBe(true);
			expect(tracker.getDirtyPaths().size).toBe(1);
		});

		it("acknowledging a full snapshot() clears the captured dirty set", () => {
			tracker.markDirty("a.md");
			tracker.acknowledge(tracker.snapshot());
			expect(tracker.getDirtyPaths().size).toBe(0);
		});

		it("paths marked dirty after the snapshot is taken remain dirty", () => {
			const snap = tracker.snapshot();
			tracker.markDirty("new.md");
			tracker.acknowledge(snap);
			expect(tracker.getDirtyPaths().has("new.md")).toBe(true);
			expect(tracker.isInitialized()).toBe(true);
		});
	});

	describe("acknowledgePath", () => {
		it("clears a single path's dirty + rename entry", () => {
			tracker.markDirty("a.md");
			tracker.markRenamed("new.md", "old.md");
			tracker.acknowledgePath("a.md");
			tracker.acknowledgePath("new.md");
			expect(tracker.getDirtyPaths().has("a.md")).toBe(false);
			expect(tracker.getRenamePairs().has("new.md")).toBe(false);
		});

		it("does NOT touch pending folder renames (single-file pull must not wipe them)", () => {
			tracker.markFolderRenamed("B", "A");
			tracker.markDirty("a.md");
			tracker.acknowledgePath("a.md");
			expect(tracker.getFolderRenamePairs().get("B")).toBe("A");
		});

		it("does NOT flip initialized (must not leave cold-start state)", () => {
			tracker.markDirty("a.md");
			tracker.acknowledgePath("a.md");
			expect(tracker.isInitialized()).toBe(false);
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
		it("clears rename pairs when the newPath is in the snapshot", () => {
			tracker.markRenamed("new.md", "old.md");
			tracker.acknowledge(tracker.snapshot());
			expect(tracker.getRenamePairs().size).toBe(0);
		});

		it("retains rename pair if newPath is not in the snapshot", () => {
			tracker.markRenamed("new.md", "old.md");
			tracker.acknowledge(mkSnap({ dirty: ["old.md"] }));
			expect(tracker.getRenamePairs().get("new.md")).toBe("old.md");
		});

		it("a mid-cycle rename onto a pre-dirtied path survives acknowledge", () => {
			// new.md is independently dirty before the cycle, so it is in the
			// snapshot's dirty set. A rename old.md→new.md recorded mid-cycle must
			// NOT be swept just because new.md is a dirty-snapshot member.
			tracker.markDirty("new.md");
			const snap = tracker.snapshot(); // dirty={new.md}, renamePairs={}
			tracker.markRenamed("new.md", "old.md"); // mid-cycle
			tracker.acknowledge(snap);
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

		it("acknowledge clears folder rename pairs present in the snapshot", () => {
			tracker.markFolderRenamed("B", "A");
			tracker.markFolderRenamed("D", "C");
			tracker.acknowledge(tracker.snapshot());
			expect(tracker.getFolderRenamePairs().size).toBe(0);
		});

		it("a folder rename recorded after the snapshot survives acknowledge", () => {
			tracker.markFolderRenamed("B", "A");
			const snap = tracker.snapshot();
			tracker.markFolderRenamed("D", "C"); // recorded mid-cycle
			tracker.acknowledge(snap);
			expect(tracker.getFolderRenamePairs().has("B")).toBe(false); // in snapshot → cleared
			expect(tracker.getFolderRenamePairs().get("D")).toBe("C"); // mid-cycle → survives
		});

		it("a mid-cycle folder rename that reuses a snapshot key survives acknowledge", () => {
			// Snapshot captures B→A; mid-cycle a different rename overwrites the key
			// (B→X). acknowledge must not delete B, since the live value no longer
			// equals what the snapshot captured.
			tracker.markFolderRenamed("B", "A");
			const snap = tracker.snapshot();
			tracker.markFolderRenamed("B", "X"); // mid-cycle overwrite
			tracker.acknowledge(snap);
			expect(tracker.getFolderRenamePairs().get("B")).toBe("X");
		});
	});

	describe("isInitialized", () => {
		it("returns false before any acknowledge call", () => {
			expect(tracker.isInitialized()).toBe(false);
		});

		it("returns true after acknowledge is called", () => {
			tracker.acknowledge(tracker.snapshot());
			expect(tracker.isInitialized()).toBe(true);
		});

		it("remains true after subsequent markDirty calls", () => {
			tracker.acknowledge(tracker.snapshot());
			tracker.markDirty("a.md");
			expect(tracker.isInitialized()).toBe(true);
		});
	});
});
