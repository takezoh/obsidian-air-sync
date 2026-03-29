import { describe, it, expect } from "vitest";
import { refinePlan } from "./rename-optimizer";
import type { SyncAction, SyncRecord, SyncPlan } from "./types";
import type { FileEntity } from "../fs/types";

function entity(path: string, hash: string): FileEntity {
	return { path, isDirectory: false, size: 100, mtime: 1000, hash };
}

function baseline(path: string, hash: string): SyncRecord {
	return { path, hash, localMtime: 1000, remoteMtime: 1000, localSize: 100, remoteSize: 100, syncedAt: 900 };
}

function plan(actions: SyncAction[]): SyncPlan {
	return { actions, safetyCheck: { shouldAbort: false, requiresConfirmation: false } };
}

describe("refinePlan", () => {
	it("returns plan unchanged when no rename pairs exist", () => {
		const p = plan([{ path: "a.md", action: "push", local: entity("a.md", "h1") }]);
		const result = refinePlan(p, new Map(), new Map(), []);
		expect(result).toBe(p);
	});

	it("optimizes local file rename into rename_remote", () => {
		const p = plan([
			{ path: "old.md", action: "delete_remote", remote: entity("old.md", "h1"), baseline: baseline("old.md", "h1") },
			{ path: "new.md", action: "push", local: entity("new.md", "h1") },
		]);
		const renamePairs = new Map([["new.md", "old.md"]]);
		const result = refinePlan(p, renamePairs, new Map(), []);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({ action: "rename_remote", oldPath: "old.md" });
	});

	it("optimizes remote file rename into rename_local", () => {
		const p = plan([
			{ path: "old.md", action: "delete_local", local: entity("old.md", "h1"), baseline: baseline("old.md", "h1") },
			{ path: "new.md", action: "pull", remote: entity("new.md", "h1") },
		]);
		const remotePairs = [{ oldPath: "old.md", newPath: "new.md" }];
		const result = refinePlan(p, new Map(), new Map(), remotePairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({ action: "rename_local", oldPath: "old.md" });
	});

	it("applies local and remote renames independently in same cycle", () => {
		const p = plan([
			{ path: "local-old.md", action: "delete_remote", remote: entity("local-old.md", "h1"), baseline: baseline("local-old.md", "h1") },
			{ path: "local-new.md", action: "push", local: entity("local-new.md", "h1") },
			{ path: "remote-old.md", action: "delete_local", local: entity("remote-old.md", "h2"), baseline: baseline("remote-old.md", "h2") },
			{ path: "remote-new.md", action: "pull", remote: entity("remote-new.md", "h2") },
		]);
		const localPairs = new Map([["local-new.md", "local-old.md"]]);
		const remotePairs = [{ oldPath: "remote-old.md", newPath: "remote-new.md" }];
		const result = refinePlan(p, localPairs, new Map(), remotePairs);

		expect(result.actions).toHaveLength(2);
		const types = result.actions.map((a) => a.action).sort();
		expect(types).toEqual(["rename_local", "rename_remote"]);
	});

	it("local rename on path X does not interfere with remote rename on path Y", () => {
		const p = plan([
			{ path: "x-old.md", action: "delete_remote", remote: entity("x-old.md", "h1"), baseline: baseline("x-old.md", "h1") },
			{ path: "x-new.md", action: "push", local: entity("x-new.md", "h1") },
			{ path: "y-old.md", action: "delete_local", local: entity("y-old.md", "h2"), baseline: baseline("y-old.md", "h2") },
			{ path: "y-new.md", action: "pull", remote: entity("y-new.md", "h2") },
			{ path: "unrelated.md", action: "push", local: entity("unrelated.md", "h3") },
		]);
		const localPairs = new Map([["x-new.md", "x-old.md"]]);
		const remotePairs = [{ oldPath: "y-old.md", newPath: "y-new.md" }];
		const result = refinePlan(p, localPairs, new Map(), remotePairs);

		expect(result.actions).toHaveLength(3);
		expect(result.actions.map((a) => a.action).sort()).toEqual(["push", "rename_local", "rename_remote"]);
	});

	it("coalesces local folder rename with remaining file renames", () => {
		const p = plan([
			{ path: "A/f1.md", action: "delete_remote", remote: entity("A/f1.md", "h1"), baseline: baseline("A/f1.md", "h1") },
			{ path: "B/f1.md", action: "push", local: entity("B/f1.md", "h1") },
			{ path: "other-old.md", action: "delete_remote", remote: entity("other-old.md", "h2"), baseline: baseline("other-old.md", "h2") },
			{ path: "other-new.md", action: "push", local: entity("other-new.md", "h2") },
		]);
		const folderPairs = new Map([["B", "A"]]);
		const filePairs = new Map([["B/f1.md", "A/f1.md"], ["other-new.md", "other-old.md"]]);
		const result = refinePlan(p, filePairs, folderPairs, []);

		expect(result.actions).toHaveLength(2);
		const types = result.actions.map((a) => a.action).sort();
		expect(types).toEqual(["rename_remote", "rename_remote"]);
		const folder = result.actions.find((a) => "isFolder" in a && a.isFolder);
		expect(folder).toMatchObject({ path: "B", oldPath: "A", isFolder: true });
	});

	it("recomputes safety check after optimization", () => {
		const p = plan([
			{ path: "old.md", action: "delete_remote", remote: entity("old.md", "h1"), baseline: baseline("old.md", "h1") },
			{ path: "new.md", action: "push", local: entity("new.md", "h1") },
		]);
		const localPairs = new Map([["new.md", "old.md"]]);
		const result = refinePlan(p, localPairs, new Map(), []);

		expect(result).not.toBe(p);
		expect(result.safetyCheck).toBeDefined();
		expect(result.safetyCheck.shouldAbort).toBe(false);
	});
});
