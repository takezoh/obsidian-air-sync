import { describe, expect, it } from "vitest";
import type { FileEntity } from "../fs/types";
import type { MixedEntity, PathObservation } from "./types";
import {
	collectLocalRenameEvidence,
	collectRemoteRenameEvidence,
	completeIdentityEvidence,
} from "./identity-evidence";

describe("identity evidence", () => {
	it("keeps committed identity occurrences at the record key, not the observation address", () => {
		const remote: FileEntity = { path: "b.md", pathAuthority: "actual_resolved", identityKey: "R",
			isDirectory: false, size: 1, mtime: 1, hash: "h" };
		const completed = completeIdentityEvidence([], [], [{ path: "b.md", remote, prevSync: {
			path: "a.md", hash: "h", localMtime: 1, remoteMtime: 1, localSize: 1, remoteSize: 1,
			remoteIdentityKey: "R", syncedAt: 1,
		} }]);
		expect(completed).toContainEqual({ kind: "stable_identity", side: "remote", identityKey: "R", occurrences: [
			{ side: "remote", phase: "baseline", path: "a.md", identityKey: "R" },
			{ side: "remote", phase: "current", path: "b.md", identityKey: "R" },
		] });
	});

	it("normalizes tracker and checkpoint reports into one rename representation", () => {
		const local = collectLocalRenameEvidence({
			dirtyPaths: new Set(), renamePairs: new Map([["b.md", "a.md"]]),
			folderRenamePairs: new Map([["Docs", "docs"]]), initialized: true,
		});
		const remote = collectRemoteRenameEvidence([
			{ oldPath: "x.md", newPath: "y.md" },
			{ oldPath: "x.md", newPath: "y.md" },
		]);

		expect(local).toEqual([
			{ kind: "rename", side: "local", oldPath: "a.md", newPath: "b.md", isFolder: false, authority: "reported" },
			{ kind: "rename", side: "local", oldPath: "docs", newPath: "Docs", isFolder: true, authority: "reported" },
		]);
		expect(remote).toEqual([{
			kind: "rename", side: "remote", oldPath: "x.md", newPath: "y.md",
			isFolder: false, authority: "reported",
		}]);
	});

	it("keeps the producer's identity on a remote rename claim and adds none where the pair carries none", () => {
		const [keyed, unkeyed] = collectRemoteRenameEvidence([
			{ oldPath: "x.md", newPath: "y.md", identityKey: "drive-1" },
			{ oldPath: "p.md", newPath: "q.md" },
		]);

		expect(keyed).toStrictEqual({
			kind: "rename", side: "remote", oldPath: "x.md", newPath: "y.md",
			isFolder: false, authority: "reported", identityKey: "drive-1",
		});
		expect(unkeyed).toStrictEqual({
			kind: "rename", side: "remote", oldPath: "p.md", newPath: "q.md",
			isFolder: false, authority: "reported",
		});
		// Absent, not present-and-undefined: nothing is added for a pair that carried none.
		expect("identityKey" in unkeyed!).toBe(false);
	});

	it("counts a carried, an absent and an empty identity as three claims on one edge", () => {
		const evidence = collectRemoteRenameEvidence([
			{ oldPath: "x.md", newPath: "y.md", identityKey: "drive-1" },
			{ oldPath: "x.md", newPath: "y.md", identityKey: "drive-1" },
			{ oldPath: "x.md", newPath: "y.md", identityKey: "drive-2" },
			{ oldPath: "x.md", newPath: "y.md" },
			{ oldPath: "x.md", newPath: "y.md", identityKey: "" },
		]);

		// Two claims naming different objects on one edge both survive collection, so the
		// report family gets to classify the conflict instead of `Map.set` hiding it. Only
		// the genuinely identical repeat collapses. Absent and empty are two of the three
		// states here — this module's encoding rule, not the record layer's admissibility
		// rule, where an absent and an empty provider identity are one inadmissible case.
		expect(evidence.map((item) => "identityKey" in item ? `present:${item.identityKey}` : "absent"))
			.toEqual(["present:drive-1", "present:drive-2", "absent", "present:"]);
	});

	it("infers no identity for a local rename claim whose destination is a known remote object", () => {
		const remote: FileEntity = {
			path: "b.md", pathAuthority: "actual_resolved", identityKey: "id-1",
			isDirectory: false, size: 1, mtime: 1, hash: "",
		};
		const completed = completeIdentityEvidence(
			collectLocalRenameEvidence({
				dirtyPaths: new Set(), renamePairs: new Map([["b.md", "a.md"]]),
				folderRenamePairs: new Map(), initialized: true,
			}),
			[{ kind: "exact", side: "remote", requestedPath: "b.md", entity: remote }],
			[{ path: "b.md", remote }],
		);

		expect(completed).toStrictEqual([{
			kind: "rename", side: "local", oldPath: "a.md", newPath: "b.md",
			isFolder: false, authority: "reported",
		}]);
	});

	it("hands a remote rename claim to Admission unkeyed and still relates cross-path occurrences", () => {
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

		// The pair carried no identity, so the claim reaches Admission with none. The
		// destination's own key is not attached here: it is the same value Admission's
		// remote-rename check reads back out of `current.remote`, so filling it would make
		// that check compare a value to its own source.
		expect(completed[0]).toStrictEqual({
			kind: "rename", side: "remote", oldPath: "a.md", newPath: "b.md",
			isFolder: false, authority: "reported",
		});
		// The occurrence index is a separate pass over the same map and is unchanged.
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
