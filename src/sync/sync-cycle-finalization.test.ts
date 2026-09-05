import { describe, expect, it, vi } from "vitest";
import type { IncrementalCheckpoint } from "../fs/interface";
import type { ExecutionResult } from "./execution-result";
import {
	admitBatchObservation,
	type AdmissionResult,
} from "./plan-admission";
import { captureBatchObservation } from "./sync-cycle-planning";
import { finalizeSyncCycle, runSyncCycleAttempt, WorkingViewAbortError } from "./sync-cycle-finalization";
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
	const local = { path: "note.md", pathAuthority: "actual_resolved" as const,
		isDirectory: false, hash: "h", size: 1, mtime: 1 };
	return admitBatchObservation(captureBatchObservation(
		actions.map((action) => ({ path: action.path, local: action.local ?? { ...local, path: action.path },
			remote: action.remote, prevSync: action.baseline })), [],
		observations.length ? observations : actions.map((action) => ({
			kind: "absent" as const, side: "remote" as const, requestedPath: action.path, authority: "stat" as const,
		})), scope, "onedrive:root",
	));
}

describe("finalizeSyncCycle", () => {
	it("accepts priority replacement only with the exact action's successful publication receipt", async () => {
		const local = { path: "note.md", pathAuthority: "actual_resolved" as const,
			isDirectory: false, size: 1, mtime: 1, hash: "old" };
		const remote = { ...local, mtime: 2, hash: "new", identityKey: "R" };
		const baseline = { path: local.path, hash: "old", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "R", syncedAt: 1 };
		const admitted = admission([{ action: "pull", path: local.path, local, remote, baseline }], {
			byEndpoint: new Map([[local.path, "included"]]), isConfiguredScopeCompatible: () => true,
		}, [
			{ kind: "exact", side: "local", requestedPath: local.path, entity: local },
			{ kind: "exact", side: "remote", requestedPath: local.path, entity: remote },
		]);
		const action = admitted.executable.actions[0]!;
		expect(admitted.executable.components[0]?.priorityPullAction).toBe(action);
		const terminalRecord = { ...baseline, hash: "new", localMtime: 2, remoteMtime: 2 };
		for (const [superseded, expected] of [
			[[action], "incomplete"],
			[[{ action, terminalRecord }], "clean"],
			[[{ action: { ...action }, terminalRecord }], "incomplete"],
			[[{ action, terminalRecord: { ...terminalRecord, remoteIdentityKey: "foreign" } }], "incomplete"],
		] as const) {
			const cycleCheckpoint = checkpoint(vi.fn().mockResolvedValue(undefined));
			const completion = await finalizeSyncCycle({ admission: admitted,
				result: { succeeded: [], failed: [], blocked: [], conflicts: [],
					superseded: superseded as unknown as ExecutionResult["superseded"] },
				checkpoint: cycleCheckpoint.value, scopeFingerprint: "scope" });
			expect(completion.kind).toBe(expected);
		}
	});
	it.each(["failed", "blocked"] as const)(
		"does not advance the checkpoint for a %s cycle",
		async (outcome) => {
			const action: SyncAction = { path: "note.md", action: "push" };
			const admitted = admission([action], {
				isConfiguredScopeCompatible: () => true, byEndpoint: new Map([["note.md", "included"]]),
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
			{ isConfiguredScopeCompatible: () => true, byEndpoint: new Map([["note.md", "included"]]) },
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

	it("requires terminal proof before publishing a relocated record", async () => {
		const local = { path: "new.md", pathAuthority: "actual_resolved" as const,
			isDirectory: false, hash: "h", size: 1, mtime: 1 };
		const remote = { ...local, identityKey: "R" };
		const baseline = { path: "old.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "R", syncedAt: 1 };
		const action: SyncAction = { path: "new.md", action: "match", local, remote, baseline };
		const admitted = admission([action], {
			isConfiguredScopeCompatible: () => true, byEndpoint: new Map([["old.md", "included"], ["new.md", "included"]]),
		}, [
			{ kind: "alias", side: "local", requestedPath: "old.md", resolvedPath: "new.md", entity: local },
			{ kind: "absent", side: "remote", requestedPath: "old.md", authority: "stat" },
		]);
		expect(admitted.failures).toEqual([]);
		expect(admitted.executable.actions).toHaveLength(1);
		const admittedAction = admitted.executable.actions[0]!;
		expect(admittedAction).toMatchObject({ action: "match", publication: { source: baseline } });
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
			isConfiguredScopeCompatible: () => true, byEndpoint: new Map([["note.md", "included"]]),
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
		const admitted = admission([], { isConfiguredScopeCompatible: () => true, byEndpoint: new Map() });
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
		const admitted = admission([], { isConfiguredScopeCompatible: () => true, byEndpoint: new Map() });

		await expect(finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [], conflicts: [], failed: [], blocked: [] },
			checkpoint: undefined, scopeFingerprint: "scope",
		})).resolves.toEqual({ kind: "clean" });
	});

	it("propagates checkpoint persistence failure", async () => {
		const admitted = admission([], { isConfiguredScopeCompatible: () => true, byEndpoint: new Map() });
		const cycleCheckpoint = checkpoint(vi.fn().mockRejectedValue(new Error("checkpoint failed")));

		await expect(finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [], superseded: [], conflicts: [], failed: [], blocked: [] },
			checkpoint: cycleCheckpoint.value,
			scopeFingerprint: "scope",
		})).rejects.toThrow("checkpoint failed");
		expect(cycleCheckpoint.abortWorkingView).toHaveBeenCalledOnce();
	});

	it("settles scheduled siblings before aborting a failed attempt", async () => {
		const commit = vi.fn().mockResolvedValue(undefined);
		const remote = checkpoint(commit);
		const events: string[] = [];
		remote.value.abortWorkingView = () => { events.push("abort"); return Promise.resolve(); };
		const error = new Error("observation failed");
		await expect(runSyncCycleAttempt(remote.value, () => Promise.reject(error), async (close) => {
			events.push("siblings settled");
			return close();
		}, () => { throw new Error("must not finalize failed work"); })).rejects.toBe(error);
		expect(events).toEqual(["siblings settled", "abort"]);
		expect(commit).not.toHaveBeenCalled();
	});

	it("closes synchronous work exceptions at the same boundary", async () => {
		const remote = checkpoint(vi.fn().mockResolvedValue(undefined));
		const error = new Error("synchronous observation failure");
		await expect(runSyncCycleAttempt(remote.value, () => { throw error; }, (close) => close(),
			() => { throw new Error("unreachable"); })).rejects.toBe(error);
		expect(remote.abortWorkingView).toHaveBeenCalledOnce();
	});

	it("does not catch and repeat an abort failure", async () => {
		const remote = checkpoint(vi.fn().mockResolvedValue(undefined));
		remote.abortWorkingView.mockRejectedValue(new Error("abort failed"));
		await expect(runSyncCycleAttempt(remote.value, () => Promise.reject(new Error("work failed")),
			(close) => close(), () => { throw new Error("unreachable"); })).rejects.toBeInstanceOf(WorkingViewAbortError);
		expect(remote.abortWorkingView).toHaveBeenCalledOnce();
	});

	it("does not accept a copied action as the admitted action's success", async () => {
		const admitted = admission([{ action: "push", path: "note.md" }], {
			isConfiguredScopeCompatible: () => true, byEndpoint: new Map([["note.md", "included"]]),
		});
		expect(admitted.executable.actions).toHaveLength(1);
		const remote = checkpoint(vi.fn().mockResolvedValue(undefined));
		const completion = await finalizeSyncCycle({ admission: admitted,
			result: { succeeded: [{ action: { ...admitted.executable.actions[0]! } }],
				superseded: [], conflicts: [], failed: [], blocked: [] },
			checkpoint: remote.value, scopeFingerprint: "scope" });
		expect(completion).toEqual({ kind: "incomplete" });
		expect(remote.abortWorkingView).toHaveBeenCalledOnce();
	});
});
