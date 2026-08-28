import { describe, expect, it, vi } from "vitest";
import type { IncrementalCheckpoint } from "../fs/interface";
import type { ComponentReceipt, ExecutionResult } from "./execution-result";
import { finalizeSyncCycle } from "./sync-cycle-finalization";
import type { SyncStateStore } from "./state";
import type { IdentityEvidence, PathObservation, ScopeProjection, SyncAction } from "./types";
import {
	admitDestructivePlan,
	captureCycleAdmissionSnapshot,
	memberObligationFor,
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
			result: { succeeded: [], failed: [], blocked: [], conflicts: [], deferred: [], componentReceipts: [] },
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
			succeeded: [], failed: [], conflicts: [], deferred: [],
			blocked: [{ action, reason: "quarantined" }],
			componentReceipts: [],
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

	it("requires exact latest-epoch member completion with no duplicates", async () => {
		const action: SyncAction = { action: "rename_local", oldPath: "A.md", path: "a.md" };
		const admitted = admission([action], [edge()], { byEndpoint: new Map([
			["A.md", "included"], ["a.md", "included"],
		]) });
		const member = memberObligationFor(admitted.executable, action);
		const completion = {
			action,
			componentId: member.componentId,
			memberObligationId: member.id,
			admissionEpoch: member.admissionEpoch,
		};
		const commitCheckpoint = vi.fn<IncrementalCheckpoint["commitCheckpoint"]>()
			.mockResolvedValue(undefined);

		await finalizeSyncCycle({
			admission: admitted,
			result: { succeeded: [completion, completion], failed: [], blocked: [], conflicts: [], deferred: [], componentReceipts: [] },
			pendingEvidence: [edge()], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts: vi.fn() } as unknown as SyncStateStore,
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
	});

	it("accepts one exact latest-epoch component receipt", async () => {
		const action: SyncAction = { action: "rename_local", oldPath: "A.md", path: "a.md" };
		const admitted = admission([action], [edge()], { byEndpoint: new Map([
			["A.md", "included"], ["a.md", "included"],
		]) });
		const member = memberObligationFor(admitted.executable, action);
		const completion = {
			action, componentId: member.componentId, memberObligationId: member.id,
			admissionEpoch: member.admissionEpoch, completionKind: "applied" as const,
		};
		const commitCheckpoint = vi.fn<IncrementalCheckpoint["commitCheckpoint"]>()
			.mockResolvedValue(undefined);

		await finalizeSyncCycle({
			admission: admitted,
			result: {
				succeeded: [completion], failed: [], blocked: [], conflicts: [], deferred: [],
				componentReceipts: [{
					componentId: member.componentId, admissionEpoch: member.admissionEpoch,
					memberObligationIds: [member.id],
					completions: [{ memberObligationId: member.id, kind: "applied" }],
				}],
			},
			pendingEvidence: [edge()], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts: vi.fn() } as unknown as SyncStateStore,
		});

		expect(commitCheckpoint).toHaveBeenCalledOnce();
	});

	it("rejects an obsolete-epoch receipt", async () => {
		const action: SyncAction = { action: "rename_local", oldPath: "A.md", path: "a.md" };
		const admitted = admission([action], [edge()], { byEndpoint: new Map([
			["A.md", "included"], ["a.md", "included"],
		]) });
		const member = memberObligationFor(admitted.executable, action);
		const commitCheckpoint = vi.fn<IncrementalCheckpoint["commitCheckpoint"]>()
			.mockResolvedValue(undefined);

		await finalizeSyncCycle({
			admission: admitted,
			result: {
				succeeded: [{ action, componentId: member.componentId, memberObligationId: member.id,
					admissionEpoch: member.admissionEpoch }],
				failed: [], blocked: [], conflicts: [], deferred: [],
				componentReceipts: [{
					componentId: member.componentId, admissionEpoch: member.admissionEpoch + 1,
					memberObligationIds: [member.id],
					completions: [{ memberObligationId: member.id, kind: "applied" }],
				}],
			},
			pendingEvidence: [edge()], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts: vi.fn() } as unknown as SyncStateStore,
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
	});

	it.each([
		"duplicate receipt", "unknown component", "unknown member", "missing member",
		"extra member", "reordered members", "completion kind mismatch",
	] as const)("rejects %s evidence", async (counterexample) => {
		const actions: SyncAction[] = [
			{ path: "note.md", action: "push", local: { path: "note.md", isDirectory: false, size: 1, mtime: 1, hash: "a" } },
			{ path: "note.md", action: "push", local: { path: "note.md", isDirectory: false, size: 2, mtime: 2, hash: "b" } },
		];
		const admitted = admission(actions, [], { byEndpoint: new Map([["note.md", "included"]]) });
		const members = actions.map((action) => memberObligationFor(admitted.executable, action));
		const succeeded = actions.map((action, index) => ({
			action, componentId: members[index]!.componentId,
			memberObligationId: members[index]!.id,
			admissionEpoch: members[index]!.admissionEpoch,
			completionKind: "applied" as const,
		}));
		const receipt: ComponentReceipt = {
			componentId: members[0]!.componentId,
			admissionEpoch: members[0]!.admissionEpoch,
			memberObligationIds: members.map(({ id }) => id),
			completions: members.map(({ id }) => ({ memberObligationId: id, kind: "applied" as const })),
		};
		const receipts = [{ ...receipt, memberObligationIds: [...receipt.memberObligationIds],
			completions: receipt.completions.map((completion) => ({ ...completion })) }];
		if (counterexample === "duplicate receipt") receipts.push(receipts[0]!);
		else if (counterexample === "unknown component") receipts[0]!.componentId = "unknown";
		else if (counterexample === "unknown member") receipts[0]!.completions[0]!.memberObligationId = "unknown";
		else if (counterexample === "missing member") receipts[0]!.memberObligationIds.pop();
		else if (counterexample === "extra member") receipts[0]!.memberObligationIds.push("extra");
		else if (counterexample === "reordered members") receipts[0]!.memberObligationIds.reverse();
		else receipts[0]!.completions[0]!.kind = "no_action";
		const commitCheckpoint = vi.fn<IncrementalCheckpoint["commitCheckpoint"]>()
			.mockResolvedValue(undefined);

		await finalizeSyncCycle({
			admission: admitted,
			result: { succeeded, failed: [], blocked: [], conflicts: [], deferred: [], componentReceipts: receipts },
			pendingEvidence: [], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts: vi.fn() } as unknown as SyncStateStore,
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
	});

	it("rejects a partial multi-member component after one member succeeds and one fails", async () => {
		const actions: SyncAction[] = [
			{ path: "note.md", action: "push", local: { path: "note.md", isDirectory: false, size: 1, mtime: 1, hash: "a" } },
			{ path: "note.md", action: "push", local: { path: "note.md", isDirectory: false, size: 2, mtime: 2, hash: "b" } },
		];
		const admitted = admission(actions, [], { byEndpoint: new Map([["note.md", "included"]]) });
		const member = memberObligationFor(admitted.executable, actions[0]!);
		const commitCheckpoint = vi.fn<IncrementalCheckpoint["commitCheckpoint"]>()
			.mockResolvedValue(undefined);

		await finalizeSyncCycle({
			admission: admitted,
			result: {
				succeeded: [{ action: actions[0]!, componentId: member.componentId,
					memberObligationId: member.id, admissionEpoch: member.admissionEpoch }],
				failed: [{ action: actions[1]!, error: new Error("failed") }],
				blocked: [], conflicts: [], deferred: [], componentReceipts: [],
			},
			pendingEvidence: [], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts: vi.fn() } as unknown as SyncStateStore,
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
	});

	it("rejects a no-action receipt whose freshness witness is incomplete", async () => {
		const action: SyncAction = { path: "note.md", action: "match", local: { path: "note.md", isDirectory: false, size: 1, mtime: 1, hash: "h" } };
		const admitted = admission([action], [], { byEndpoint: new Map([["note.md", "included"]]) });
		const member = memberObligationFor(admitted.executable, action);
		const freshness = {
			localGeneration: 1, localFingerprint: "entity:a", recordFingerprint: "", identityKey: "remote-id",
			pathOccupant: { kind: "current" as const, identityKey: "remote-id", token: "token" },
			frozenDeltaWitness: member.frozenDeltaWitness,
			componentId: member.componentId, memberObligationId: member.id,
			admissionEpoch: member.admissionEpoch,
		};
		const commitCheckpoint = vi.fn<IncrementalCheckpoint["commitCheckpoint"]>()
			.mockResolvedValue(undefined);

		await finalizeSyncCycle({
			admission: admitted,
			result: {
				succeeded: [{ action, componentId: member.componentId, memberObligationId: member.id,
					admissionEpoch: member.admissionEpoch, completionKind: "no_action", freshness }],
				failed: [], blocked: [], conflicts: [], deferred: [],
				componentReceipts: [{
					componentId: member.componentId, admissionEpoch: member.admissionEpoch,
					memberObligationIds: [member.id],
					completions: [{ memberObligationId: member.id, kind: "no_action", freshness }],
				}],
			},
			pendingEvidence: [], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts: vi.fn() } as unknown as SyncStateStore,
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
	});

	it("revalidates a structurally complete no-action witness before checkpoint commit", async () => {
		const action: SyncAction = { path: "note.md", action: "match", local: { path: "note.md", isDirectory: false, size: 1, mtime: 1, hash: "h" } };
		const admitted = admission([action], [], { byEndpoint: new Map([["note.md", "included"]]) });
		const member = memberObligationFor(admitted.executable, action);
		const freshness = {
			localGeneration: 1, localFingerprint: "entity:a", recordFingerprint: "record:absent", identityKey: "remote-id",
			pathOccupant: { kind: "current" as const, identityKey: "remote-id", token: "token" },
			frozenDeltaWitness: member.frozenDeltaWitness,
			componentId: member.componentId, memberObligationId: member.id,
			admissionEpoch: member.admissionEpoch,
		};
		const commitCheckpoint = vi.fn<IncrementalCheckpoint["commitCheckpoint"]>()
			.mockResolvedValue(undefined);

		await finalizeSyncCycle({
			admission: admitted,
			result: {
				succeeded: [{ action, componentId: member.componentId, memberObligationId: member.id,
					admissionEpoch: member.admissionEpoch, completionKind: "no_action", freshness }],
				failed: [], blocked: [], conflicts: [], deferred: [],
				componentReceipts: [{
					componentId: member.componentId, admissionEpoch: member.admissionEpoch,
					memberObligationIds: [member.id],
					completions: [{ memberObligationId: member.id, kind: "no_action", freshness }],
				}],
			},
			pendingEvidence: [], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(commitCheckpoint), scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts: vi.fn() } as unknown as SyncStateStore,
			validateNoActionFreshness: vi.fn().mockResolvedValue(false),
		});

		expect(commitCheckpoint).not.toHaveBeenCalled();
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
			result: { succeeded: [], failed: [], blocked: [], conflicts: [], deferred: [], componentReceipts: [] },
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
			result: { succeeded: [], failed: [], blocked: [], conflicts: [], deferred: [], componentReceipts: [] },
			pendingEvidence: [pending], persistedDebts: [], localRenameDebts: [],
			checkpoint: checkpoint(vi.fn().mockRejectedValue(new Error("checkpoint failed"))),
			scopeFingerprint: "scope",
			stateStore: { deleteRenameDebts } as unknown as SyncStateStore,
		})).rejects.toThrow("checkpoint failed");
		expect(deleteRenameDebts).not.toHaveBeenCalled();
	});
});
