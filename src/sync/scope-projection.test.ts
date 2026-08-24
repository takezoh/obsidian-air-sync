import { describe, expect, it } from "vitest";
import type { ChangeSet } from "./change-detector";
import type { FileEntity, PathAuthority } from "../fs/types";
import type { RenameEvidence, ScopeDisposition, ScopeProjection } from "./types";
import { projectRenameScope, projectScope } from "./scope-projection";

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
		["local", "included", "included", "rename_remote"],
		["local", "included", "policy_out", "delete_remote"],
		["local", "policy_out", "included", "push"],
		["remote", "included", "included", "rename_local"],
		["remote", "included", "policy_out", "delete_local"],
		["remote", "policy_out", "included", "pull"],
	] as const)("maps %s %s -> %s to %s only", (side, oldScope, newScope, consequence) => {
		expect(projectRenameScope(rename(side), projection(oldScope, newScope))).toEqual({
			consequence, oldDisposition: oldScope, newDisposition: newScope,
		});
	});

	it.each(["unknown", "mobile_deferred"] as const)(
		"defers the whole edge when either endpoint is %s",
		(disposition) => {
			for (const side of ["local", "remote"] as const) {
				expect(projectRenameScope(rename(side), projection(disposition, "included")).consequence)
					.toBe("defer");
				expect(projectRenameScope(rename(side), projection("included", disposition)).consequence)
					.toBe("defer");
			}
		},
	);

	it("performs no work when both endpoints are outside configured policy", () => {
		for (const side of ["local", "remote"] as const) {
			expect(projectRenameScope(rename(side), projection("policy_out", "policy_out")).consequence)
				.toBe("none");
		}
	});

	it("defers an out-of-policy folder when a descendant is included", () => {
		const folderRename: RenameEvidence = { ...rename("local", "old", "new"), isFolder: true };
		const result = projectRenameScope(folderRename, {
			byEndpoint: new Map([
				["old", "policy_out"], ["new", "policy_out"],
				["old/a.md", "included"], ["new/a.md", "included"],
			]),
		});

		expect(result.consequence).toBe("defer");
	});

	it("defaults a filter-lost endpoint to unknown and defers", () => {
		expect(projectRenameScope(rename("local"), {
			byEndpoint: new Map([["old.md", "included"]]),
		}).consequence).toBe("defer");
	});
});

