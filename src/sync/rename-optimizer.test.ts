import { describe, it, expect } from "vitest";
import { optimizeRenames, optimizeRemoteRenames, coalesceFolderRenames, coalesceRemoteFolderRenames } from "./rename-optimizer";
import type { SyncAction, SyncRecord } from "./types";
import type { FileEntity } from "../fs/types";

function entity(path: string, hash: string): FileEntity {
	return { path, isDirectory: false, size: 100, mtime: 1000, hash };
}

function baseline(path: string, hash: string): SyncRecord {
	return { path, hash, localMtime: 1000, remoteMtime: 1000, localSize: 100, remoteSize: 100, syncedAt: 900 };
}

describe("optimizeRenames", () => {
	it("returns actions unchanged when no rename pairs", () => {
		const actions: SyncAction[] = [
			{ path: "a.md", action: "push", local: entity("a.md", "h1") },
		];
		const result = optimizeRenames(actions, new Map());
		expect(result).toBe(actions);
	});

	it("replaces push+delete_remote with rename_remote when hashes match", () => {
		const actions: SyncAction[] = [
			{ path: "old.md", action: "delete_remote", remote: entity("old.md", "h1"), baseline: baseline("old.md", "h1") },
			{ path: "new.md", action: "push", local: entity("new.md", "h1") },
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeRenames(actions, pairs);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: "new.md",
			action: "rename_remote",
			oldPath: "old.md",
		});
	});

	it("keeps original actions when hashes differ (content changed)", () => {
		const actions: SyncAction[] = [
			{ path: "old.md", action: "delete_remote", remote: entity("old.md", "h1"), baseline: baseline("old.md", "h1") },
			{ path: "new.md", action: "push", local: entity("new.md", "h2") },
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeRenames(actions, pairs);

		expect(result).toHaveLength(2);
		expect(result.map((a) => a.action)).toEqual(["delete_remote", "push"]);
	});

	it("keeps original actions when oldPath action is not delete_remote", () => {
		const actions: SyncAction[] = [
			{ path: "old.md", action: "conflict", local: entity("old.md", "h1"), remote: entity("old.md", "h2") },
			{ path: "new.md", action: "push", local: entity("new.md", "h1") },
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeRenames(actions, pairs);

		expect(result).toHaveLength(2);
	});

	it("keeps original actions when baseline hash is missing", () => {
		const actions: SyncAction[] = [
			{ path: "old.md", action: "delete_remote", remote: entity("old.md", "h1"), baseline: baseline("old.md", "") },
			{ path: "new.md", action: "push", local: entity("new.md", "h1") },
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeRenames(actions, pairs);

		expect(result).toHaveLength(2);
	});

	it("keeps original actions when local hash is missing", () => {
		const actions: SyncAction[] = [
			{ path: "old.md", action: "delete_remote", remote: entity("old.md", "h1"), baseline: baseline("old.md", "h1") },
			{ path: "new.md", action: "push", local: entity("new.md", "") },
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeRenames(actions, pairs);

		expect(result).toHaveLength(2);
	});

	it("optimizes some pairs and leaves others unchanged", () => {
		const actions: SyncAction[] = [
			{ path: "old-a.md", action: "delete_remote", remote: entity("old-a.md", "h1"), baseline: baseline("old-a.md", "h1") },
			{ path: "new-a.md", action: "push", local: entity("new-a.md", "h1") },
			{ path: "old-b.md", action: "delete_remote", remote: entity("old-b.md", "h2"), baseline: baseline("old-b.md", "h2") },
			{ path: "new-b.md", action: "push", local: entity("new-b.md", "h3") },
			{ path: "other.md", action: "pull", remote: entity("other.md", "h4") },
		];
		const pairs = new Map([
			["new-a.md", "old-a.md"],
			["new-b.md", "old-b.md"],
		]);
		const result = optimizeRenames(actions, pairs);

		expect(result).toHaveLength(4);
		const types = result.map((a) => a.action);
		expect(types).toContain("rename_remote");
		expect(types).toContain("delete_remote");
		expect(types).toContain("push");
		expect(types).toContain("pull");
	});

	it("preserves remote and baseline from delete action in rename_remote", () => {
		const remote = entity("old.md", "h1");
		const bl = baseline("old.md", "h1");
		const local = entity("new.md", "h1");
		const actions: SyncAction[] = [
			{ path: "old.md", action: "delete_remote", remote, baseline: bl },
			{ path: "new.md", action: "push", local },
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeRenames(actions, pairs);

		expect(result[0]!.remote).toBe(remote);
		expect(result[0]!.baseline).toBe(bl);
		expect(result[0]!.local).toBe(local);
	});
});

describe("coalesceFolderRenames", () => {
	it("coalesces all child file renames into a single folder rename_remote", () => {
		const actions: SyncAction[] = [
			{ path: "A/f1.md", action: "delete_remote", remote: entity("A/f1.md", "h1"), baseline: baseline("A/f1.md", "h1") },
			{ path: "B/f1.md", action: "push", local: entity("B/f1.md", "h1") },
			{ path: "A/f2.md", action: "delete_remote", remote: entity("A/f2.md", "h2"), baseline: baseline("A/f2.md", "h2") },
			{ path: "B/f2.md", action: "push", local: entity("B/f2.md", "h2") },
		];
		const folderPairs = new Map([["B", "A"]]);
		const filePairs = new Map([["B/f1.md", "A/f1.md"], ["B/f2.md", "A/f2.md"]]);
		const result = coalesceFolderRenames(actions, folderPairs, filePairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			path: "B",
			action: "rename_remote",
			oldPath: "A",
			isFolder: true,
		});
		const renameAction = result.actions[0] as { descendants: { oldPath: string; newPath: string }[] };
		expect(renameAction.descendants).toHaveLength(2);
		expect(result.remainingFileRenames.size).toBe(0);
	});

	it("skips folder coalescing when a child has hash mismatch", () => {
		const actions: SyncAction[] = [
			{ path: "A/f1.md", action: "delete_remote", remote: entity("A/f1.md", "h1"), baseline: baseline("A/f1.md", "h1") },
			{ path: "B/f1.md", action: "push", local: entity("B/f1.md", "h1") },
			{ path: "A/f2.md", action: "delete_remote", remote: entity("A/f2.md", "h2"), baseline: baseline("A/f2.md", "h2") },
			{ path: "B/f2.md", action: "push", local: entity("B/f2.md", "h3") },
		];
		const folderPairs = new Map([["B", "A"]]);
		const filePairs = new Map([["B/f1.md", "A/f1.md"], ["B/f2.md", "A/f2.md"]]);
		const result = coalesceFolderRenames(actions, folderPairs, filePairs);

		expect(result.actions).toHaveLength(4);
		expect(result.remainingFileRenames.size).toBe(2);
	});

	it("handles nested folder contents", () => {
		const actions: SyncAction[] = [
			{ path: "A/f1.md", action: "delete_remote", remote: entity("A/f1.md", "h1"), baseline: baseline("A/f1.md", "h1") },
			{ path: "B/f1.md", action: "push", local: entity("B/f1.md", "h1") },
			{ path: "A/sub/f2.md", action: "delete_remote", remote: entity("A/sub/f2.md", "h2"), baseline: baseline("A/sub/f2.md", "h2") },
			{ path: "B/sub/f2.md", action: "push", local: entity("B/sub/f2.md", "h2") },
		];
		const folderPairs = new Map([["B", "A"]]);
		const filePairs = new Map([["B/f1.md", "A/f1.md"], ["B/sub/f2.md", "A/sub/f2.md"]]);
		const result = coalesceFolderRenames(actions, folderPairs, filePairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({ action: "rename_remote", isFolder: true });
	});

	it("skips when no child file rename pairs exist", () => {
		const actions: SyncAction[] = [
			{ path: "other.md", action: "push", local: entity("other.md", "h1") },
		];
		const folderPairs = new Map([["B", "A"]]);
		const filePairs = new Map<string, string>();
		const result = coalesceFolderRenames(actions, folderPairs, filePairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]!.action).toBe("push");
	});

	it("preserves unrelated actions", () => {
		const actions: SyncAction[] = [
			{ path: "A/f1.md", action: "delete_remote", remote: entity("A/f1.md", "h1"), baseline: baseline("A/f1.md", "h1") },
			{ path: "B/f1.md", action: "push", local: entity("B/f1.md", "h1") },
			{ path: "other.md", action: "pull", remote: entity("other.md", "h3") },
		];
		const folderPairs = new Map([["B", "A"]]);
		const filePairs = new Map([["B/f1.md", "A/f1.md"]]);
		const result = coalesceFolderRenames(actions, folderPairs, filePairs);

		expect(result.actions).toHaveLength(2);
		expect(result.actions.map((a) => a.action)).toContain("pull");
		expect(result.actions.map((a) => a.action)).toContain("rename_remote");
	});
});

describe("coalesceRemoteFolderRenames", () => {
	it("coalesces remote folder rename into a single rename_local", () => {
		const actions: SyncAction[] = [
			{ path: "A/f1.md", action: "delete_local", local: entity("A/f1.md", "h1"), baseline: baseline("A/f1.md", "h1") },
			{ path: "B/f1.md", action: "pull", remote: entity("B/f1.md", "h1") },
			{ path: "A/f2.md", action: "delete_local", local: entity("A/f2.md", "h2"), baseline: baseline("A/f2.md", "h2") },
			{ path: "B/f2.md", action: "pull", remote: entity("B/f2.md", "h2") },
		];
		const pairs = [
			{ oldPath: "A", newPath: "B", isFolder: true },
			{ oldPath: "A/f1.md", newPath: "B/f1.md" },
			{ oldPath: "A/f2.md", newPath: "B/f2.md" },
		];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			path: "B",
			action: "rename_local",
			oldPath: "A",
			isFolder: true,
		});
		const renameAction = result.actions[0] as { descendants: { oldPath: string; newPath: string }[] };
		expect(renameAction.descendants).toHaveLength(2);
		expect(result.remainingPairs).toHaveLength(0);
	});

	it("passes through when no folder rename pairs exist", () => {
		const actions: SyncAction[] = [
			{ path: "old.md", action: "delete_local", local: entity("old.md", "h1"), baseline: baseline("old.md", "h1") },
			{ path: "new.md", action: "pull", remote: entity("new.md", "h1") },
		];
		const pairs = [{ oldPath: "old.md", newPath: "new.md" }];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		expect(result.actions).toBe(actions);
		expect(result.remainingPairs).toEqual(pairs);
	});
});

describe("optimizeRemoteRenames", () => {
	it("returns actions unchanged when no remote rename pairs", () => {
		const actions: SyncAction[] = [
			{ path: "a.md", action: "pull", remote: entity("a.md", "h1") },
		];
		const result = optimizeRemoteRenames(actions, []);
		expect(result).toBe(actions);
	});

	it("replaces delete_local+pull with rename_local", () => {
		const local = entity("old.md", "h1");
		const remote = entity("new.md", "h1");
		const bl = baseline("old.md", "h1");
		const actions: SyncAction[] = [
			{ path: "old.md", action: "delete_local", local, baseline: bl },
			{ path: "new.md", action: "pull", remote },
		];
		const pairs = [{ oldPath: "old.md", newPath: "new.md" }];
		const result = optimizeRemoteRenames(actions, pairs);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: "new.md",
			action: "rename_local",
			oldPath: "old.md",
		});
		expect(result[0]!.local).toBe(local);
		expect(result[0]!.remote).toBe(remote);
		expect(result[0]!.baseline).toBe(bl);
	});

	it("keeps original actions when oldPath is not delete_local", () => {
		const actions: SyncAction[] = [
			{ path: "old.md", action: "push", local: entity("old.md", "h1") },
			{ path: "new.md", action: "pull", remote: entity("new.md", "h1") },
		];
		const pairs = [{ oldPath: "old.md", newPath: "new.md" }];
		const result = optimizeRemoteRenames(actions, pairs);

		expect(result).toHaveLength(2);
	});

	it("keeps original actions when newPath is not pull", () => {
		const actions: SyncAction[] = [
			{ path: "old.md", action: "delete_local", local: entity("old.md", "h1"), baseline: baseline("old.md", "h1") },
			{ path: "new.md", action: "push", local: entity("new.md", "h1") },
		];
		const pairs = [{ oldPath: "old.md", newPath: "new.md" }];
		const result = optimizeRemoteRenames(actions, pairs);

		expect(result).toHaveLength(2);
	});

	it("optimizes some pairs and leaves others", () => {
		const actions: SyncAction[] = [
			{ path: "old-a.md", action: "delete_local", local: entity("old-a.md", "h1"), baseline: baseline("old-a.md", "h1") },
			{ path: "new-a.md", action: "pull", remote: entity("new-a.md", "h1") },
			{ path: "old-b.md", action: "push", local: entity("old-b.md", "h2") },
			{ path: "new-b.md", action: "pull", remote: entity("new-b.md", "h2") },
		];
		const pairs = [
			{ oldPath: "old-a.md", newPath: "new-a.md" },
			{ oldPath: "old-b.md", newPath: "new-b.md" },
		];
		const result = optimizeRemoteRenames(actions, pairs);

		expect(result).toHaveLength(3);
		const types = result.map((a) => a.action);
		expect(types).toContain("rename_local");
		expect(types).toContain("push");
		expect(types).toContain("pull");
	});
});
