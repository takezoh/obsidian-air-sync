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

function checkpoint(commitCheckpoint: IncrementalCheckpoint["commitCheckpoint"]): {
	value: IncrementalCheckpoint;
	abortWorkingView: ReturnType<typeof vi.fn>;
} {
	const abortWorkingView = vi.fn().mockResolvedValue(undefined);
	return { value: {
		getChangedPaths: vi.fn().mockResolvedValue(null),
		hasCheckpoint: vi.fn().mockResolvedValue(true),
		abortWorkingView,
		resetCheckpoint: vi.fn().mockResolvedValue(undefined),
		commitCheckpoint,
	}, abortWorkingView };
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
			const cycleCheckpoint = checkpoint(commitCheckpoint);
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
				checkpoint: cycleCheckpoint.value, scopeFingerprint: "scope",
			});

			expect(commitCheckpoint).not.toHaveBeenCalled();
			expect(cycleCheckpoint.abortWorkingView).toHaveBeenCalledOnce();
		},
	);

	it("does not advance the checkpoint after admission rejects an action", async () => {
		const failedAdmission = admission(
			[{ path: "note.md", action: "delete_remote" }],
			{ byEndpoint: new Map([["note.md", "included"]]) },
			[{ kind: "unknown", side: "local", requestedPath: "note.md", reason: "not_observed" }],
		);
		const commitCheckpoint = vi.fn().mockResolvedValue(undefined);
		const cycleCheckpoint = checkpoint(commitCheckpoint);

		expect(failedAdmission.failures).toHaveLength(1);
		await finalizeSyncCycle({
			admission: failedAdmission,
			result: { succeeded: [], superseded: [], conflicts: [], failed: [], blocked: [] },
			checkpoint: cycleCheckpoint.value, scopeFingerprint: "scope",
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
		expect(cycleCheckpoint.abortWorkingView).toHaveBeenCalledOnce();
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
		const cycleCheckpoint = checkpoint(commitCheckpoint);

		await finalizeSyncCycle({
			admission: admitted,
			result: {
				succeeded: [{ action: admittedAction }], superseded: [], conflicts: [],
				failed: [], blocked: [],
			},
			checkpoint: cycleCheckpoint.value, scopeFingerprint: "scope",
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
		expect(cycleCheckpoint.abortWorkingView).toHaveBeenCalledOnce();
	});

	it("commits only after every admitted action reaches terminal success", async () => {
		const action: SyncAction = { path: "note.md", action: "push" };
		const admitted = admission([action], {
			byEndpoint: new Map([["note.md", "included"]]),
		});
		const admittedAction = admitted.executable.actions[0]!;
		const commitCheckpoint = vi.fn().mockResolvedValue(undefined);
		const cycleCheckpoint = checkpoint(commitCheckpoint);

		await finalizeSyncCycle({
			admission: admitted,
			result: {
				succeeded: [{ action: admittedAction }], superseded: [], conflicts: [],
				failed: [], blocked: [],
			},
			checkpoint: cycleCheckpoint.value, scopeFingerprint: "scope",
		});

		expect(commitCheckpoint).toHaveBeenCalledOnce();
		expect(cycleCheckpoint.abortWorkingView).not.toHaveBeenCalled();
	});

	it("does not commit when detached evidence invalidated an actionless cycle", async () => {
		const admitted = admission([], { byEndpoint: new Map() });
		const commitCheckpoint = vi.fn().mockResolvedValue(undefined);
		const cycleCheckpoint = checkpoint(commitCheckpoint);

		await finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [], conflicts: [], failed: [], blocked: [] },
			checkpoint: cycleCheckpoint.value, scopeFingerprint: "scope",
			checkpointBlocked: true,
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
		expect(cycleCheckpoint.abortWorkingView).toHaveBeenCalledOnce();
	});

	it("is a no-op when the filesystem has no checkpoint capability", async () => {
		const admitted = admission([], { byEndpoint: new Map() });

		await expect(finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [], conflicts: [], failed: [], blocked: [] },
			checkpoint: undefined, scopeFingerprint: "scope",
		})).resolves.toBeUndefined();
	});

	it("propagates checkpoint persistence failure", async () => {
		const admitted = admission([], { byEndpoint: new Map() });

		await expect(finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [], conflicts: [], failed: [], blocked: [] },
			checkpoint: checkpoint(vi.fn().mockRejectedValue(new Error("checkpoint failed"))).value,
			scopeFingerprint: "scope",
		})).rejects.toThrow("checkpoint failed");
	});
});
