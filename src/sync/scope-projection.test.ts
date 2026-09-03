import { describe, expect, it } from "vitest";
import type { ChangeSet } from "./change-detector";
import type { FileEntity, PathAuthority } from "../fs/types";
import type { RenameEvidence, ScopeDisposition, ScopeProjection } from "./types";
import { applyScope, projectRenameScope, projectScope } from "./scope-projection";

function entity(path: string, size = 1, pathAuthority: PathAuthority = "actual_resolved"): FileEntity {
	return { path, pathAuthority, isDirectory: false, size, mtime: 1, hash: "h" };
}

function directory(path: string): FileEntity {
	return { path, pathAuthority: "actual_resolved", isDirectory: true, size: 0, mtime: 1, hash: "" };
}

function rename(side: "local" | "remote", oldPath = "old.md", newPath = "new.md"): RenameEvidence {
	return { kind: "rename", side, oldPath, newPath, isFolder: false, authority: "reported" };
}

function projection(oldDisposition: ScopeDisposition, newDisposition: ScopeDisposition): ScopeProjection {
	return { byEndpoint: new Map([
		["old.md", oldDisposition],
		["new.md", newDisposition],
	]) };
}

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
	return {
		entries: [], observations: [], identityEvidence: [], temperature: "hot", ...overrides,
	};
}

describe("projectRenameScope", () => {
	it.each([
		["local", "rename_remote"],
		["remote", "rename_local"],
	] as const)("maps an included %s rename to %s", (side, consequence) => {
		expect(projectRenameScope(rename(side), projection("included", "included"))).toEqual({
			consequence, oldDisposition: "included", newDisposition: "included",
		});
	});

	it("defers the whole edge when either endpoint is unknown", () => {
		for (const side of ["local", "remote"] as const) {
			expect(projectRenameScope(rename(side), projection("unknown", "included")).consequence)
				.toBe("defer");
			expect(projectRenameScope(rename(side), projection("included", "unknown")).consequence)
				.toBe("defer");
		}
	});

	it("defaults an absent endpoint to unknown and defers", () => {
		expect(projectRenameScope(rename("local"), {
			byEndpoint: new Map([["old.md", "included"]]),
		}).consequence).toBe("defer");
	});

	it("defers an included folder rename whose observed mapping is incomplete", () => {
		const folderRename: RenameEvidence = { ...rename("remote", "old", "new"), isFolder: true };
		const result = projectRenameScope(folderRename, {
			byEndpoint: new Map([
				["old", "included"], ["new", "included"], ["new/a.md", "included"],
			]),
		});

		expect(result.consequence).toBe("defer");
	});

	it("permits a folder rename when every observed descendant is included and mapped", () => {
		const folderRename: RenameEvidence = { ...rename("remote", "old", "new"), isFolder: true };
		const result = projectRenameScope(folderRename, {
			byEndpoint: new Map([
				["old", "included"], ["new", "included"],
				["old/a.md", "included"], ["new/a.md", "included"],
			]),
		});

		expect(result.consequence).toBe("rename_local");
	});
});

