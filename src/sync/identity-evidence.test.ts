import { describe, expect, it } from "vitest";
import type { FileEntity } from "../fs/types";
import type { MixedEntity, PathObservation } from "./types";
import {
	collectLocalRenameEvidence,
	collectRemoteRenameEvidence,
	completeIdentityEvidence,
	renameOptimizerView,
} from "./identity-evidence";

describe("identity evidence", () => {
	it("normalizes tracker and checkpoint reports into one rename representation", () => {
		const local = collectLocalRenameEvidence({
			dirtyPaths: new Set(), renamePairs: new Map([["b.md", "a.md"]]),
			folderRenamePairs: new Map([["Docs", "docs"]]), initialized: true,
		});
		const remote = collectRemoteRenameEvidence([
			{ oldPath: "x.md", newPath: "y.md" },
			{ oldPath: "x.md", newPath: "y.md" },
		]);

		expect(local).toHaveLength(2);
		expect(remote).toEqual([{
			kind: "rename", side: "remote", oldPath: "x.md", newPath: "y.md",
			isFolder: false, authority: "reported",
		}]);
		const view = renameOptimizerView([...local, ...remote]);
		expect(view.localFiles.get("b.md")).toBe("a.md");
		expect(view.localFolders.get("Docs")).toBe("docs");
		expect(view.remote).toEqual([{ oldPath: "x.md", newPath: "y.md", isFolder: undefined }]);
	});

	it("attaches native identity and relates cross-path baseline/current occurrences", () => {
		const remote: FileEntity = {
			path: "b.md", pathAuthority: "actual_resolved", identityKey: "id-1",
			isDirectory: false, size: 1, mtime: 1, hash: "",
		};
		const observations: PathObservation[] = [
			{ kind: "exact", side: "remote", requestedPath: "b.md", entity: remote },
		];
		const entries: MixedEntity[] = [{
			path: "a.md",
			prevSync: {
				path: "a.md", hash: "h", localMtime: 1, remoteMtime: 1,
				localSize: 1, remoteSize: 1, remoteIdentityKey: "id-1", syncedAt: 1,
			},
		}, { path: "b.md", remote }];
		const completed = completeIdentityEvidence(
			collectRemoteRenameEvidence([{ oldPath: "a.md", newPath: "b.md" }]),
			observations,
			entries,
		);

		expect(completed[0]).toMatchObject({ kind: "rename", identityKey: "id-1" });
		expect(completed).toContainEqual({
			kind: "stable_identity", side: "remote", identityKey: "id-1",
			occurrences: [
				{ side: "remote", phase: "baseline", path: "a.md", identityKey: "id-1" },
				{ side: "remote", phase: "current", path: "b.md", identityKey: "id-1" },
			],
		});
	});

	it("does not create cross-path evidence for ordinary same-path continuity", () => {
		const remote: FileEntity = {
			path: "a.md", pathAuthority: "actual_resolved", identityKey: "id-1",
			isDirectory: false, size: 1, mtime: 1, hash: "",
		};
		const completed = completeIdentityEvidence([], [
			{ kind: "exact", side: "remote", requestedPath: "a.md", entity: remote },
		], [{
			path: "a.md", remote,
			prevSync: {
				path: "a.md", hash: "h", localMtime: 1, remoteMtime: 1,
				localSize: 1, remoteSize: 1, remoteIdentityKey: "id-1", syncedAt: 1,
			},
		}]);

		expect(completed).toEqual([]);
	});
});
