import { describe, expect, it } from "vitest";
import { admitDestructivePlan, captureCycleAdmissionSnapshot } from "./plan-admission";
import { PriorityBatchState } from "./priority-batch-state";
import type { PathObservation, SyncAction, SyncRecord } from "./types";

function admittedPull(path = "note.md") {
	const baseline: SyncRecord = {
		path, hash: "old", localMtime: 1, remoteMtime: 1,
		localSize: 1, remoteSize: 1, remoteIdentityKey: "remote-id", syncedAt: 1,
	};
	const local = {
		path, pathAuthority: "actual_resolved" as const,
		isDirectory: false, size: 1, mtime: 1, hash: "old",
	};
	const remote = {
		path, pathAuthority: "actual_resolved" as const,
		isDirectory: false, size: 2, mtime: 2, hash: "", identityKey: "remote-id",
	};
	const action: SyncAction = { path, action: "pull", baseline, local, remote };
	const observations: PathObservation[] = [
		{ kind: "exact", side: "local", requestedPath: path, entity: local },
		{ kind: "exact", side: "remote", requestedPath: path, entity: remote },
	];
	const snapshot = captureCycleAdmissionSnapshot(
		{ actions: [action] }, [], observations,
		{ byEndpoint: new Map([[path, "included"]]) }, "priority-batch-test",
	);
	return { action, admission: admitDestructivePlan(snapshot) };
}

describe("PriorityBatchState", () => {
	it("supersedes only the exact pending pull action authorized by Admission", () => {
		const { action, admission } = admittedPull();
		const batch = new PriorityBatchState(admission);

		const target = batch.priorityTarget(action.path);
		expect(target).toEqual({ kind: "superseding", action });
		expect(target.kind === "superseding" && batch.supersede(target.action)).toBe(true);
		expect(batch.beginAction(action)).toBe("superseded");
	});

	it("defers after the transfer phase instead of changing a frozen route", () => {
		const { action, admission } = admittedPull();
		const batch = new PriorityBatchState(admission);
		batch.setPhase("structural");

		expect(batch.priorityTarget(action.path)).toEqual({ kind: "defer" });
		expect(batch.beginAction(action)).toBe("run");
	});

	it("defers an actionless disposition because its retained observation is non-exact", () => {
		const snapshot = captureCycleAdmissionSnapshot(
			{ actions: [] }, [], [{
				kind: "unknown", side: "remote", requestedPath: "note.md",
				reason: "not_observed",
			}], { byEndpoint: new Map([["note.md", "included"]]) }, "priority-batch-test",
		);
		const batch = new PriorityBatchState(admitDestructivePlan(snapshot));
		expect(batch.priorityTarget("note.md")).toEqual({ kind: "defer" });
	});

	it("marks a stale pending action invalid without substituting another action", () => {
		const { action, admission } = admittedPull();
		const batch = new PriorityBatchState(admission);
		expect(batch.invalidate(action)).toBe(true);
		expect(batch.beginAction(action)).toBe("invalidated");
	});

	it("blocks checkpoint independently of exact action membership", () => {
		const { admission } = admittedPull();
		const batch = new PriorityBatchState(admission);
		expect(batch.isCheckpointBlocked).toBe(false);
		batch.blockCheckpoint();
		expect(batch.isCheckpointBlocked).toBe(true);
	});

	it("closes priority admission before a fatal action permit is released", () => {
		const { action, admission } = admittedPull();
		const batch = new PriorityBatchState(admission);
		batch.abort();
		expect(batch.priorityTarget(action.path)).toEqual({ kind: "defer" });
	});
});