describe("projectScope", () => {
	it("classifies rename endpoints before entries are filtered", () => {
		const result = projectScope(changeSet({
			entries: [{ path: "old.md", prevSync: {
				path: "old.md", hash: "h", localMtime: 1, remoteMtime: 1,
				localSize: 1, remoteSize: 1, syncedAt: 1,
			} }],
			observations: [{
				kind: "absent", side: "local", requestedPath: "old.md", authority: "stat",
			}],
			identityEvidence: [rename("local")],
		}), { classifyPath: (path) => path === "new.md" ? "policy_out" : "included" });

		expect(result.byEndpoint).toEqual(new Map([
			["old.md", "included"],
			["new.md", "policy_out"],
		]));
	});

	it("retains nested folder descendants and dot-path policy independently", () => {
		const folderRename: RenameEvidence = {
			...rename("local", "folder", ".archive"), isFolder: true,
		};
		const result = projectScope(changeSet({
			entries: [
				{ path: "folder/nested/a.md", local: entity("folder/nested/a.md") },
				{ path: ".archive/nested/a.md", local: entity(".archive/nested/a.md") },
			],
			observations: [
				{ kind: "absent", side: "local", requestedPath: "folder", authority: "stat" },
				{ kind: "exact", side: "local", requestedPath: ".archive", entity: directory(".archive") },
			],
			identityEvidence: [folderRename],
		}), { classifyPath: (path) => path.startsWith(".") ? "policy_out" : "included" });

		expect(result.byEndpoint).toEqual(new Map([
			["folder", "included"],
			[".archive", "policy_out"],
			["folder/nested/a.md", "included"],
			[".archive/nested/a.md", "policy_out"],
		]));
	});

	it("does not require incidental directory observations as folder-rename descendants", () => {
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
		}), { classifyPath: () => "included" });

		expect(result.byEndpoint.has("old/nested")).toBe(false);
		expect(result.byEndpoint.has("new/nested")).toBe(false);
		expect(projectRenameScope(folderRename, result).consequence).toBe("rename_remote");
	});

	it("keeps a not-observed included endpoint unknown", () => {
		const result = projectScope(changeSet({
			identityEvidence: [rename("local")],
			observations: [
				{ kind: "absent", side: "local", requestedPath: "old.md", authority: "stat" },
				{ kind: "unknown", side: "local", requestedPath: "new.md", reason: "not_observed" },
			],
		}), { classifyPath: () => "included" });

		expect(result.byEndpoint.get("new.md")).toBe("unknown");
		expect(projectRenameScope(rename("local"), result).consequence).toBe("defer");
	});

	it("does not treat an evidence-only included endpoint as classified", () => {
		const result = projectScope(changeSet({ identityEvidence: [rename("remote")] }), {
			classifyPath: () => "included",
		});

		expect(result.byEndpoint).toEqual(new Map([
			["old.md", "unknown"],
			["new.md", "unknown"],
		]));
	});

	it("retains a distinct unresolved returned path without treating it as exact", () => {
		const result = projectScope(changeSet({
			observations: [{
				kind: "present_unresolved", side: "remote", requestedPath: "A.md",
				returnedPath: ".hidden/A.md", entity: entity(".hidden/A.md", 20, "requested_echo"),
				source: "stat",
			}],
		}), {
			classifyPath: (path) => path.startsWith(".") ? "policy_out" : "included",
			mobileMaxBytes: 10,
		});

		expect(result.byEndpoint.get("A.md")).toBe("mobile_deferred");
		expect(result.byEndpoint.get(".hidden/A.md")).toBe("policy_out");
	});

	it("keeps an included unresolved returned path unknown", () => {
		const result = projectScope(changeSet({
			observations: [{
				kind: "present_unresolved", side: "remote", requestedPath: "A.md",
				returnedPath: "a.md", entity: entity("a.md", 1, "requested_echo"), source: "stat",
			}],
		}), { classifyPath: () => "included" });

		expect(result.byEndpoint.get("a.md")).toBe("unknown");
	});

	it("marks only oversized included endpoints mobile-deferred", () => {
		const result = projectScope(changeSet({
			entries: [
				{ path: "large.md", local: entity("large.md", 11) },
				{ path: "small.md", remote: entity("small.md", 10) },
				{ path: "excluded.md", local: entity("excluded.md", 20) },
			],
		}), {
			classifyPath: (path) => path === "excluded.md" ? "policy_out" : "included",
			mobileMaxBytes: 10,
		});

		expect(result.byEndpoint).toEqual(new Map([
			["large.md", "mobile_deferred"],
			["small.md", "included"],
			["excluded.md", "policy_out"],
		]));
	});

	it("treats a remote outside-root observation as policy-out authority", () => {
		const result = projectScope(changeSet({
			identityEvidence: [rename("remote")],
			observations: [
				{
					kind: "absent", side: "remote", requestedPath: "old.md",
					authority: "checkpoint_deleted",
				},
				{
					kind: "unknown", side: "remote", requestedPath: "new.md",
					reason: "outside_tracked_root",
				},
			],
		}), { classifyPath: () => "included" });

		expect(result.byEndpoint.get("new.md")).toBe("policy_out");
		expect(projectRenameScope(rename("remote"), result).consequence).toBe("delete_local");
	});

	it("preserves an explicit unknown policy classification", () => {
		const result = projectScope(changeSet({ identityEvidence: [rename("local")] }), {
			classifyPath: (path) => path === "new.md" ? "unknown" : "included",
		});

		expect(result.byEndpoint.get("new.md")).toBe("unknown");
		expect(projectRenameScope(rename("local"), result).consequence).toBe("defer");
	});

	it("defers a folder rename when descendant scope consequences differ", () => {
		const folderRename: RenameEvidence = { ...rename("local", "old", "new"), isFolder: true };
		const result = projectRenameScope(folderRename, {
			byEndpoint: new Map([
				["old", "included"], ["new", "included"],
				["old/a.md", "included"], ["new/a.md", "policy_out"],
			]),
		});

		expect(result.consequence).toBe("defer");
	});

	it("defers a folder rename when one descendant endpoint is missing", () => {
		const folderRename: RenameEvidence = { ...rename("remote", "old", "new"), isFolder: true };
		const result = projectRenameScope(folderRename, {
			byEndpoint: new Map([
				["old", "included"], ["new", "included"], ["new/a.md", "included"],
			]),
		});

		expect(result.consequence).toBe("defer");
	});

	it("permits a folder rename when every observed descendant has the same consequence", () => {
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
