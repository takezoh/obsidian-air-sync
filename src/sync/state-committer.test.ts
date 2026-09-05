import { describe, it, expect, beforeEach, vi } from "vitest";
import { commitAction, buildSyncRecord } from "./state-committer";
import type { SyncAction } from "./types";
import { createMockLocalFs, type MockFileSystem, createMockStateStore, makeFile } from "../__mocks__/sync-test-helpers";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";
import type { TerminalActionProof } from "./plan-executor";
import type { CompletedAction } from "./execution-result";
import { sha256 } from "../utils/hash";

describe("buildSyncRecord", () => {
	it("builds record from both sides", () => {
		const local = makeFile("a.md", "hello", 1000).entity;
		const remote = makeFile("a.md", "hello", 2000).entity;
		remote.backendMeta = { id: "drive-id" };
		remote.identityKey = "native-id";

		const record = buildSyncRecord(local, remote, "a.md");

		expect(record.path).toBe("a.md");
		expect(record.localMtime).toBe(1000);
		expect(record.remoteMtime).toBe(2000);
		expect(record.localSize).toBe(local.size);
		expect(record.remoteSize).toBe(remote.size);
		expect(record.backendMeta).toEqual({ id: "drive-id" });
		expect(record.remoteIdentityKey).toBe("native-id");
		expect(record.syncedAt).toBeGreaterThan(0);
	});

	it("handles missing local (pull from remote only)", () => {
		const remote = makeFile("a.md", "hello", 2000).entity;
		remote.hash = "remote-hash";
		const record = buildSyncRecord(undefined, remote, "a.md");

		expect(record.localMtime).toBe(0);
		expect(record.remoteMtime).toBe(2000);
		expect(record.hash).toBe("remote-hash");
	});

	it("handles missing remote (push local only)", () => {
		const local = makeFile("a.md", "hello", 1000).entity;
		local.hash = "abc123";
		const record = buildSyncRecord(local, undefined, "a.md");

		expect(record.remoteMtime).toBe(0);
		expect(record.hash).toBe("abc123");
	});
});

/** Explicit fixture setup at the committer boundary, not an Admission substitute. */
function withPublication(action: SyncAction): SyncAction {
	action.publication ??= { source: action.baseline, destination: action.baseline };
	return action;
}

/** I/O proof is supplied by the executor in production and tested through its public pipeline. */
function proofFor(action: SyncAction): TerminalActionProof {
	return { action, verifiedOutputs: [] } as unknown as TerminalActionProof;
}

