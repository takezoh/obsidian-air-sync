import { describe, expect, it, vi } from "vitest";
import type { IncrementalCheckpoint } from "../fs/interface";
import type { ExecutionResult } from "./execution-result";
import { finalizeSyncCycle } from "./sync-cycle-finalization";
import type { SyncStateStore } from "./state";
import type { IdentityEvidence, PathObservation, ScopeProjection, SyncAction } from "./types";
import {
	admitDestructivePlan,
	captureCycleAdmissionSnapshot,
	type AdmissionResult,
} from "./plan-admission";

function checkpoint(commitCheckpoint: IncrementalCheckpoint["commitCheckpoint"]): IncrementalCheckpoint {
	return {
		getChangedPaths: vi.fn().mockResolvedValue(null),
		hasCheckpoint: vi.fn().mockResolvedValue(true),
		resetCheckpoint: vi.fn().mockResolvedValue(undefined),
		commitCheckpoint,
	};
}

function admission(
	actions: SyncAction[],
	evidence: IdentityEvidence[],
	scope: ScopeProjection,
	observations: PathObservation[] = [],
): AdmissionResult {
	return admitDestructivePlan(captureCycleAdmissionSnapshot(
		{ actions }, evidence, observations, scope, "onedrive:root",
	));
}

function edge(side: "local" | "remote" = "remote"): IdentityEvidence {
	return {
		kind: "rename", side, oldPath: "A.md", newPath: "a.md",
		isFolder: false, authority: "reported",
	};
}

describe("finalizeSyncCycle", () => {
	it("accepts only the Admission-marked exact singleton pull as superseded", async () => {
		const baseline = {
			path: "note.md", hash: "old", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "remote-id", syncedAt: 1,
		};
		const local = { path: "note.md", isDirectory: false, size: 1, mtime: 1, hash: "old" };
		const remote = { ...local, mtime: 2, hash: "new", identityKey: "remote-id" };
		const action: SyncAction = { path: "note.md", action: "pull", local, remote, baseline };
		const admitted = admission([action], [], { byEndpoint: new Map([["note.md", "included"]]) }, [
			{ kind: "exact", side: "local", requestedPath: "note.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "note.md", entity: remote },
		]);
		const commitCheckpoint = vi.fn().mockResolvedValue(undefined);
		const deleteRenameDebts = vi.fn().mockResolvedValue(undefined);

		await finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [action], failed: [], blocked: [], conflicts: [], deferred: [] },
			pendingEvidence: [], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts } as unknown as SyncStateStore,
		});

		expect(commitCheckpoint).toHaveBeenCalledOnce();

		commitCheckpoint.mockClear();
		await finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [{ ...action }], failed: [], blocked: [], conflicts: [], deferred: [] },
			pendingEvidence: [], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts } as unknown as SyncStateStore,
		});
		expect(commitCheckpoint).not.toHaveBeenCalled();
	});

	it("does not infer an actionless rename no-op from scope during finalization", async () => {
		const pending = edge();
		const commitCheckpoint = vi.fn<IncrementalCheckpoint["commitCheckpoint"]>()
			.mockResolvedValue(undefined);
		const deleteRenameDebts = vi.fn().mockResolvedValue(undefined);
		const admitted = admission([], [pending], { byEndpoint: new Map([
			["A.md", "unknown"], ["a.md", "unknown"],
		]) });

		const retained = await finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [], failed: [], blocked: [], conflicts: [], deferred: [] },
			pendingEvidence: [pending], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts } as unknown as SyncStateStore,
		});

		expect(retained).toEqual([pending]);
		expect(commitCheckpoint).not.toHaveBeenCalled();
		expect(deleteRenameDebts).not.toHaveBeenCalled();
	});

	it("holds the cursor and remote evidence when connected work is blocked", async () => {
		const pending = edge();
		const action: SyncAction = { action: "rename_local", oldPath: "A.md", path: "a.md" };
		const admitted = admission([action], [pending], { byEndpoint: new Map([
			["A.md", "included"], ["a.md", "included"],
		]) });
		const result: ExecutionResult = {
			succeeded: [], superseded: [], failed: [], conflicts: [], deferred: [],
			blocked: [{ action, reason: "quarantined" }],
		};
		const commitCheckpoint = vi.fn<IncrementalCheckpoint["commitCheckpoint"]>()
			.mockResolvedValue(undefined);
		const deleteRenameDebts = vi.fn().mockResolvedValue(undefined);

		const retained = await finalizeSyncCycle({
			admission: admitted, result, pendingEvidence: [pending], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts } as unknown as SyncStateStore,
		});

		expect(retained).toEqual([pending]);
		expect(commitCheckpoint).not.toHaveBeenCalled();
		expect(deleteRenameDebts).not.toHaveBeenCalled();
	});

	it("withholds a clean checkpoint when detached evidence invalidated an actionless cycle", async () => {
		const commitCheckpoint = vi.fn<IncrementalCheckpoint["commitCheckpoint"]>()
			.mockResolvedValue(undefined);
		const deleteRenameDebts = vi.fn().mockResolvedValue(undefined);
		const admitted = admission([], [], { byEndpoint: new Map() });

		await finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [], failed: [], blocked: [], conflicts: [], deferred: [] },
			pendingEvidence: [], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts } as unknown as SyncStateStore,
			checkpointBlocked: true,
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
		expect(deleteRenameDebts).not.toHaveBeenCalled();
	});

	it("commits the checkpoint before retiring resolved-no-action evidence", async () => {
		const pending = edge();
		const admitted = admission([], [pending], { byEndpoint: new Map([
			["A.md", "policy_out"], ["a.md", "policy_out"],
		]) });
		const order: string[] = [];
		const commitCheckpoint = vi.fn<IncrementalCheckpoint["commitCheckpoint"]>()
			.mockImplementation(() => { order.push("checkpoint"); return Promise.resolve(); });
		const deleteRenameDebts = vi.fn().mockImplementation(() => {
			order.push("retire");
			return Promise.resolve();
		});

		const retained = await finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [], failed: [], blocked: [], conflicts: [], deferred: [] },
			pendingEvidence: [pending], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts } as unknown as SyncStateStore,
		});

		expect(retained).toEqual([]);
		expect(order).toEqual(["checkpoint", "retire"]);
	});

	it("leaves evidence and debt untouched when checkpoint persistence fails", async () => {
		const pending = edge();
		const admitted = admission([], [pending], { byEndpoint: new Map([
			["A.md", "policy_out"], ["a.md", "policy_out"],
		]) });
		const deleteRenameDebts = vi.fn().mockResolvedValue(undefined);

		await expect(finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [], failed: [], blocked: [], conflicts: [], deferred: [] },
			pendingEvidence: [pending], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(vi.fn().mockRejectedValue(new Error("checkpoint failed"))),
			scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts } as unknown as SyncStateStore,
		})).rejects.toThrow("checkpoint failed");
		expect(deleteRenameDebts).not.toHaveBeenCalled();
	});
});
