import { describe, it, expect, vi, afterEach } from "vitest";
import { executePlan, toConflictRecords, DESKTOP_TRANSFER_POOL, MOBILE_TRANSFER_POOL } from "./plan-executor";
import type { ExecutionContext, ResolvedConflict } from "./plan-executor";
import type { SyncAction, SyncPlan } from "./types";
import { createMockFs, createMockStateStore, addFile, readText, deferred, flush } from "../__mocks__/sync-test-helpers";
import type { SyncStateStore } from "./state";
import { AuthError, classifyHttpError } from "../fs/errors";
import { AdaptivePool } from "../queue/async-queue";

function makeCtx(
	overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
	const localFs = createMockFs("local");
	const remoteFs = createMockFs("remote");
	const stateStore = createMockStateStore();
	return {
		localFs,
		remoteFs,
		committer: {
			stateStore: stateStore as unknown as SyncStateStore,
		},
		conflictStrategy: "auto_merge",
		classifyError: classifyHttpError,
		transferPool: DESKTOP_TRANSFER_POOL,
		// Test seams: instant sleep + deterministic jitter so retry tests don't burn time.
		sleep: () => Promise.resolve(),
		rng: () => 0,
		...overrides,
	};
}

function makePlan(actions: SyncAction[]): SyncPlan {
	return { actions };
}

// Some suites spy on AdaptivePool.prototype (a global) — restore after each test
// so the spy never leaks into another (vitest is not configured to auto-restore).
afterEach(() => vi.restoreAllMocks());

