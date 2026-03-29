import { describe, it, expect } from "vitest";
import { optimizeRemoteFileRenames, coalesceRemoteFolderRenames } from "./optimize-remote-renames";
import type { SyncAction, SyncRecord } from "./types";
import type { FileEntity } from "../fs/types";

function entity(path: string, hash: string): FileEntity {
	return { path, isDirectory: false, size: 100, mtime: 1000, hash };
}

function baseline(path: string, hash: string): SyncRecord {
	return { path, hash, localMtime: 1000, remoteMtime: 1000, localSize: 100, remoteSize: 100, syncedAt: 900 };
}

describe("optimizeRemoteFileRenames", () => {
	it("returns actions unchanged when no remote rename pairs", () => {
		const actions: SyncAction[] = [
			{ path: "a.md", action: "pull", remote: entity("a.md", "h1") },
		];
		const result = optimizeRemoteFileRenames(actions, []);
		expect(result.actions).toBe(actions);
		expect(result.applied).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
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
		const result = optimizeRemoteFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			path: "new.md",
			action: "rename_local",
			oldPath: "old.md",
		});
		expect(result.actions[0]!.local).toBe(local);
		expect(result.actions[0]!.remote).toBe(remote);
		expect(result.actions[0]!.baseline).toBe(bl);
		expect(result.applied).toEqual([{ oldPath: "old.md", newPath: "new.md" }]);
	});

	it("keeps original actions when oldPath is not delete_local", () => {
		const actions: SyncAction[] = [
			{ path: "old.md", action: "push", local: entity("old.md", "h1") },
			{ path: "new.md", action: "pull", remote: entity("new.md", "h1") },
		];
		const pairs = [{ oldPath: "old.md", newPath: "new.md" }];
		const result = optimizeRemoteFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(2);
		expect(result.skipped).toEqual([{ pair: { oldPath: "old.md", newPath: "new.md" }, reason: "action_type_mismatch" }]);
	});

	it("keeps original actions when newPath is not pull", () => {
		const actions: SyncAction[] = [
			{ path: "old.md", action: "delete_local", local: entity("old.md", "h1"), baseline: baseline("old.md", "h1") },
			{ path: "new.md", action: "push", local: entity("new.md", "h1") },
		];
		const pairs = [{ oldPath: "old.md", newPath: "new.md" }];
		const result = optimizeRemoteFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(2);
		expect(result.skipped).toEqual([{ pair: { oldPath: "old.md", newPath: "new.md" }, reason: "action_type_mismatch" }]);
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
		const result = optimizeRemoteFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(3);
		const types = result.actions.map((a) => a.action);
		expect(types).toContain("rename_local");
		expect(types).toContain("push");
		expect(types).toContain("pull");
		expect(result.applied).toHaveLength(1);
		expect(result.skipped).toHaveLength(1);
	});
});

describe("coalesceRemoteFolderRenames", () => {
	it("coalesces remote folder rename by scanning actions for delete_local+pull pairs", () => {
		const actions: SyncAction[] = [
			{ path: "A/f1.md", action: "delete_local", local: entity("A/f1.md", "h1"), baseline: baseline("A/f1.md", "h1") },
			{ path: "B/f1.md", action: "pull", remote: entity("B/f1.md", "h1") },
			{ path: "A/f2.md", action: "delete_local", local: entity("A/f2.md", "h2"), baseline: baseline("A/f2.md", "h2") },
			{ path: "B/f2.md", action: "pull", remote: entity("B/f2.md", "h2") },
		];
		const pairs = [{ oldPath: "A", newPath: "B", isFolder: true }];
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
		expect(result.applied).toEqual([{ oldPath: "A", newPath: "B", isFolder: true }]);
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

	it("reports no_descendants when folder has no matching action pairs", () => {
		const actions: SyncAction[] = [
			{ path: "other.md", action: "push", local: entity("other.md", "h1") },
		];
		const pairs = [{ oldPath: "A", newPath: "B", isFolder: true }];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		expect(result.actions).toHaveLength(1);
		expect(result.skipped).toEqual([{
			pair: { oldPath: "A", newPath: "B", isFolder: true },
			reason: "no_descendants",
		}]);
	});
});
