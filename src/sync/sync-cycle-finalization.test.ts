import { describe, expect, it, vi } from "vitest";
import type { IncrementalCheckpoint } from "../fs/interface";
import type { ExecutionResult } from "./execution-result";
import {
	admitDestructivePlan,
	captureCycleAdmissionSnapshot,
	type AdmissionResult,
} from "./plan-admission";
import { finalizeSyncCycle } from "./sync-cycle-finalization";
import type { PathObservation, ScopeProjection, SyncAction } from "./types";

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
	scope: ScopeProjection,
	observations: PathObservation[] = [],
): AdmissionResult {
	return admitDestructivePlan(captureCycleAdmissionSnapshot(
		{ actions }, [], observations, scope, "onedrive:root",
	));
}

describe("finalizeSyncCycle", () => {
	it.each(["failed", "blocked"] as const)(
		"does not advance the checkpoint for a %s cycle",
		async (outcome) => {
			const action: SyncAction = { path: "note.md", action: "push" };
			const admitted = admission([action], {
				byEndpoint: new Map([["note.md", "included"]]),
			});
			const admittedAction = admitted.executable.actions[0]!;
			const commitCheckpoint = vi.fn().mockResolvedValue(undefined);
			const result: ExecutionResult = {
				succeeded: [], superseded: [], conflicts: [],
				failed: outcome === "failed"
					? [{ action: admittedAction, error: new Error("failed") }]
					: [],
				blocked: outcome === "blocked"
					? [{ action: admittedAction, reason: "blocked" }]
					: [],
			};

			await finalizeSyncCycle({
				admission: admitted, result,
				checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			});

			expect(commitCheckpoint).not.toHaveBeenCalled();
		},
	);

	it("does not advance the checkpoint after admission rejects an action", async () => {
		const failedAdmission = admission(
			[{ path: "note.md", action: "delete_remote" }],
			{ byEndpoint: new Map([["note.md", "included"]]) },
			[{ kind: "unknown", side: "local", requestedPath: "note.md", reason: "not_observed" }],
		);
		const commitCheckpoint = vi.fn().mockResolvedValue(undefined);

		expect(failedAdmission.failures).toHaveLength(1);
		await finalizeSyncCycle({
			admission: failedAdmission,
			result: { succeeded: [], superseded: [], conflicts: [], failed: [], blocked: [] },
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
	});

	it("requires terminal proof before committing a fresh rename", async () => {
		const action = {
			path: "new.md", action: "match", freshRenameState: "converged",
			oldPath: "old.md", normalizedRenameState: {},
		} as unknown as SyncAction;
		const admitted = admission([action], {
			byEndpoint: new Map([["new.md", "included"]]),
		});
		const admittedAction = admitted.executable.actions[0]!;
		const commitCheckpoint = vi.fn().mockResolvedValue(undefined);

		await finalizeSyncCycle({
			admission: admitted,
			result: {
				succeeded: [{ action: admittedAction }], superseded: [], conflicts: [],
				failed: [], blocked: [],
			},
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
	});

	it("commits only after every admitted action reaches terminal success", async () => {
		const action: SyncAction = { path: "note.md", action: "push" };
		const admitted = admission([action], {
			byEndpoint: new Map([["note.md", "included"]]),
		});
		const admittedAction = admitted.executable.actions[0]!;
		const commitCheckpoint = vi.fn().mockResolvedValue(undefined);

		await finalizeSyncCycle({
			admission: admitted,
			result: {
				succeeded: [{ action: admittedAction }], superseded: [], conflicts: [],
				failed: [], blocked: [],
			},
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
		});

		expect(commitCheckpoint).toHaveBeenCalledOnce();
	});

	it("does not commit when detached evidence invalidated an actionless cycle", async () => {
		const admitted = admission([], { byEndpoint: new Map() });
		const commitCheckpoint = vi.fn().mockResolvedValue(undefined);

		await finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [], conflicts: [], failed: [], blocked: [] },
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			checkpointBlocked: true,
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
	});

	it("propagates checkpoint persistence failure", async () => {
		const admitted = admission([], { byEndpoint: new Map() });

		await expect(finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [], conflicts: [], failed: [], blocked: [] },
			checkpoint: checkpoint(vi.fn().mockRejectedValue(new Error("checkpoint failed"))),
			scopeFingerprint: "scope",
		})).rejects.toThrow("checkpoint failed");
	});
});
