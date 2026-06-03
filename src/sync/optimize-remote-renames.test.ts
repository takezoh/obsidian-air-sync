import { describe, it, expect } from "vitest";
import {
	optimizeRemoteFileRenames,
	coalesceRemoteFolderRenames,
} from "./optimize-remote-renames";
import type { SyncAction, SyncRecord } from "./types";
import type { FileEntity } from "../fs/types";

function entity(path: string, hash: string): FileEntity {
	return { path, isDirectory: false, size: 100, mtime: 1000, hash };
}

function baseline(path: string, hash: string): SyncRecord {
	return {
		path,
		hash,
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 100,
		remoteSize: 100,
		syncedAt: 900,
	};
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
		expect(result.applied).toEqual([
			{ oldPath: "old.md", newPath: "new.md" },
		]);
	});

	it("keeps original actions when oldPath is not delete_local", () => {
		const actions: SyncAction[] = [
			{ path: "old.md", action: "push", local: entity("old.md", "h1") },
			{ path: "new.md", action: "pull", remote: entity("new.md", "h1") },
		];
		const pairs = [{ oldPath: "old.md", newPath: "new.md" }];
		const result = optimizeRemoteFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(2);
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "old.md", newPath: "new.md" },
				reason: "action_type_mismatch",
			},
		]);
	});

	it("keeps original actions when newPath is not pull", () => {
		const actions: SyncAction[] = [
			{
				path: "old.md",
				action: "delete_local",
				local: entity("old.md", "h1"),
				baseline: baseline("old.md", "h1"),
			},
			{ path: "new.md", action: "push", local: entity("new.md", "h1") },
		];
		const pairs = [{ oldPath: "old.md", newPath: "new.md" }];
		const result = optimizeRemoteFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(2);
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "old.md", newPath: "new.md" },
				reason: "action_type_mismatch",
			},
		]);
	});

	it("optimizes some pairs and leaves others", () => {
		const actions: SyncAction[] = [
			{
				path: "old-a.md",
				action: "delete_local",
				local: entity("old-a.md", "h1"),
				baseline: baseline("old-a.md", "h1"),
			},
			{
				path: "new-a.md",
				action: "pull",
				remote: entity("new-a.md", "h1"),
			},
			{
				path: "old-b.md",
				action: "push",
				local: entity("old-b.md", "h2"),
			},
			{
				path: "new-b.md",
				action: "pull",
				remote: entity("new-b.md", "h2"),
			},
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

	it("skips when the pair references paths absent from actions", () => {
		const actions: SyncAction[] = [
			{
				path: "unrelated.md",
				action: "pull",
				remote: entity("unrelated.md", "h1"),
			},
		];
		const pairs = [{ oldPath: "old.md", newPath: "new.md" }];
		const result = optimizeRemoteFileRenames(actions, pairs);

		expect(result.actions).toBe(actions);
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "old.md", newPath: "new.md" },
				reason: "action_type_mismatch",
			},
		]);
	});

	it("converts delete_local+pull into rename_local even when content hashes differ", () => {
		// Remote rename info is authoritative (backend-detected); unlike local
		// renames, no hash verification is performed. This documents the design:
		// if the renamed file's content also changed remotely, that change is
		// folded into the rename and NOT pulled. Revisit if backend rename
		// detection can ever report a content-changed file as a pure rename.
		const actions: SyncAction[] = [
			{
				path: "old.md",
				action: "delete_local",
				local: entity("old.md", "h1"),
				baseline: baseline("old.md", "h1"),
			},
			{ path: "new.md", action: "pull", remote: entity("new.md", "h2") },
		];
		const pairs = [{ oldPath: "old.md", newPath: "new.md" }];
		const result = optimizeRemoteFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			action: "rename_local",
			oldPath: "old.md",
		});
		expect(result.skipped).toHaveLength(0);
	});
});

