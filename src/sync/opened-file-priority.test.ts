import { describe, expect, it, vi } from "vitest";
import { createMockLocalFs, createMockRemoteFs, createMockStateStore, addFile, readText, deferred } from "../__mocks__/sync-test-helpers";
import { LocalChangeTracker } from "./local-tracker";
import { LocalMutationBarrier } from "./local-mutation-barrier";
import { syncOpenedFilePriority } from "./opened-file-priority";

async function arrange() {
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
	await stateStore.put({
		path: "note.md", hash: local.hash, localMtime: local.mtime, remoteMtime: 1,
		localSize: local.size, remoteSize: local.size, remoteIdentityKey: "remote-id", syncedAt: 1,
	});
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
});
