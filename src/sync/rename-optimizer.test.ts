import { describe, it, expect } from "vitest";
import { optimizeRenames } from "./rename-optimizer";
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