describe("coalesceRemoteFolderRenames", () => {
	it("coalesces remote folder rename by scanning actions for delete_local+pull pairs", () => {
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_local",
				local: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{
				path: "B/f1.md",
				action: "pull",
				remote: entity("B/f1.md", "h1"),
			},
			{
				path: "A/f2.md",
				action: "delete_local",
				local: entity("A/f2.md", "h2"),
				baseline: baseline("A/f2.md", "h2"),
			},
			{
				path: "B/f2.md",
				action: "pull",
				remote: entity("B/f2.md", "h2"),
			},
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
		const renameAction = result.actions[0] as {
			descendants: { oldPath: string; newPath: string }[];
		};
		expect(renameAction.descendants).toHaveLength(2);
		expect(result.remainingPairs).toHaveLength(0);
		expect(result.applied).toEqual([
			{ oldPath: "A", newPath: "B", isFolder: true },
		]);
	});

	it("skips a cross-regime folder rename and keeps the per-file actions", () => {
		// `.templates` (hidden, opted into syncDotPaths) renamed to `templates`
		// (normal) on the remote. LocalFs can't rename a directory across the
		// hidden/normal boundary, so this must NOT coalesce into one rename_local.
		const actions: SyncAction[] = [
			{
				path: ".templates/f1.md",
				action: "delete_local",
				local: entity(".templates/f1.md", "h1"),
				baseline: baseline(".templates/f1.md", "h1"),
			},
			{
				path: "templates/f1.md",
				action: "pull",
				remote: entity("templates/f1.md", "h1"),
			},
		];
		const pairs = [
			{ oldPath: ".templates", newPath: "templates", isFolder: true },
		];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		expect(result.actions.some((a) => a.action === "rename_local")).toBe(false);
		expect(result.actions).toHaveLength(2); // per-file actions preserved
		expect(result.applied).toHaveLength(0);
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: ".templates", newPath: "templates", isFolder: true },
				reason: "cross_regime",
			},
		]);
		// The skipped folder pair must not leak into remainingPairs (no file pairs here).
		expect(result.remainingPairs).toHaveLength(0);
	});

	it("passes through when no folder rename pairs exist", () => {
		const actions: SyncAction[] = [
			{
				path: "old.md",
				action: "delete_local",
				local: entity("old.md", "h1"),
				baseline: baseline("old.md", "h1"),
			},
			{ path: "new.md", action: "pull", remote: entity("new.md", "h1") },
		];
		const pairs = [{ oldPath: "old.md", newPath: "new.md" }];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		expect(result.actions).toBe(actions);
		expect(result.remainingPairs).toEqual(pairs);
	});

	it("reports no_descendants when folder has no matching action pairs", () => {
		const actions: SyncAction[] = [
			{
				path: "other.md",
				action: "push",
				local: entity("other.md", "h1"),
			},
		];
		const pairs = [{ oldPath: "A", newPath: "B", isFolder: true }];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		expect(result.actions).toHaveLength(1);
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "A", newPath: "B", isFolder: true },
				reason: "no_descendants",
			},
		]);
	});

	it("passes independent file rename pairs through as remainingPairs after coalescing a folder", () => {
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_local",
				local: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{
				path: "B/f1.md",
				action: "pull",
				remote: entity("B/f1.md", "h1"),
			},
			{
				path: "x-old.md",
				action: "delete_local",
				local: entity("x-old.md", "h2"),
				baseline: baseline("x-old.md", "h2"),
			},
			{
				path: "x-new.md",
				action: "pull",
				remote: entity("x-new.md", "h2"),
			},
		];
		const pairs = [
			{ oldPath: "A", newPath: "B", isFolder: true },
			{ oldPath: "x-old.md", newPath: "x-new.md" },
		];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		expect(result.applied).toEqual([
			{ oldPath: "A", newPath: "B", isFolder: true },
		]);
		// The independent file pair is not consumed by the folder; it survives
		// for optimizeRemoteFileRenames to turn into a rename_local next.
		expect(result.remainingPairs).toEqual([
			{ oldPath: "x-old.md", newPath: "x-new.md" },
		]);
		expect(result.actions.map((a) => a.path).sort()).toEqual([
			"B",
			"x-new.md",
			"x-old.md",
		]);
	});

	// A folder rename_local moves the whole local folder A→B. A child whose
	// matching pull is missing (remote-deleted, ignore-filtered, partial sync)
	// is absorbed as a move descendant rather than left as a dangling
	// delete_local that would fire against the already-moved old path. Folding
	// it into the rename rewrites its baseline to B/x, so a genuine remote
	// deletion propagates safely as a delete_local(B/x) next cycle.
	it("absorbs a delete_local with no matching pull into the folder rename", () => {
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_local",
				local: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{
				path: "A/f2.md",
				action: "delete_local",
				local: entity("A/f2.md", "h2"),
				baseline: baseline("A/f2.md", "h2"),
			},
			{
				path: "B/f2.md",
				action: "pull",
				remote: entity("B/f2.md", "h2"),
			},
			// No pull for B/f1.md — its delete_local has no rename counterpart.
		];
		const pairs = [{ oldPath: "A", newPath: "B", isFolder: true }];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		// No standalone delete_local survives under the renamed folder.
		expect(
			result.actions.find((a) => a.action === "delete_local"),
		).toBeUndefined();
		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			path: "B",
			action: "rename_local",
			oldPath: "A",
			isFolder: true,
		});
		const renameAction = result.actions[0] as {
			descendants: { oldPath: string; newPath: string }[];
		};
		// Both children — including the pull-less f1 — are folded into descendants.
		expect(renameAction.descendants).toEqual([
			{ oldPath: "A/f1.md", newPath: "B/f1.md" },
			{ oldPath: "A/f2.md", newPath: "B/f2.md" },
		]);
		expect(result.applied).toEqual([
			{ oldPath: "A", newPath: "B", isFolder: true },
		]);
	});

	it("coalesces a folder rename even when every child lacks a pull", () => {
		// e.g. the whole folder's children were deleted on the remote, or all
		// ignore-filtered — previously this left every delete_local dangling.
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_local",
				local: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{
				path: "A/f2.md",
				action: "delete_local",
				local: entity("A/f2.md", "h2"),
				baseline: baseline("A/f2.md", "h2"),
			},
		];
		const pairs = [{ oldPath: "A", newPath: "B", isFolder: true }];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			action: "rename_local",
			isFolder: true,
		});
		expect(result.skipped).toHaveLength(0);
		const renameAction = result.actions[0] as {
			descendants: { oldPath: string; newPath: string }[];
		};
		expect(renameAction.descendants).toHaveLength(2);
	});

	it("skips the folder when the destination is occupied by a local file", () => {
		// B/ already holds a local file (push at B/g.md). A folder rename_local
		// would collide on localFs.rename(A→B), so leave the individual actions
		// for the decision engine to converge in one cycle.
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_local",
				local: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{
				path: "B/f1.md",
				action: "pull",
				remote: entity("B/f1.md", "h1"),
			},
			{ path: "B/g.md", action: "push", local: entity("B/g.md", "h9") },
		];
		const pairs = [{ oldPath: "A", newPath: "B", isFolder: true }];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		// No rename_local is produced; all original actions are preserved.
		expect(
			result.actions.find((a) => a.action === "rename_local"),
		).toBeUndefined();
		expect(result.actions.map((a) => a.action).sort()).toEqual([
			"delete_local",
			"pull",
			"push",
		]);
		expect(result.applied).toHaveLength(0);
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "A", newPath: "B", isFolder: true },
				reason: "destination_occupied",
			},
		]);
	});

	it("treats a conflict under the new prefix as destination occupancy", () => {
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_local",
				local: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{
				path: "B/f1.md",
				action: "conflict",
				local: entity("B/f1.md", "h8"),
				remote: entity("B/f1.md", "h1"),
			},
		];
		const pairs = [{ oldPath: "A", newPath: "B", isFolder: true }];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		expect(
			result.actions.find((a) => a.action === "rename_local"),
		).toBeUndefined();
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "A", newPath: "B", isFolder: true },
				reason: "destination_occupied",
			},
		]);
	});

	it("treats a match under the new prefix as destination occupancy", () => {
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_local",
				local: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{
				path: "B/g.md",
				action: "match",
				local: entity("B/g.md", "h9"),
				remote: entity("B/g.md", "h9"),
			},
		];
		const pairs = [{ oldPath: "A", newPath: "B", isFolder: true }];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		expect(
			result.actions.find((a) => a.action === "rename_local"),
		).toBeUndefined();
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "A", newPath: "B", isFolder: true },
				reason: "destination_occupied",
			},
		]);
	});

	it("does not treat a pull under the new prefix as occupancy (no local side)", () => {
		// A pull has no local entity, so B/ is not occupied — normal coalescing.
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_local",
				local: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{
				path: "B/f1.md",
				action: "pull",
				remote: entity("B/f1.md", "h1"),
			},
		];
		const pairs = [{ oldPath: "A", newPath: "B", isFolder: true }];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			action: "rename_local",
			isFolder: true,
		});
		expect(result.skipped).toHaveLength(0);
	});

	it("treats a delete_local under the new prefix as destination occupancy", () => {
		// A delete_local still carries a local entity (the file is on disk until
		// Group C runs, after the Group B folder rename), so B/ is occupied and
		// the move would collide. This is the occupying type whose local side is
		// least obvious — pin it.
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_local",
				local: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{
				path: "B/leftover.md",
				action: "delete_local",
				local: entity("B/leftover.md", "h7"),
				baseline: baseline("B/leftover.md", "h7"),
			},
		];
		const pairs = [{ oldPath: "A", newPath: "B", isFolder: true }];
		const result = coalesceRemoteFolderRenames(actions, pairs);

		expect(
			result.actions.find((a) => a.action === "rename_local"),
		).toBeUndefined();
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "A", newPath: "B", isFolder: true },
				reason: "destination_occupied",
			},
		]);
	});
});
