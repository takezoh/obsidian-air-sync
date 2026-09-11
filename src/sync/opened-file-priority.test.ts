import { describe, expect, it, vi } from "vitest";
import { createMockLocalFs, createMockRemoteFs, createMockStateStore, addFile, readText, deferred } from "../__mocks__/sync-test-helpers";
import { LocalChangeTracker } from "./local-tracker";
import { LocalMutationBarrier } from "./local-mutation-barrier";
import { syncOpenedFilePriority } from "./opened-file-priority";
import { admitBatchObservation } from "./plan-admission";
import { captureBatchObservation } from "./sync-cycle-planning";
import { PriorityBatchState } from "./priority-batch-state";
import { executePlan } from "./plan-executor";

async function arrange(options: { tracked?: boolean; remoteIdentity?: boolean } = {}) {
	const localFs = createMockLocalFs();
	const remoteFs = createMockRemoteFs();
	const stateStore = createMockStateStore();
	const localTracker = new LocalChangeTracker();
	addFile(localFs, "note.md", "old", 1);
	const local = await localFs.stat("note.md");
	if (!local) throw new Error("test setup failed");
	const remote = addFile(remoteFs, "note.md", "new", 2);
	remote.identityKey = "remote-id";
	const observation = {
		kind: "current" as const, path: "note.md", identityKey: "remote-id", token: "v2",
		entity: { ...remote },
		occupant: {
			kind: "current" as const, path: "note.md", identityKey: "remote-id", token: "v2",
			entity: { ...remote },
		},
	};
	if (options.tracked ?? true) {
		await stateStore.put({
			path: "note.md", hash: local.hash, localMtime: local.mtime, remoteMtime: 1,
			localSize: local.size, remoteSize: local.size, syncedAt: 1,
			...(options.remoteIdentity ?? true ? { remoteIdentityKey: "remote-id" } : {}),
		});
	}
	const requestNormalLifecycle = vi.fn();
	const supersede = vi.fn().mockReturnValue(true);
	const invalidate = vi.fn().mockReturnValue(true);
	const invalidateCycle = vi.fn();
	return {
		localFs, remoteFs, stateStore, localTracker, observation,
		requestNormalLifecycle, supersede, invalidate, invalidateCycle,
		base: {
			path: "note.md", localFs, remoteFs, stateStore, localTracker,
			mutationBarrier: new LocalMutationBarrier(), target: { kind: "independent" as const },
			supersede, invalidate, invalidateCycle, requestNormalLifecycle,
		},
	};
}