describe("executePlan", () => {
	describe("push", () => {
		it("uploads local file to remote and commits state", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "a.md", "content");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;

			const plan = makePlan([{
				path: "a.md",
				action: "push",
				local: { path: "a.md", isDirectory: false, size: 7, mtime: 1000, hash: "" },
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(result.failed).toHaveLength(0);
			expect(remoteFs.files.has("a.md")).toBe(true);
			expect(stateStore.records.has("a.md")).toBe(true);
		});

		it("records blocked actions without executing I/O", async () => {
			const ctx = makeCtx({
				isActionBlocked: (action) => action.path === "blocked.md" ? "known permanent failure" : null,
			});
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "blocked.md", "content");
			const writeSpy = vi.spyOn(remoteFs, "write");

			const result = await executePlan(makePlan([{
				path: "blocked.md",
				action: "push",
				local: { path: "blocked.md", isDirectory: false, size: 7, mtime: 1000, hash: "" },
			}]), ctx);

			expect(result.blocked).toHaveLength(1);
			expect(result.blocked[0]!.reason).toBe("known permanent failure");
			expect(result.succeeded).toHaveLength(0);
			expect(result.failed).toHaveLength(0);
			expect(writeSpy).not.toHaveBeenCalled();
		});
	});

	describe("pull", () => {
		it("downloads remote file to local and commits state", async () => {
			const ctx = makeCtx();
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(remoteFs, "b.md", "remote content");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;

			const plan = makePlan([{
				path: "b.md",
				action: "pull",
				remote: { path: "b.md", isDirectory: false, size: 14, mtime: 2000, hash: "" },
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(result.failed).toHaveLength(0);
			expect((ctx.localFs as ReturnType<typeof createMockFs>).files.has("b.md")).toBe(true);
			expect(stateStore.records.has("b.md")).toBe(true);
		});
	});

	describe("match", () => {
		it("commits state without file I/O", async () => {
			const ctx = makeCtx();
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			const local = { path: "c.md", isDirectory: false, size: 5, mtime: 1000, hash: "abc" };
			const remote = { path: "c.md", isDirectory: false, size: 5, mtime: 1000, hash: "abc" };

			const plan = makePlan([{ path: "c.md", action: "match", local, remote }]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(stateStore.records.has("c.md")).toBe(true);
		});
	});

	describe("delete_remote", () => {
		it("deletes remote file and removes state record", async () => {
			const ctx = makeCtx();
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(remoteFs, "d.md", "to delete");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			stateStore.records.set("d.md", {
				path: "d.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 9, remoteSize: 9, syncedAt: 900,
			});

			const plan = makePlan([{ path: "d.md", action: "delete_remote" }]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(remoteFs.files.has("d.md")).toBe(false);
			expect(stateStore.records.has("d.md")).toBe(false);
		});
	});

	describe("delete_local", () => {
		it("deletes local file and removes state record", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "e.md", "to delete");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			stateStore.records.set("e.md", {
				path: "e.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 9, remoteSize: 9, syncedAt: 900,
			});

			const plan = makePlan([{ path: "e.md", action: "delete_local" }]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(localFs.files.has("e.md")).toBe(false);
			expect(stateStore.records.has("e.md")).toBe(false);
		});
	});

	describe("rename_remote", () => {
		it("renames remote file and commits state at new path", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "new.md", "content");
			addFile(remoteFs, "old.md", "content");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			stateStore.records.set("old.md", {
				path: "old.md", hash: "h1", localMtime: 1000, remoteMtime: 1000,
				localSize: 7, remoteSize: 7, syncedAt: 900,
			});

			const plan = makePlan([{
				path: "new.md",
				action: "rename_remote",
				oldPath: "old.md",
				local: { path: "new.md", isDirectory: false, size: 7, mtime: 1000, hash: "h1" },
				remote: { path: "old.md", isDirectory: false, size: 7, mtime: 1000, hash: "h1" },
				baseline: stateStore.records.get("old.md"),
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(result.failed).toHaveLength(0);
			expect(remoteFs.files.has("new.md")).toBe(true);
			expect(remoteFs.files.has("old.md")).toBe(false);
			expect(stateStore.records.has("new.md")).toBe(true);
			expect(stateStore.records.has("old.md")).toBe(false);
		});

	});

	describe("rename_remote with isFolder", () => {
		it("renames folder on remote and rewrites descendant sync records", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;

			// Set up: folder A with 2 files on remote, folder B with same files locally
			addFile(remoteFs, "A/f1.md", "content1");
			addFile(remoteFs, "A/f2.md", "content2");
			addFile(localFs, "B/f1.md", "content1");
			addFile(localFs, "B/f2.md", "content2");
			stateStore.records.set("A/f1.md", {
				path: "A/f1.md", hash: "h1", localMtime: 1000, remoteMtime: 1000,
				localSize: 8, remoteSize: 8, syncedAt: 900,
			});
			stateStore.records.set("A/f2.md", {
				path: "A/f2.md", hash: "h2", localMtime: 1000, remoteMtime: 1000,
				localSize: 8, remoteSize: 8, syncedAt: 900,
			});

			const plan = makePlan([{
				path: "B",
				action: "rename_remote",
				oldPath: "A",
				isFolder: true,
				descendants: [
					{ oldPath: "A/f1.md", newPath: "B/f1.md" },
					{ oldPath: "A/f2.md", newPath: "B/f2.md" },
				],
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(result.failed).toHaveLength(0);
			// Remote folder was renamed
			expect(remoteFs.files.has("B/f1.md")).toBe(true);
			expect(remoteFs.files.has("B/f2.md")).toBe(true);
			expect(remoteFs.files.has("A/f1.md")).toBe(false);
			expect(remoteFs.files.has("A/f2.md")).toBe(false);
			// Descendant sync records were rewritten
			expect(stateStore.records.has("A/f1.md")).toBe(false);
			expect(stateStore.records.has("A/f2.md")).toBe(false);
			expect(stateStore.records.has("B/f1.md")).toBe(true);
			expect(stateStore.records.has("B/f2.md")).toBe(true);
		});
	});

	describe("cleanup", () => {
		it("removes state record without file I/O", async () => {
			const ctx = makeCtx();
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			stateStore.records.set("f.md", {
				path: "f.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 0, remoteSize: 0, syncedAt: 900,
			});

			const plan = makePlan([{ path: "f.md", action: "cleanup" }]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(stateStore.records.has("f.md")).toBe(false);
		});
	});

	describe("conflict", () => {
		it("resolves conflict and records it in both succeeded and conflicts arrays", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "g.md", "local version");
			addFile(remoteFs, "g.md", "remote version");

			const plan = makePlan([{
				path: "g.md",
				action: "conflict",
				local: { path: "g.md", isDirectory: false, size: 13, mtime: 2000, hash: "local-hash" },
				remote: { path: "g.md", isDirectory: false, size: 14, mtime: 1500, hash: "remote-hash" },
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.conflicts).toHaveLength(1);
			expect(result.succeeded).toHaveLength(1);
			expect(result.failed).toHaveLength(0);
		});

		it("records conflict in failed array when resolveConflict throws a non-Auth error", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "err.md", "local version");
			addFile(remoteFs, "err.md", "remote version");

			// Force localFs.read to ALWAYS throw a non-Auth error: conflict resolution now
			// gets in-cycle retry, so a single transient error would be retried and succeed
			// (see the D1 retry test). A persistent error exhausts the retries → result.failed.
			vi.spyOn(localFs, "read").mockRejectedValue(new Error("I/O error"));

			const plan = makePlan([{
				path: "err.md",
				action: "conflict",
				local: { path: "err.md", isDirectory: false, size: 13, mtime: 2000, hash: "local-hash" },
				remote: { path: "err.md", isDirectory: false, size: 14, mtime: 1500, hash: "remote-hash" },
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.failed).toHaveLength(1);
			expect(result.failed[0]!.action.path).toBe("err.md");
			expect(result.conflicts).toHaveLength(0);
			expect(result.succeeded).toHaveLength(0);
		});
	});

	describe("error isolation", () => {
		it("records failed action and continues processing remaining actions", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "good.md", "good content");

			const plan = makePlan([
				{
					path: "missing.md",
					action: "push",
					local: { path: "missing.md", isDirectory: false, size: 10, mtime: 1000, hash: "" },
				},
				{
					path: "good.md",
					action: "push",
					local: { path: "good.md", isDirectory: false, size: 12, mtime: 1000, hash: "" },
				},
			]);

			const result = await executePlan(plan, ctx);

			expect(result.failed).toHaveLength(1);
			expect(result.failed[0]!.action.path).toBe("missing.md");
			expect(result.succeeded).toHaveLength(1);
			expect(result.succeeded[0]!.action.path).toBe("good.md");
		});

		it("aborts immediately on AuthError during a push (transfer phase)", async () => {
			const ctx = makeCtx();
			const authErr = new AuthError("Unauthorized", 401);

			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			// Use path-based logic so the correct file triggers AuthError regardless of concurrency order
			vi.spyOn(localFs, "read").mockImplementation((path: string) => {
				if (path === "auth-fail.md") return Promise.reject(authErr);
				return Promise.resolve(new ArrayBuffer(0));
			});

			const plan = makePlan([
				{
					path: "auth-fail.md",
					action: "push",
					local: { path: "auth-fail.md", isDirectory: false, size: 5, mtime: 1000, hash: "" },
				},
				{
					path: "other.md",
					action: "push",
					local: { path: "other.md", isDirectory: false, size: 13, mtime: 1000, hash: "" },
				},
			]);

			await expect(executePlan(plan, ctx)).rejects.toThrow(AuthError);
		});

		it("aborts the cycle on AuthError during a remote delete (structural phase)", async () => {
			const ctx = makeCtx();
			const authErr = new AuthError("Unauthorized", 401);
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(remoteFs, "del1.md", "content");
			addFile(remoteFs, "del2.md", "content");
			// Path-based so the AuthError is deterministic regardless of pool order.
			// Deletes are pooled now, so a sibling may already have started — we assert
			// only that the AuthError propagates and aborts, NOT sibling survival.
			const origDelete = remoteFs.delete.bind(remoteFs);
			vi.spyOn(remoteFs, "delete").mockImplementation((path: string) => {
				if (path === "del1.md") return Promise.reject(authErr);
				return origDelete(path);
			});

			const plan = makePlan([
				{ path: "del1.md", action: "delete_remote" },
				{ path: "del2.md", action: "delete_remote" },
			]);

			await expect(executePlan(plan, ctx)).rejects.toThrow(AuthError);
		});

		it("aborts the cycle on AuthError during a local delete (structural phase)", async () => {
			const ctx = makeCtx();
			const authErr = new AuthError("Unauthorized", 401);
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "del1.md", "content");
			addFile(localFs, "del2.md", "content");
			const origDelete = localFs.delete.bind(localFs);
			vi.spyOn(localFs, "delete").mockImplementation((path: string) => {
				if (path === "del1.md") return Promise.reject(authErr);
				return origDelete(path);
			});

			const plan = makePlan([
				{ path: "del1.md", action: "delete_local" },
				{ path: "del2.md", action: "delete_local" },
			]);

			await expect(executePlan(plan, ctx)).rejects.toThrow(AuthError);
		});

		it("aborts the cycle on AuthError during a conflict (conflict phase)", async () => {
			const ctx = makeCtx();
			const authErr = new AuthError("Unauthorized", 401);
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "c1.md", "local");
			addFile(remoteFs, "c1.md", "remote");
			addFile(localFs, "c2.md", "local2");
			addFile(remoteFs, "c2.md", "remote2");
			vi.spyOn(localFs, "stat").mockRejectedValueOnce(authErr);

			const plan = makePlan([
				{
					path: "c1.md",
					action: "conflict",
					local: { path: "c1.md", isDirectory: false, size: 5, mtime: 2000, hash: "l" },
					remote: { path: "c1.md", isDirectory: false, size: 6, mtime: 1500, hash: "r" },
				},
				{
					path: "c2.md",
					action: "conflict",
					local: { path: "c2.md", isDirectory: false, size: 6, mtime: 2000, hash: "l2" },
					remote: { path: "c2.md", isDirectory: false, size: 7, mtime: 1500, hash: "r2" },
				},
			]);

			await expect(executePlan(plan, ctx)).rejects.toThrow(AuthError);
		});

		it("logs error for failed individual action", async () => {
			const errorSpy = vi.fn();
			const ctx = makeCtx({
				logger: {
					debug: vi.fn(),
					info: vi.fn(),
					warn: vi.fn(),
					error: errorSpy,
				} as unknown as ExecutionContext["logger"],
			});

			const plan = makePlan([{
				path: "no-such-file.md",
				action: "push",
				local: { path: "no-such-file.md", isDirectory: false, size: 5, mtime: 1000, hash: "" },
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.failed).toHaveLength(1);
			expect(errorSpy).toHaveBeenCalled();
		});
	});

	describe("phase scheduling", () => {
		it("runs transfers, then conflict, then structural (renames before deletes per lane)", async () => {
			const order: string[] = [];
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;

			addFile(localFs, "push.md", "push");
			addFile(localFs, "conflict.md", "local");
			addFile(remoteFs, "conflict.md", "remote");
			addFile(remoteFs, "rr-old.md", "rr"); // rename_remote source (remote lane)
			addFile(remoteFs, "dr.md", "dr");      // delete_remote (remote lane)
			addFile(localFs, "rl-old.md", "rl");   // rename_local source (local lane)
			addFile(localFs, "dl.md", "dl");       // delete_local (local lane)
			stateStore.records.set("rr-old.md", {
				path: "rr-old.md", hash: "h", localMtime: 1000, remoteMtime: 1000,
				localSize: 2, remoteSize: 2, syncedAt: 900,
			});
			stateStore.records.set("rl-old.md", {
				path: "rl-old.md", hash: "h", localMtime: 1000, remoteMtime: 1000,
				localSize: 2, remoteSize: 2, syncedAt: 900,
			});

			const origLocalRead = localFs.read.bind(localFs);
			vi.spyOn(localFs, "read").mockImplementation((path: string) => {
				if (path === "push.md") order.push("push");
				if (path === "conflict.md") order.push("conflict");
				return origLocalRead(path);
			});
			const origRemoteRename = remoteFs.rename.bind(remoteFs);
			vi.spyOn(remoteFs, "rename").mockImplementation((o: string, n: string) => {
				order.push("rename_remote");
				return origRemoteRename(o, n);
			});
			const origRemoteDelete = remoteFs.delete.bind(remoteFs);
			vi.spyOn(remoteFs, "delete").mockImplementation((path: string) => {
				order.push("delete_remote");
				return origRemoteDelete(path);
			});
			const origLocalRename = localFs.rename.bind(localFs);
			vi.spyOn(localFs, "rename").mockImplementation((o: string, n: string) => {
				order.push("rename_local");
				return origLocalRename(o, n);
			});
			const origLocalDelete = localFs.delete.bind(localFs);
			vi.spyOn(localFs, "delete").mockImplementation((path: string) => {
				order.push("delete_local");
				return origLocalDelete(path);
			});

			const plan = makePlan([
				{ path: "push.md", action: "push", local: { path: "push.md", isDirectory: false, size: 4, mtime: 1000, hash: "" } },
				{
					path: "conflict.md",
					action: "conflict",
					local: { path: "conflict.md", isDirectory: false, size: 5, mtime: 2000, hash: "l" },
					remote: { path: "conflict.md", isDirectory: false, size: 6, mtime: 1500, hash: "r" },
				},
				{
					path: "rr-new.md", action: "rename_remote", oldPath: "rr-old.md",
					local: { path: "rr-new.md", isDirectory: false, size: 2, mtime: 1000, hash: "h" },
					remote: { path: "rr-old.md", isDirectory: false, size: 2, mtime: 1000, hash: "h" },
					baseline: stateStore.records.get("rr-old.md"),
				},
				{ path: "dr.md", action: "delete_remote" },
				{
					path: "rl-new.md", action: "rename_local", oldPath: "rl-old.md",
					remote: { path: "rl-new.md", isDirectory: false, size: 2, mtime: 1000, hash: "h" },
					baseline: stateStore.records.get("rl-old.md"),
				},
				{ path: "dl.md", action: "delete_local" },
			]);

			await executePlan(plan, ctx);

			const i = (s: string) => order.indexOf(s);
			// Phase order: transfers < conflict < structural.
			expect(i("push")).toBeLessThan(i("conflict"));
			expect(i("conflict")).toBeLessThan(i("rename_remote"));
			expect(i("conflict")).toBeLessThan(i("rename_local"));
			expect(i("conflict")).toBeLessThan(i("delete_remote"));
			expect(i("conflict")).toBeLessThan(i("delete_local"));
			// Within each lane: rename before delete.
			expect(i("rename_remote")).toBeLessThan(i("delete_remote"));
			expect(i("rename_local")).toBeLessThan(i("delete_local"));
			// No cross-lane ordering is asserted — the remote and local lanes run concurrently.
		});

		it("does not start structural ops until transfers finish (Phase 1 barrier)", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "p.md", "x");
			addFile(remoteFs, "d.md", "y");

			const gate = deferred();
			const origRead = localFs.read.bind(localFs);
			vi.spyOn(localFs, "read").mockImplementation(async (path: string) => {
				if (path === "p.md") await gate.promise;
				return origRead(path);
			});
			const deleteSpy = vi.spyOn(remoteFs, "delete");

			const plan = makePlan([
				{ path: "p.md", action: "push", local: { path: "p.md", isDirectory: false, size: 1, mtime: 1000, hash: "" } },
				{ path: "d.md", action: "delete_remote" },
			]);

			const p = executePlan(plan, ctx);
			await flush();
			// The push is gated, so Phase 3 has not started.
			expect(deleteSpy).not.toHaveBeenCalled();
			gate.resolve();
			await p;
			expect(deleteSpy).toHaveBeenCalled();
		});
	});

	describe("concurrency", () => {
		it("runs the remote and local structural lanes concurrently", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(remoteFs, "r.md", "x");
			addFile(localFs, "l.md", "y");

			let running = 0;
			let maxRunning = 0;
			const gate = deferred();
			const gateDelete = (fs: ReturnType<typeof createMockFs>) => {
				const orig = fs.delete.bind(fs);
				vi.spyOn(fs, "delete").mockImplementation(async (path: string) => {
					running++;
					maxRunning = Math.max(maxRunning, running);
					await gate.promise;
					running--;
					return orig(path);
				});
			};
			gateDelete(remoteFs);
			gateDelete(localFs);

			const plan = makePlan([
				{ path: "r.md", action: "delete_remote" },
				{ path: "l.md", action: "delete_local" },
			]);

			const p = executePlan(plan, ctx);
			await flush();
			expect(running).toBe(2); // both lanes' deletes are in flight at once
			gate.resolve();
			await p;
			expect(maxRunning).toBe(2);
		});

		it("bounds concurrent deletes to the delete-pool size (per lane)", async () => {
			const POOL = 5; // must match DELETE_CONCURRENCY in plan-executor.ts
			const ctx = makeCtx();
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			const paths = Array.from({ length: POOL + 1 }, (_, k) => `del${k}.md`);
			for (const path of paths) addFile(remoteFs, path, "x");

			let running = 0;
			let maxRunning = 0;
			const gate = deferred();
			const orig = remoteFs.delete.bind(remoteFs);
			vi.spyOn(remoteFs, "delete").mockImplementation(async (path: string) => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				await gate.promise;
				running--;
				return orig(path);
			});

			const plan = makePlan(paths.map((path) => ({ path, action: "delete_remote" as const })));

			const p = executePlan(plan, ctx);
			await flush();
			expect(running).toBe(POOL); // the POOL+1th delete is queued, not running
			gate.resolve();
			await p;
			expect(maxRunning).toBe(POOL);
		});
	});

	describe("concurrent delete safety", () => {
		it("handles an overlapping folder + child delete_remote without failures (idempotent)", async () => {
			const ctx = makeCtx();
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(remoteFs, "A/child.md", "x"); // seeds folder A + the child

			// The folder and its descendant are both deleted in one plan (the decision
			// engine emits one delete per path; folder deletes are not coalesced). Pooled,
			// they overlap — recursive + idempotent delete must keep both succeeding.
			const plan = makePlan([
				{ path: "A", action: "delete_remote" },
				{ path: "A/child.md", action: "delete_remote" },
			]);

			const result = await executePlan(plan, ctx);

			expect(result.failed).toHaveLength(0);
			expect(result.succeeded).toHaveLength(2);
			expect(remoteFs.files.has("A")).toBe(false);
			expect(remoteFs.files.has("A/child.md")).toBe(false);
		});
	});

	describe("conflict runs in its own phase (not pooled with transfers)", () => {
		it("a pushed `.conflict` sidecar is not clobbered by a same-cycle conflict's duplicate", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			// A genuine conflict on foo.md (both sides, different content).
			addFile(localFs, "foo.md", "local-foo");
			addFile(remoteFs, "foo.md", "remote-foo");
			// A user file literally named foo.conflict.md, pushed in the SAME plan.
			addFile(localFs, "foo.conflict.md", "USER SIDECAR");

			const plan = makePlan([
				{ path: "foo.conflict.md", action: "push", local: { path: "foo.conflict.md", isDirectory: false, size: 12, mtime: 1000, hash: "" } },
				{
					path: "foo.md", action: "conflict",
					local: { path: "foo.md", isDirectory: false, size: 9, mtime: 2000, hash: "l" },
					remote: { path: "foo.md", isDirectory: false, size: 10, mtime: 1500, hash: "r" },
				},
			]);

			const result = await executePlan(plan, ctx);

			expect(result.failed).toHaveLength(0);
			// Conflict resolves in Phase 2 — AFTER the Phase 1 push — so generateConflictPath
			// sees foo.conflict.md is taken and picks the next free name; the pushed sidecar
			// survives. If conflict were pooled with transfers, this would race (see ADR 0001).
			expect(readText(remoteFs, "foo.conflict.md")).toBe("USER SIDECAR");
			expect(remoteFs.files.has("foo.conflict-2.md")).toBe(true);
		});
	});

	describe("progress reporting", () => {
		it("reports progress once per action across all phases", async () => {
			const calls: Array<[number, number]> = [];
			const ctx = makeCtx({
				conflictStrategy: "duplicate",
				onProgress: (completed, total) => calls.push([completed, total]),
			});
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			addFile(localFs, "p.md", "p");
			addFile(localFs, "cf.md", "l");
			addFile(remoteFs, "cf.md", "r");
			addFile(remoteFs, "dr.md", "x");
			addFile(localFs, "dl.md", "y");
			stateStore.records.set("dr.md", {
				path: "dr.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 1, remoteSize: 1, syncedAt: 900,
			});
			stateStore.records.set("dl.md", {
				path: "dl.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 1, remoteSize: 1, syncedAt: 900,
			});

			const plan = makePlan([
				{ path: "p.md", action: "push", local: { path: "p.md", isDirectory: false, size: 1, mtime: 1000, hash: "" } },
				{
					path: "m.md", action: "match",
					local: { path: "m.md", isDirectory: false, size: 1, mtime: 1000, hash: "h" },
					remote: { path: "m.md", isDirectory: false, size: 1, mtime: 1000, hash: "h" },
				},
				{
					path: "cf.md", action: "conflict",
					local: { path: "cf.md", isDirectory: false, size: 1, mtime: 2000, hash: "l" },
					remote: { path: "cf.md", isDirectory: false, size: 1, mtime: 1500, hash: "r" },
				},
				{ path: "dr.md", action: "delete_remote" },
				{ path: "dl.md", action: "delete_local" },
			]);

			await executePlan(plan, ctx);

			expect(calls).toHaveLength(5);
			expect(calls[calls.length - 1]).toEqual([5, 5]);
			expect(calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
		});
	});

	describe("empty plan", () => {
		it("returns empty result for a plan with no actions", async () => {
			const ctx = makeCtx();
			const plan = makePlan([]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(0);
			expect(result.failed).toHaveLength(0);
			expect(result.conflicts).toHaveLength(0);
		});
	});
});

describe("withIoRetry (per-action in-cycle retry)", () => {
	const httpErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
	const pushPlan = (path = "x.md"): SyncPlan =>
		makePlan([{ path, action: "push", local: { path, isDirectory: false, size: 7, mtime: 1000, hash: "" } }]);

	it("retries a rate-limited (429) transfer, then succeeds", async () => {
		const ctx = makeCtx();
		const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		addFile(localFs, "x.md", "content");
		const orig = remoteFs.write.bind(remoteFs);
		let n = 0;
		const writeSpy = vi.spyOn(remoteFs, "write").mockImplementation((p, c, m) =>
			n++ === 0 ? Promise.reject(httpErr(429)) : orig(p, c, m));

		const result = await executePlan(pushPlan(), ctx);

		expect(result.succeeded).toHaveLength(1);
		expect(result.failed).toHaveLength(0);
		expect(writeSpy).toHaveBeenCalledTimes(2);
	});

	it("retries a transient (503) transfer, then succeeds", async () => {
		const ctx = makeCtx();
		const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		addFile(localFs, "x.md", "content");
		const orig = remoteFs.write.bind(remoteFs);
		let n = 0;
		const writeSpy = vi.spyOn(remoteFs, "write").mockImplementation((p, c, m) =>
			n++ === 0 ? Promise.reject(httpErr(503)) : orig(p, c, m));

		const result = await executePlan(pushPlan(), ctx);

		expect(result.succeeded).toHaveLength(1);
		expect(writeSpy).toHaveBeenCalledTimes(2);
	});

	it("does NOT retry a permission (403) error — records failed, does not abort the cycle", async () => {
		const ctx = makeCtx();
		const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		addFile(localFs, "x.md", "content");
		const writeSpy = vi.spyOn(remoteFs, "write").mockRejectedValue(httpErr(403));

		const result = await executePlan(pushPlan(), ctx); // resolves (no abort)

		expect(result.failed).toHaveLength(1);
		expect(result.succeeded).toHaveLength(0);
		expect(writeSpy).toHaveBeenCalledTimes(1); // not retried
	});

	it("does NOT retry a notFound (404) error", async () => {
		const ctx = makeCtx();
		const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		addFile(localFs, "x.md", "content");
		const writeSpy = vi.spyOn(remoteFs, "write").mockRejectedValue(httpErr(404));

		const result = await executePlan(pushPlan(), ctx);

		expect(result.failed).toHaveLength(1);
		expect(writeSpy).toHaveBeenCalledTimes(1);
	});

	it("aborts (no retry) on AuthError", async () => {
		const ctx = makeCtx();
		const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		addFile(localFs, "x.md", "content");
		const writeSpy = vi.spyOn(remoteFs, "write").mockRejectedValue(new AuthError("unauthorized", 401));

		await expect(executePlan(pushPlan(), ctx)).rejects.toThrow(AuthError);
		expect(writeSpy).toHaveBeenCalledTimes(1); // AuthError is rethrown immediately
	});

	it("gives up after MAX_ACTION_RETRIES (3) → failed, without a cycle abort", async () => {
		const ctx = makeCtx();
		const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		addFile(localFs, "x.md", "content");
		const writeSpy = vi.spyOn(remoteFs, "write").mockRejectedValue(httpErr(429));

		const result = await executePlan(pushPlan(), ctx); // resolves (no throw → no cycle retry)

		expect(writeSpy).toHaveBeenCalledTimes(3);
		expect(result.failed).toHaveLength(1);
	});

	it("uses ctx.classifyError (Google 403 = rate-limit), so a 403 retries", async () => {
		const ctx = makeCtx({ classifyError: () => ({ kind: "rateLimit", retryAfterMs: 1 }) });
		const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		addFile(localFs, "x.md", "content");
		const orig = remoteFs.write.bind(remoteFs);
		let n = 0;
		const writeSpy = vi.spyOn(remoteFs, "write").mockImplementation((p, c, m) =>
			n++ === 0 ? Promise.reject(httpErr(403)) : orig(p, c, m));

		const result = await executePlan(pushPlan(), ctx);

		expect(result.succeeded).toHaveLength(1); // retried — proves ctx.classifyError is used
		expect(writeSpy).toHaveBeenCalledTimes(2);
	});

	it("signals the transfer pool (noteRateLimit) BEFORE sleeping, on a 429", async () => {
		const order: string[] = [];
		const noteSpy = vi.spyOn(AdaptivePool.prototype, "noteRateLimit").mockImplementation(() => { order.push("noteRateLimit"); });
		const ctx = makeCtx({ sleep: (ms) => { order.push(`sleep:${ms}`); return Promise.resolve(); } });
		const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		addFile(localFs, "x.md", "content");
		const orig = remoteFs.write.bind(remoteFs);
		let n = 0;
		vi.spyOn(remoteFs, "write").mockImplementation((p, c, m) =>
			n++ === 0 ? Promise.reject(httpErr(429)) : orig(p, c, m));

		await executePlan(pushPlan(), ctx);

		expect(noteSpy).toHaveBeenCalledTimes(1);
		expect(order[0]).toBe("noteRateLimit");
		expect(order[1]).toMatch(/^sleep:/);
	});

	it("does NOT retry a rate-limited conflict (not idempotent) and never signals the transfer pool (D1)", async () => {
		const noteSpy = vi.spyOn(AdaptivePool.prototype, "noteRateLimit");
		const ctx = makeCtx({ conflictStrategy: "duplicate" });
		const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		addFile(localFs, "g.md", "local version");
		addFile(remoteFs, "g.md", "remote version");
		const readSpy = vi.spyOn(remoteFs, "read").mockRejectedValue(httpErr(429));

		const result = await executePlan(makePlan([{
			path: "g.md",
			action: "conflict",
			local: { path: "g.md", isDirectory: false, size: 13, mtime: 2000, hash: "l" },
			remote: { path: "g.md", isDirectory: false, size: 14, mtime: 1500, hash: "r" },
		}]), ctx);

		// Conflict resolution is not idempotent on replay (a partial .conflict write would
		// be orphaned by generateConflictPath on retry), so it is NOT wrapped in withIoRetry:
		// a rate-limit fails the action (re-resolved next cycle) rather than retrying mid-resolve.
		expect(result.conflicts).toHaveLength(0);
		expect(result.failed).toHaveLength(1);
		expect(readSpy).toHaveBeenCalledTimes(1); // not retried
		expect(noteSpy).not.toHaveBeenCalled(); // conflict is serial; it never feeds the transfer pool
	});

	it("does NOT retry a rename (not idempotent on replay)", async () => {
		const ctx = makeCtx();
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		const renameSpy = vi.spyOn(remoteFs, "rename").mockRejectedValue(httpErr(429));

		const result = await executePlan(makePlan([{
			path: "new.md",
			action: "rename_remote",
			oldPath: "old.md",
			local: { path: "new.md", isDirectory: false, size: 5, mtime: 1000, hash: "h" },
		}]), ctx);

		// rename tier is excluded from withIoRetry: re-running rename(oldPath, …) would hit a
		// source the first (successful) attempt already moved → a spurious failure.
		expect(result.failed).toHaveLength(1);
		expect(renameSpy).toHaveBeenCalledTimes(1);
	});
});

describe("adaptive transfer pool (Phase 1)", () => {
	function gatedWrites(remoteFs: ReturnType<typeof createMockFs>) {
		const gate = deferred();
		let running = 0;
		const counter = { max: 0 };
		const orig = remoteFs.write.bind(remoteFs);
		vi.spyOn(remoteFs, "write").mockImplementation(async (p, c, m) => {
			running++;
			counter.max = Math.max(counter.max, running);
			await gate.promise;
			running--;
			return orig(p, c, m);
		});
		return { gate, counter };
	}

	function manyPushes(n: number, ctx: ExecutionContext, size = 7): SyncPlan {
		const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
		const actions: SyncAction[] = [];
		for (let i = 0; i < n; i++) {
			addFile(localFs, `f${i}.md`, "content");
			actions.push({ path: `f${i}.md`, action: "push", local: { path: `f${i}.md`, isDirectory: false, size, mtime: 1000, hash: "" } });
		}
		return makePlan(actions);
	}

	it("starts transfers at the desktop pool's start concurrency (5)", async () => {
		const ctx = makeCtx(); // DESKTOP_TRANSFER_POOL (start 5)
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		const { gate, counter } = gatedWrites(remoteFs);

		const p = executePlan(manyPushes(8, ctx), ctx);
		await flush();
		expect(counter.max).toBe(5);
		gate.resolve();
		await p;
	});

	it("caps mobile transfers at the mobile pool's start concurrency (3)", async () => {
		const ctx = makeCtx({ transferPool: MOBILE_TRANSFER_POOL });
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		const { gate, counter } = gatedWrites(remoteFs);

		const p = executePlan(manyPushes(8, ctx), ctx);
		await flush();
		expect(counter.max).toBe(3); // tiny files: count-bound at start 3, well under the byte budget
		gate.resolve();
		await p;
	});

	it("byte-bounds transfers below the count ceiling when files are large", async () => {
		// Count would allow 10 at once, but a 30-byte budget admits only 3 of the 10-byte files.
		const ctx = makeCtx({
			transferPool: { min: 1, start: 10, max: 10, rampAfter: 100, byteBudget: 30 },
		});
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		const { gate, counter } = gatedWrites(remoteFs);

		const p = executePlan(manyPushes(8, ctx, 10), ctx);
		await flush();
		expect(counter.max).toBe(3); // 3 * 10 = 30 fits; the byte budget, not the count, binds
		gate.resolve();
		await p;
	});

	it("lets small files reach the count ceiling under a generous byte budget", async () => {
		const ctx = makeCtx({
			transferPool: { min: 1, start: 4, max: 4, rampAfter: 100, byteBudget: 48 * 1024 * 1024 },
		});
		const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
		const { gate, counter } = gatedWrites(remoteFs);

		const p = executePlan(manyPushes(8, ctx, 7), ctx);
		await flush();
		expect(counter.max).toBe(4); // tiny files are count-bound, never byte-throttled
		gate.resolve();
		await p;
	});
});

describe("toConflictRecords", () => {
	const localEntity = { path: "a.md", isDirectory: false, size: 1, mtime: 1, hash: "L" };
	const remoteEntity = { path: "a.md", isDirectory: false, size: 2, mtime: 2, hash: "R" };

	it("maps a resolved conflict to a record carrying the resolution + stamps", () => {
		const conflicts: ResolvedConflict[] = [{
			action: { action: "conflict", path: "a.md" } as unknown as SyncAction,
			resolution: { action: "duplicated", duplicatePath: "a.conflict.md" },
			localEntity,
			remoteEntity,
		}];
		const rec = toConflictRecords(conflicts, "duplicate", "sess-1", "2024-01-01T00:00:00.000Z")[0]!;
		expect(rec.path).toBe("a.md");
		expect(rec.actionType).toBe("conflict");
		expect(rec.strategy).toBe("duplicate");
		expect(rec.action).toBe("duplicated");
		expect(rec.duplicatePath).toBe("a.conflict.md");
		expect(rec.local).toBe(localEntity);
		expect(rec.remote).toBe(remoteEntity);
		expect(rec.sessionId).toBe("sess-1");
		expect(rec.resolvedAt).toBe("2024-01-01T00:00:00.000Z");
	});

	it("carries hasConflictMarkers through for a merged resolution (and tolerates absent entities)", () => {
		const conflicts: ResolvedConflict[] = [{
			action: { action: "conflict", path: "b.md" } as unknown as SyncAction,
			resolution: { action: "merged", hasConflictMarkers: true },
		}];
		const rec = toConflictRecords(conflicts, "auto_merge", "s", "t")[0]!;
		expect(rec.action).toBe("merged");
		expect(rec.hasConflictMarkers).toBe(true);
		expect(rec.local).toBeUndefined();
	});

	it("returns an empty list for no conflicts (so the writer is never touched)", () => {
		expect(toConflictRecords([], "auto_merge", "s", "t")).toEqual([]);
	});
});