describe("applyScope", () => {
	it("removes a cross-scope rename endpoint and the relation itself", () => {
		const result = applyScope(changeSet({
			entries: [
				{ path: "old.md", remote: entity("old.md") },
				{ path: "new.md", local: entity("new.md") },
			],
			observations: [
				{ kind: "absent", side: "local", requestedPath: "old.md", authority: "stat" },
				{ kind: "exact", side: "local", requestedPath: "new.md", entity: entity("new.md") },
			],
			identityEvidence: [rename("local")],
		}), { isExcluded: (path) => path === "new.md" });

		expect(result.changeSet.entries.map((item) => item.path)).toEqual(["old.md"]);
		expect(result.changeSet.observations.map((item) => item.requestedPath)).toEqual(["old.md"]);
		expect(result.changeSet.identityEvidence).toEqual([]);
		expect([...result.projection.byEndpoint.keys()]).toEqual(["old.md"]);
	});

	it("retains a rename only when both endpoints are included", () => {
		const evidence = rename("local");
		const result = applyScope(changeSet({
			observations: [
				{ kind: "absent", side: "local", requestedPath: "old.md", authority: "stat" },
				{ kind: "exact", side: "local", requestedPath: "new.md", entity: entity("new.md") },
			],
			identityEvidence: [evidence],
		}), { isExcluded: () => false });

		expect(result.changeSet.identityEvidence).toEqual([evidence]);
		expect(result.projection.byEndpoint).toEqual(new Map([
			["old.md", "included"], ["new.md", "included"],
		]));
	});

	it("drops folder rename evidence when a descendant crosses scope", () => {
		const folderRename: RenameEvidence = {
			...rename("local", "old", "new"), isFolder: true,
		};
		const result = applyScope(changeSet({
			entries: [
				{ path: "old/a.md", remote: entity("old/a.md") },
				{ path: "new/a.md", local: entity("new/a.md") },
			],
			identityEvidence: [folderRename],
		}), { isExcluded: (path) => path === "new/a.md" });

		expect(result.changeSet.entries.map((item) => item.path)).toEqual(["old/a.md"]);
		expect(result.changeSet.identityEvidence).toEqual([]);
		expect([...result.projection.byEndpoint.keys()]).toEqual(["old/a.md"]);
	});

	it("does not let excluded descendants affect an otherwise included folder rename", () => {
		const folderRename: RenameEvidence = {
			...rename("local", "old", "new"), isFolder: true,
		};
		const result = applyScope(changeSet({
			entries: [
				{ path: "old/a.md", remote: entity("old/a.md") },
				{ path: "new/a.md", local: entity("new/a.md") },
				{ path: "new/desktop.ini", local: entity("new/desktop.ini") },
			],
			identityEvidence: [folderRename],
		}), { isExcluded: (path) => path.endsWith("desktop.ini") });

		expect(result.changeSet.identityEvidence).toEqual([folderRename]);
		expect(result.changeSet.entries.map((item) => item.path)).toEqual([
			"old/a.md", "new/a.md",
		]);
		expect([...result.projection.byEndpoint.keys()]).not.toContain("new/desktop.ini");
	});

	it("removes an alias observation whose target is outside scope", () => {
		const result = applyScope(changeSet({
			observations: [{
				kind: "alias", side: "remote", requestedPath: "A.md",
				resolvedPath: ".hidden/A.md", entity: entity(".hidden/A.md"),
			}],
			identityEvidence: [{
				kind: "alias", side: "remote", requestedPath: "A.md", resolvedPath: ".hidden/A.md",
			}],
		}), { isExcluded: (path) => path.startsWith(".") });

		expect(result.changeSet.observations).toEqual([]);
		expect(result.changeSet.identityEvidence).toEqual([]);
		expect(result.projection.byEndpoint.size).toBe(0);
	});

	it("removes excluded nested entity and baseline paths from an included entry", () => {
		const result = applyScope(changeSet({
			entries: [{
				path: "included.md",
				local: entity(".hidden/local.md"),
				remote: entity("included.md"),
				prevSync: {
					path: "desktop.ini", hash: "h", localMtime: 1, remoteMtime: 1,
					localSize: 1, remoteSize: 1, syncedAt: 1,
				},
			}],
		}), { isExcluded: (path) => path.startsWith(".") || path === "desktop.ini" });

		expect(result.changeSet.entries).toEqual([{
			path: "included.md", local: undefined, remote: entity("included.md"),
			prevSync: undefined,
		}]);
	});

	it("removes outside-root paths without creating an engine disposition", () => {
		const result = applyScope(changeSet({
			observations: [{
				kind: "unknown", side: "remote", requestedPath: "new.md",
				reason: "outside_tracked_root",
			}],
			identityEvidence: [rename("remote")],
		}), { isExcluded: () => false });

		expect(result.changeSet.observations).toEqual([]);
		expect(result.changeSet.identityEvidence).toEqual([]);
		expect(result.projection.byEndpoint.size).toBe(0);
	});

	it("filters excluded stable-identity occurrences", () => {
		const result = applyScope(changeSet({
			identityEvidence: [{
				kind: "stable_identity", side: "remote", identityKey: "id",
				occurrences: [
					{ side: "remote", phase: "baseline", path: "included.md" },
					{ side: "remote", phase: "current", path: "desktop.ini" },
				],
			}],
		}), { isExcluded: (path) => path === "desktop.ini" });

		expect(result.changeSet.identityEvidence).toEqual([{
			kind: "stable_identity", side: "remote", identityKey: "id",
			occurrences: [{ side: "remote", phase: "baseline", path: "included.md" }],
		}]);
		expect([...result.projection.byEndpoint.keys()]).toEqual(["included.md"]);
	});
});

describe("projectScope", () => {
	it("does not require incidental directory observations as folder descendants", () => {
		const folderRename: RenameEvidence = {
			...rename("local", "old", "new"), isFolder: true,
		};
		const result = projectScope(changeSet({
			entries: [
				{ path: "old/nested/a.md", local: entity("old/nested/a.md") },
				{ path: "new/nested/a.md", local: entity("new/nested/a.md") },
			],
			observations: [
				{ kind: "exact", side: "local", requestedPath: "old", entity: directory("old") },
				{ kind: "exact", side: "local", requestedPath: "new", entity: directory("new") },
				{ kind: "exact", side: "local", requestedPath: "old/nested", entity: directory("old/nested") },
				{ kind: "exact", side: "local", requestedPath: "new/nested", entity: directory("new/nested") },
			],
			identityEvidence: [folderRename],
		}));

		expect(result.byEndpoint.has("old/nested")).toBe(false);
		expect(result.byEndpoint.has("new/nested")).toBe(false);
		expect(projectRenameScope(folderRename, result).consequence).toBe("rename_remote");
	});

	it("keeps an unobserved included endpoint unknown", () => {
		const result = projectScope(changeSet({ identityEvidence: [rename("remote")] }));

		expect(result.byEndpoint).toEqual(new Map([
			["old.md", "unknown"], ["new.md", "unknown"],
		]));
	});

	it("removes oversized current files before projection", () => {
		const result = applyScope(changeSet({
			entries: [
				{ path: "large.md", local: entity("large.md", 11) },
				{ path: "small.md", remote: entity("small.md", 10) },
			],
		}), { isExcluded: (_path, currentSize) => (currentSize ?? 0) > 10 });

		expect(result.changeSet.entries.map((entry) => entry.path)).toEqual(["small.md"]);
		expect(result.projection.byEndpoint).toEqual(new Map([["small.md", "included"]]));
	});
});
