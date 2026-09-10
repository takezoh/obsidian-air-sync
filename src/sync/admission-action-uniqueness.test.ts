import { describe, expect, it } from "vitest";
import type { FileEntity } from "../fs/types";
import { admitBatchObservation } from "./plan-admission";
import { captureBatchObservation } from "./sync-cycle-planning";
import type { PathObservation, SyncRecord } from "./types";

function entity(path: string, hash: string, identityKey?: string): FileEntity {
	return {
		path, hash, identityKey, pathAuthority: "actual_resolved",
		isDirectory: false, size: 1, mtime: 1,
	};
}

describe("Admission action-key exclusivity", () => {
	it("binds a rename destination baseline only once when its remote endpoint is absent", () => {
		const localB = entity("B.md", "local-b");
		const remoteA = entity("A.md", "remote-a", "R-A");
		const baselineB: SyncRecord = {
			path: "B.md", hash: "baseline-b", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "R-B", syncedAt: 1,
		};
		const observations: PathObservation[] = [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: remoteA },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: localB },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
		];
		const admission = admitBatchObservation(captureBatchObservation([
			{ path: "A.md", remote: remoteA },
			{ path: "B.md", local: localB, prevSync: baselineB },
		], [{
			kind: "rename", side: "local", oldPath: "A.md", newPath: "B.md",
			isFolder: false, authority: "reported",
		}], observations, {
			byEndpoint: new Map([["A.md", "included"], ["B.md", "included"]]),
			isConfiguredScopeCompatible: () => true,
		}, "action-key-exclusivity"));

		expect(admission.failures).toEqual([]);
		expect(admission.executable.actions).toMatchObject([{
			action: "conflict", path: "B.md",
			publication: { destination: { path: "B.md" } },
		}]);
		expect(admission.executable.actions).toHaveLength(1);
	});
});
