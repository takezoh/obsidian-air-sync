import { describe, expect, it, vi } from "vitest";
import type { IncrementalCheckpoint } from "../fs/interface";
import type { ExecutionResult } from "./execution-result";
import { finalizeSyncCycle } from "./sync-cycle-finalization";
import type { SyncStateStore } from "./state";
import type { IdentityEvidence, SyncAction } from "./types";

function checkpoint(commitCheckpoint: IncrementalCheckpoint["commitCheckpoint"]): IncrementalCheckpoint {
	return {
		getChangedPaths: vi.fn().mockResolvedValue(null),
		hasCheckpoint: vi.fn().mockResolvedValue(true),
		resetCheckpoint: vi.fn().mockResolvedValue(undefined),
		commitCheckpoint,
	};
}

describe("finalizeSyncCycle", () => {
	it("holds the cursor and remote evidence when connected work is blocked", async () => {
		const edge: IdentityEvidence = {
			kind: "rename", side: "remote", oldPath: "A.md", newPath: "a.md",
			isFolder: false, authority: "reported",
		};
		const action: SyncAction = { action: "rename_local", oldPath: "A.md", path: "a.md" };
		const result: ExecutionResult = {
			succeeded: [], failed: [], conflicts: [], deferred: [],
			blocked: [{ action, reason: "quarantined" }],
		};
		const commitCheckpoint = vi.fn<IncrementalCheckpoint["commitCheckpoint"]>()
			.mockResolvedValue(undefined);
		const deleteRenameDebts = vi.fn().mockResolvedValue(undefined);

		const retained = await finalizeSyncCycle({
			result, pendingEvidence: [edge], persistedDebts: [], localRenameDebts: [],
			scopeProjection: { byEndpoint: new Map([["A.md", "included"], ["a.md", "included"]]) },
			observations: [], checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts } as unknown as SyncStateStore,
		});

		expect(retained).toEqual([edge]);
		expect(commitCheckpoint).not.toHaveBeenCalled();
		expect(deleteRenameDebts).not.toHaveBeenCalled();
	});
});