describe("syncOpenedFilePriority", () => {
	it.each(["dirty", "untracked", "no_capability", "active_batch"] as const)(
		"returns the untracked outcome for a baseline-less %s path", async (condition) => {
			const ctx = await arrange({ tracked: false });
			if (condition === "dirty") ctx.localTracker.markDirty("note.md");
			if (condition !== "no_capability") {
				ctx.remoteFs.priority = { observe: vi.fn(), read: vi.fn() };
			}
			const target = condition === "active_batch"
				? { kind: "defer" as const }
				: ctx.base.target;

			expect(await syncOpenedFilePriority({ ...ctx.base, target })).toBe("untracked");
			expect(ctx.requestNormalLifecycle).not.toHaveBeenCalled();
			if (condition === "dirty") {
				expect(ctx.localTracker.getDirtyPaths().has("note.md")).toBe(true);
			}
		},
	);

	it.each(["no_capability", "active_batch", "record_without_identity"] as const)(
		"immediately defers a tracked %s path", async (condition) => {
			const ctx = await arrange({ remoteIdentity: condition !== "record_without_identity" });
			if (condition !== "no_capability") {
				ctx.remoteFs.priority = { observe: vi.fn(), read: vi.fn() };
			}
			const target = condition === "active_batch"
				? { kind: "defer" as const }
				: ctx.base.target;

			expect(await syncOpenedFilePriority({ ...ctx.base, target })).toBe("deferred_to_batch");
			expect(ctx.requestNormalLifecycle).toHaveBeenCalledOnce();
		},
	);

	it("requests an immediate normal lifecycle after a remote observation error", async () => {
		const ctx = await arrange();
		ctx.remoteFs.priority = {
			observe: vi.fn().mockRejectedValue(new Error("remote unavailable")),
			read: vi.fn(),
		};

		expect(await syncOpenedFilePriority(ctx.base)).toBe("failed_retryable");
		expect(ctx.requestNormalLifecycle).toHaveBeenCalledOnce();
		expect(readText(ctx.localFs, "note.md")).toBe("old");
	});

	it.each(["no_capability", "active_batch"] as const)(
		"requests an immediate normal lifecycle when baseline reading fails for %s", async (condition) => {
			const ctx = await arrange();
			vi.spyOn(ctx.stateStore, "get").mockRejectedValue(new Error("state unavailable"));
			if (condition === "active_batch") {
				ctx.remoteFs.priority = { observe: vi.fn(), read: vi.fn() };
			}
			const target = condition === "active_batch"
				? { kind: "defer" as const }
				: ctx.base.target;

			expect(await syncOpenedFilePriority({ ...ctx.base, target })).toBe("failed_retryable");
			expect(ctx.requestNormalLifecycle).toHaveBeenCalledOnce();
		},
	);

	it("does not overwrite an edit observed while detached content is being read", async () => {
		const ctx = await arrange();
		const gate = deferred<ArrayBuffer>();
		ctx.remoteFs.priority = {
			observe: vi.fn().mockResolvedValue(ctx.observation),
			read: vi.fn().mockReturnValue(gate.promise.then((content) => ({ kind: "content" as const, content }))),
		};
		const attempt = syncOpenedFilePriority(ctx.base);
		await Promise.resolve();
		addFile(ctx.localFs, "note.md", "user edit", 3);
		ctx.localTracker.markDirty("note.md");
		gate.resolve(new TextEncoder().encode("new").buffer);

		expect(await attempt).toBe("deferred_to_batch");
		expect(readText(ctx.localFs, "note.md")).toBe("user edit");
		expect(ctx.requestNormalLifecycle).toHaveBeenCalledOnce();
	});

	it("keeps the self-write dirty when whole-record CAS loses", async () => {
		const ctx = await arrange();
		ctx.remoteFs.priority = {
			observe: vi.fn().mockResolvedValue(ctx.observation),
			read: vi.fn().mockResolvedValue({
				kind: "content", content: new TextEncoder().encode("new").buffer,
			}),
		};
		vi.spyOn(ctx.stateStore, "compareAndPut").mockResolvedValue(false);

		expect(await syncOpenedFilePriority(ctx.base)).toBe("deferred_to_batch");
		expect(readText(ctx.localFs, "note.md")).toBe("new");
		expect(ctx.localTracker.getDirtyPaths().has("note.md")).toBe(true);
		expect(ctx.invalidateCycle).toHaveBeenCalledOnce();
		expect(ctx.requestNormalLifecycle).toHaveBeenCalledOnce();
	});

	it("invalidates the exact admitted pull after CAS loss so normal I/O cannot follow", async () => {
		const ctx = await arrange();
		const baseline = await ctx.stateStore.get("note.md");
		const local = await ctx.localFs.stat("note.md");
		if (!baseline || !local) throw new Error("test setup failed");
		const remote = ctx.observation.entity;
		const admission = admitBatchObservation(captureBatchObservation(
			[{ path: "note.md", local, remote, prevSync: baseline }], [], [
				{ kind: "exact", side: "local", requestedPath: "note.md", entity: local },
				{ kind: "exact", side: "remote", requestedPath: "note.md", entity: remote },
			], { isConfiguredScopeCompatible: () => true, byEndpoint: new Map([["note.md", "included"]]) }, "priority-cas-test",
		));
		const batch = new PriorityBatchState(admission);
		ctx.remoteFs.priority = {
			observe: vi.fn().mockResolvedValue(ctx.observation),
			read: vi.fn().mockResolvedValue({
				kind: "content", content: new TextEncoder().encode("new").buffer,
			}),
		};
		vi.spyOn(ctx.stateStore, "compareAndPut").mockResolvedValue(false);
		const normalRead = vi.spyOn(ctx.remoteFs, "read");

		expect(await syncOpenedFilePriority({
			...ctx.base,
			target: batch.priorityTarget("note.md"),
			supersede: (candidate, record) => batch.supersede(candidate, record),
			invalidate: (candidate) => batch.invalidate(candidate),
			invalidateCycle: () => batch.blockCheckpoint(),
		})).toBe("deferred_to_batch");
		const execution = await executePlan(admission.executable, {
			localFs: ctx.localFs, remoteFs: ctx.remoteFs,
			committer: { stateStore: ctx.stateStore }, conflictStrategy: "duplicate",
			beginAction: (candidate) => batch.beginAction(candidate),
		});

		expect(execution.blocked).toEqual([{ action: admission.executable.actions[0], reason: "priority observation invalidated pending action" }]);
		expect(normalRead).not.toHaveBeenCalled();
		expect(batch.isCheckpointBlocked).toBe(true);
	});
});