describe("commitAction", () => {
	let stateStore: ReturnType<typeof createMockStateStore>;
	let localFs: MockFileSystem;

	beforeEach(() => {
		stateStore = createMockStateStore();
		localFs = createMockLocalFs();
	});

	function makeCtx(enableThreeWayMerge = false) {
		return {
			stateStore: stateStore as unknown as SyncStateStore,
			localFs,
			enableThreeWayMerge,
		};
	}

	it("consumes ordered child publication receipts in one linear pass", async () => {
		const size = 512;
		const completed: CompletedAction[] = [];
		const descendants: NonNullable<Extract<SyncAction, { action: "rename_local" | "rename_remote" }>["descendantRecords"]>[number][] = [];
		for (let index = 0; index < size; index++) {
			const path = `A/${index}.md`;
			const record = buildSyncRecord(makeFile(path, "same", 1000).entity, makeFile(path, "same", 1000).entity, path);
			stateStore.records.set(path, record);
			const action: SyncAction = { action: "push", path };
			if (index % 2 === 0) completed.push({ action, terminalRecord: record });
			descendants.push({ oldPath: path, newPath: `B/${index}.md`, source: record, destination: undefined,
				...(index % 2 === 0 ? { after: action } : {}) });
		}
		let reads = 0;
		const observed = new Proxy(completed, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property)) reads++;
				return Reflect.get(target, property, receiver) as unknown;
			},
		});
		const parent: SyncAction = { action: "rename_remote", path: "B", oldPath: "A", isFolder: true, descendantRecords: descendants };
		await commitAction(parent, undefined, undefined, makeCtx(), proofFor(parent), observed);
		expect(reads).toBeLessThanOrEqual(size * 2);
		expect(stateStore.records.size).toBe(size);
		expect([...stateStore.records.keys()].every((path) => path.startsWith("B/"))).toBe(true);
	});

	it("push: upserts SyncRecord", async () => {
		const { entity: local } = makeFile("a.md", "local content", 1000);
		const { entity: remote } = makeFile("a.md", "local content", 1000);
		const action: SyncAction = { path: "a.md", action: "push" };

		await commitAction(withPublication(action), local, remote, makeCtx());

		expect(stateStore.records.has("a.md")).toBe(true);
		expect(stateStore.records.get("a.md")!.localMtime).toBe(1000);
	});

	it("pull: upserts SyncRecord", async () => {
		const { entity: remote } = makeFile("b.md", "remote content", 2000);
		const action: SyncAction = { path: "b.md", action: "pull" };

		await commitAction(withPublication(action), undefined, remote, makeCtx());

		expect(stateStore.records.has("b.md")).toBe(true);
		expect(stateStore.records.get("b.md")!.remoteMtime).toBe(2000);
	});

	it("match: upserts SyncRecord", async () => {
		const { entity: local } = makeFile("c.md", "same", 500);
		const { entity: remote } = makeFile("c.md", "same", 500);
		const action: SyncAction = { path: "c.md", action: "match" };

		await commitAction(withPublication(action), local, remote, makeCtx());

		expect(stateStore.records.has("c.md")).toBe(true);
	});

	it("conflict: upserts SyncRecord", async () => {
		const { entity: local } = makeFile("d.md", "local", 1000);
		const { entity: remote } = makeFile("d.md", "remote", 2000);
		const action: SyncAction = { path: "d.md", action: "conflict" };

		await commitAction(withPublication(action), local, remote, makeCtx());

		expect(stateStore.records.has("d.md")).toBe(true);
	});

	it("content replacement uses the existing whole-record CAS", async () => {
		const baseline = {
			path: "cas.md", hash: "old", localMtime: 1, remoteMtime: 1,
			localSize: 3, remoteSize: 3, syncedAt: 1,
		};
		stateStore.records.set("cas.md", baseline);
		const compareAndPut = vi.spyOn(stateStore, "compareAndPut");
		const { entity: local } = makeFile("cas.md", "new", 2);
		const { entity: remote } = makeFile("cas.md", "new", 2);

		await commitAction(withPublication({ path: "cas.md", action: "pull", baseline }), local, remote, makeCtx());

		expect(compareAndPut).toHaveBeenCalledWith(baseline, expect.objectContaining({ path: "cas.md" }));
		expect(compareAndPut.mock.calls[0]).toHaveLength(2);
	});

	it("content CAS mismatch preserves the winning record and fails the action", async () => {
		const baseline = {
			path: "cas-race.md", hash: "old", localMtime: 1, remoteMtime: 1,
			localSize: 3, remoteSize: 3, syncedAt: 1,
		};
		const winner = { ...baseline, hash: "winner", syncedAt: 2 };
		stateStore.records.set("cas-race.md", winner);
		const { entity: local } = makeFile("cas-race.md", "new", 2);
		const { entity: remote } = makeFile("cas-race.md", "new", 2);

		await expect(commitAction(
			withPublication({ path: "cas-race.md", action: "pull", baseline }), local, remote, makeCtx(),
		)).rejects.toThrow("SyncRecord changed before terminal publication");
		expect(stateStore.records.get("cas-race.md")).toEqual(winner);
	});

	it("rejects missing publication inputs without touching records", async () => {
		const action: SyncAction = { path: "new.md", action: "match" };
		const compareAndPut = vi.spyOn(stateStore, "compareAndPut");
		await expect(commitAction(action, undefined, undefined, makeCtx()))
			.rejects.toThrow("Admission publication inputs missing");
		expect(compareAndPut).not.toHaveBeenCalled();
	});

	it("relocation requires a proof for the exact admitted action", async () => {
		const baseline = buildSyncRecord(undefined, undefined, "old.md");
		stateStore.records.set("old.md", baseline);
		const action: SyncAction = { path: "new.md", action: "match", baseline,
			publication: { source: baseline, destination: undefined } };
		const local = makeFile("new.md", "new", 2).entity;
		const compareAndMove = vi.spyOn(stateStore, "compareAndMove");
		await expect(commitAction(action, local, local, makeCtx()))
			.rejects.toThrow("Terminal publication proof missing");
		await expect(commitAction(action, local, local, makeCtx(), proofFor({ ...action })))
			.rejects.toThrow("Terminal publication proof missing");
		expect(compareAndMove).not.toHaveBeenCalled();
		expect(stateStore.records.get("old.md")).toEqual(baseline);
	});

	it("relocation CAS mismatch preserves the winning baseline", async () => {
		const baseline = buildSyncRecord(undefined, undefined, "old.md");
		const winner = { ...baseline, hash: "winner" };
		stateStore.records.set("old.md", winner);
		const action: SyncAction = { path: "new.md", action: "match", baseline,
			publication: { source: baseline, destination: undefined } };
		const local = makeFile("new.md", "new", 2).entity;
		await expect(commitAction(action, local, local, makeCtx(), proofFor(action)))
			.rejects.toThrow("SyncRecord changed before terminal publication");
		expect(stateStore.records.get("old.md")).toEqual(winner);
		expect(stateStore.records.has("new.md")).toBe(false);
	});

	it("delete_local: deletes SyncRecord", async () => {
		stateStore.records.set("e.md", {
			path: "e.md", hash: "", localMtime: 1000, remoteMtime: 1000,
			localSize: 4, remoteSize: 4, syncedAt: 900,
		});
		const expected = stateStore.records.get("e.md");
		const action: SyncAction = { path: "e.md", action: "delete_local",
			publication: { source: expected, destination: expected } };

		await commitAction(withPublication(action), undefined, undefined, makeCtx());

		expect(stateStore.records.has("e.md")).toBe(false);
	});

	it("delete_remote: deletes SyncRecord", async () => {
		stateStore.records.set("f.md", {
			path: "f.md", hash: "", localMtime: 1000, remoteMtime: 1000,
			localSize: 4, remoteSize: 4, syncedAt: 900,
		});
		const expected = stateStore.records.get("f.md");
		const action: SyncAction = { path: "f.md", action: "delete_remote",
			publication: { source: expected, destination: expected } };

		await commitAction(withPublication(action), undefined, undefined, makeCtx());

		expect(stateStore.records.has("f.md")).toBe(false);
	});

	it("rename_remote: deletes old path and upserts new path", async () => {
		stateStore.records.set("old.md", {
			path: "old.md", hash: "h1", localMtime: 1000, remoteMtime: 1000,
			localSize: 7, remoteSize: 7, syncedAt: 900,
		});
		const { entity: local } = makeFile("new.md", "content", 1000);
		const { entity: remote } = makeFile("new.md", "content", 2000);
		const action: SyncAction = { path: "new.md", action: "rename_remote", oldPath: "old.md",
			publication: { source: stateStore.records.get("old.md"), destination: undefined } };

		await commitAction(withPublication(action), local, remote, makeCtx(), proofFor(action));

		expect(stateStore.records.has("old.md")).toBe(false);
		expect(stateStore.records.has("new.md")).toBe(true);
		expect(stateStore.records.get("new.md")!.remoteMtime).toBe(2000);
	});

	it("rename_remote with enableThreeWayMerge: stores content at new path", async () => {
		const buf = new TextEncoder().encode("content").buffer;
		const localEntry = makeFile("new.md", "content", 1000);
		localEntry.entity.hash = await sha256(buf);
		localFs.files.set("new.md", { content: buf, entity: localEntry.entity });
		const { entity: remote } = makeFile("new.md", "content", 2000);
		const action: SyncAction = { path: "new.md", action: "rename_remote", oldPath: "old.md",
			publication: { source: stateStore.records.get("old.md"), destination: undefined } };

		await commitAction(withPublication(action), localEntry.entity, remote, makeCtx(true), proofFor(action));

		expect(stateStore.contents.has("new.md")).toBe(true);
	});

	it("cleanup: deletes SyncRecord", async () => {
		stateStore.records.set("g.md", {
			path: "g.md", hash: "", localMtime: 1000, remoteMtime: 1000,
			localSize: 4, remoteSize: 4, syncedAt: 900,
		});
		const expected = stateStore.records.get("g.md");
		const action: SyncAction = { path: "g.md", action: "cleanup",
			publication: { source: expected, destination: expected } };

		await commitAction(withPublication(action), undefined, undefined, makeCtx());

		expect(stateStore.records.has("g.md")).toBe(false);
	});

	it("push with enableThreeWayMerge: stores merge-base content for eligible file", async () => {
		const buf = new TextEncoder().encode("hello world").buffer;
		const localEntry = makeFile("h.md", "hello world", 1000);
		localEntry.entity.hash = await sha256(buf);
		localFs.files.set("h.md", { content: buf, entity: localEntry.entity });

		const { entity: remote } = makeFile("h.md", "hello world", 1000);
		const action: SyncAction = { path: "h.md", action: "push" };

		await commitAction(withPublication(action), localEntry.entity, remote, makeCtx(true));

		expect(stateStore.contents.has("h.md")).toBe(true);
	});

	it("does not attach bytes edited after publication to the committed merge base", async () => {
		const admittedBytes = new TextEncoder().encode("before").buffer;
		const { entity: local } = makeFile("a.md", "before", 1000);
		local.hash = await sha256(admittedBytes);
		const remote = { ...local, identityKey: "remote-a" };
		localFs.files.set("a.md", makeFile("a.md", "edited", 2000));

		await commitAction(withPublication({ path: "a.md", action: "push" }), local, remote, makeCtx(true));

		expect(stateStore.records.get("a.md")?.hash).toBe(local.hash);
		expect(stateStore.contents.has("a.md")).toBe(false);
	});

	it("does not publish a merge base without a comparable committed content hash", async () => {
		const entry = makeFile("a.md", "bytes", 1000);
		localFs.files.set("a.md", entry);
		await commitAction(withPublication({ path: "a.md", action: "match" }), entry.entity, entry.entity, makeCtx(true));
		expect(stateStore.contents.has("a.md")).toBe(false);
	});

	it("push with enableThreeWayMerge: logs warning and still upserts record when localFs.read throws", async () => {
		const { entity: local } = makeFile("h.md", "hello world", 1000);
		const { entity: remote } = makeFile("h.md", "hello world", 1000);
		const action: SyncAction = { path: "h.md", action: "push" };

		const readError = new Error("read failed");
		const failingLocalFs = { read: (_path: string): Promise<ArrayBuffer> => { throw readError; } };
		const warnSpy = vi.fn();
		const logger: Logger = {
			debug: vi.fn(), info: vi.fn(),
			warn: warnSpy, error: vi.fn(),
		} as unknown as Logger;

		await commitAction(withPublication(action), local, remote, {
			stateStore: stateStore,
			localFs: failingLocalFs,
			enableThreeWayMerge: true,
			logger,
		});

		expect(stateStore.records.has("h.md")).toBe(true);
		expect(stateStore.contents.has("h.md")).toBe(false);
		expect(warnSpy).toHaveBeenCalledWith(
			"Failed to store content for 3-way merge",
			expect.objectContaining({ path: "h.md", error: "read failed" }),
		);
	});

	it("push with enableThreeWayMerge: skips content store for binary/ineligible file", async () => {
		const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer; // PNG header
		const localEntry = makeFile("image.png", "", 1000);
		localFs.files.set("image.png", { content: buf, entity: localEntry.entity });

		const { entity: remote } = makeFile("image.png", "", 1000);
		const action: SyncAction = { path: "image.png", action: "push" };

		await commitAction(withPublication(action), localEntry.entity, remote, makeCtx(true));

		expect(stateStore.contents.has("image.png")).toBe(false);
	});

	it("rename_remote with isFolder: atomically compares and rewrites all descendant records", async () => {
		stateStore.records.set("A/f1.md", {
			path: "A/f1.md", hash: "h1", localMtime: 1000, remoteMtime: 1000,
			localSize: 7, remoteSize: 7, syncedAt: 900,
		});
		stateStore.records.set("A/f2.md", {
			path: "A/f2.md", hash: "h2", localMtime: 1000, remoteMtime: 1000,
			localSize: 5, remoteSize: 5, syncedAt: 900,
		});
		const action: SyncAction = {
			path: "B",
			action: "rename_remote",
			oldPath: "A",
			isFolder: true,
			descendants: [
				{ oldPath: "A/f1.md", newPath: "B/f1.md" },
				{ oldPath: "A/f2.md", newPath: "B/f2.md" },
			],
		};

		action.descendantRecords = action.descendants!.map((pair) => ({
			...pair, source: stateStore.records.get(pair.oldPath), destination: undefined,
		}));
		await commitAction(action, undefined, undefined, makeCtx(), proofFor(action));

		expect(stateStore.records.has("A/f1.md")).toBe(false);
		expect(stateStore.records.has("A/f2.md")).toBe(false);
		expect(stateStore.records.has("B/f1.md")).toBe(true);
		expect(stateStore.records.has("B/f2.md")).toBe(true);
		expect(stateStore.records.get("B/f1.md")!.hash).toBe("h1");
		expect(stateStore.records.get("B/f2.md")!.hash).toBe("h2");
	});

	it("rename_local with isFolder: rewrites descendant sync records", async () => {
		stateStore.records.set("A/f1.md", {
			path: "A/f1.md", hash: "h1", localMtime: 1000, remoteMtime: 1000,
			localSize: 7, remoteSize: 7, syncedAt: 900,
		});
		const action: SyncAction = {
			path: "B",
			action: "rename_local",
			oldPath: "A",
			isFolder: true,
			descendants: [
				{ oldPath: "A/f1.md", newPath: "B/f1.md" },
			],
		};

		action.descendantRecords = action.descendants!.map((pair) => ({
			...pair, source: stateStore.records.get(pair.oldPath), destination: undefined,
		}));
		await commitAction(action, undefined, undefined, makeCtx(), proofFor(action));

		expect(stateStore.records.has("A/f1.md")).toBe(false);
		expect(stateStore.records.has("B/f1.md")).toBe(true);
	});

	// Note: there is no test for a "failed" action because "failed" is not a member of
	// SyncActionType and therefore cannot be passed to commitAction. Failed execution is
	// handled by the caller, which simply does not call commitAction for failed actions.
});
