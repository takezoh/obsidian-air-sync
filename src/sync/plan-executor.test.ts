import { describe, it, expect, vi, afterEach } from "vitest";
import { executePlan, toConflictRecords, DESKTOP_TRANSFER_POOL, MOBILE_TRANSFER_POOL } from "./plan-executor";
import type { ExecutionContext, ResolvedConflict } from "./plan-executor";
import type { PathObservation, SyncAction, SyncRecord } from "./types";
import { createMockLocalFs, createMockRemoteFs, type MockFileSystem, createMockStateStore, addFile, readText, deferred, flush } from "../__mocks__/sync-test-helpers";
import { AuthError, classifyHttpError } from "../fs/errors";
import { AdaptivePool } from "../queue/async-queue";
import {
	admitBatchObservation,
	type AuthorizedSyncPlan,
} from "./plan-admission";
import { captureBatchObservation } from "./sync-cycle-planning";
import { resolveConflict } from "./conflict-resolver";
import { ContentProofError } from "./content-snapshot";
import { PriorityCoordinator } from "./priority-coordinator";
import { buildSyncRecord } from "./state-committer";

function makeCtx(
	overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
	const localFs = createMockLocalFs();
	// This executor fixture models provider-resolved stat after writes. The
	// requested-echo backend boundary is exercised in fact-first-execution.
	const remoteFs = createMockRemoteFs("actual_resolved");
	const stateStore = createMockStateStore();
	return {
		localFs,
		remoteFs,
		committer: {
			stateStore: stateStore,
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

function makePlan(actions: SyncAction[], orderedComponent = false): AuthorizedSyncPlan {
	// Executor unit boundary: the caller supplies exact admitted inputs. Actual
	// Admission-to-executor wiring is exercised below and in fact-first-execution.
	// This fixture neither makes policy decisions nor refreshes raced snapshots.
	actions = actions.map((action) => action.publication || ("descendantRecords" in action && action.descendantRecords)
		? action : { ...action, publication: {
			source: action.baseline,
			destination: action.baseline?.path === action.path ? action.baseline : undefined,
		} });
	const components = actions.map((action) => ({
			kind: "authorized", actions: [action], evidence: [],
			paths: [...new Set([action.path, action.local?.path, action.remote?.path,
				action.baseline?.path, ...("oldPath" in action ? [action.oldPath] : [])]
				.filter((path): path is string => path !== undefined))],
		}));
	return {
		actions,
		components: orderedComponent ? [{ kind: "authorized", actions, evidence: [],
			paths: [...new Set(components.flatMap((component) => component.paths))] }] : components,
	} as unknown as AuthorizedSyncPlan;
}

async function arrangeFreshRename(ctx: ExecutionContext) {
	const localFs = ctx.localFs as MockFileSystem;
	const remoteFs = ctx.remoteFs as MockFileSystem;
	addFile(localFs, "new.md", "current", 2000);
	addFile(remoteFs, "old.md", "baseline", 1000);
	remoteFs.files.get("old.md")!.entity.identityKey = "R";
	const local = (await localFs.stat("new.md"))!;
	const remote = (await remoteFs.stat("old.md"))!;
	const baseline: SyncRecord = {
		path: "old.md", hash: remote.hash, localMtime: 1000, remoteMtime: 1000,
		localSize: remote.size, remoteSize: remote.size, remoteIdentityKey: "R", syncedAt: 900,
	};
	const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
	stateStore.records.set("old.md", baseline);
	const action: Extract<SyncAction, { action: "rename_remote" | "rename_local" }> = {
		path: "new.md", oldPath: "old.md",
		action: "rename_remote", local, remote, baseline,
		publication: { source: baseline, destination: undefined },
		content: { mode: "copy", read: { side: "local", entity: local }, write: { side: "remote", path: "new.md" } },
	};
	return { local, remoteFs, stateStore, baseline, action };
}

async function arrangeFreshConflict(ctx: ExecutionContext, withOccupant = false) {
	const localFs = ctx.localFs as MockFileSystem;
	const remoteFs = ctx.remoteFs as MockFileSystem;
	addFile(localFs, "new.md", "local current", 2000);
	const local = (await localFs.stat("new.md"))!;
	addFile(remoteFs, "old.md", "remote changed", 1500).identityKey = "R";
	const source = (await remoteFs.stat("old.md"))!;
	const additional = withOccupant
		? addFile(remoteFs, "new.md", "foreign occupant", 1400)
		: undefined;
	if (additional) additional.identityKey = "Y";
	const baseline: SyncRecord = {
		path: "old.md", hash: "baseline", localMtime: 1000, remoteMtime: 1000,
		localSize: 8, remoteSize: 8, remoteIdentityKey: "R", syncedAt: 900,
	};
	const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
	stateStore.records.set("old.md", baseline);
	const action: SyncAction = {
		path: "new.md", action: "conflict", local, remote: source, baseline,
		remoteIdentitySource: source,
		...(additional ? { additionalRemote: (await remoteFs.stat("new.md"))! } : {}),
		publication: { source: baseline, destination: undefined },
	};
	return { action, localFs, remoteFs, stateStore, baseline };
}

// Some suites spy on AdaptivePool.prototype (a global) — restore after each test
// so the spy never leaks into another (vitest is not configured to auto-restore).
afterEach(() => vi.restoreAllMocks());

describe("executePlan", () => {
	it.each(["push", "pull"] as const)("does not publish %s when its source disappears during the write", async (kind) => {
		const ctx = makeCtx();
		const source = (kind === "push" ? ctx.localFs : ctx.remoteFs) as MockFileSystem;
		const target = (kind === "push" ? ctx.remoteFs : ctx.localFs) as MockFileSystem;
		addFile(source, "race.md", "original");
		const snapshot = (await source.stat("race.md"))!;
		const write = target.write.bind(target);
		vi.spyOn(target, "write").mockImplementation(async (path, bytes, mtime) => {
			const result = await write(path, bytes, mtime);
			await source.delete("race.md");
			return result;
		});
		const result = await executePlan(makePlan([{
			action: kind, path: "race.md", ...(kind === "push" ? { local: snapshot } : { remote: snapshot }),
		}]), ctx);
		expect(result.succeeded).toEqual([]);
		expect(result.blocked).toHaveLength(1);
		expect(await ctx.committer.stateStore.get("race.md")).toBeUndefined();
	});

	it.each(["push", "pull"] as const)("rejects %s read bytes inconsistent with its admitted snapshot before writing", async (kind) => {
		const ctx = makeCtx();
		const source = (kind === "push" ? ctx.localFs : ctx.remoteFs) as MockFileSystem;
		const target = kind === "push" ? ctx.remoteFs : ctx.localFs;
		addFile(source, "race.md", "original");
		const snapshot = (await source.stat("race.md"))!;
		vi.spyOn(source, "read").mockResolvedValue(new TextEncoder().encode("modified").buffer);
		const write = vi.spyOn(target, "write");
		const result = await executePlan(makePlan([{
			action: kind, path: "race.md", ...(kind === "push" ? { local: snapshot } : { remote: snapshot }),
		}]), ctx);
		expect(result.succeeded).toEqual([]);
		expect(result.blocked).toHaveLength(1);
		expect(write).not.toHaveBeenCalled();
		expect(await ctx.committer.stateStore.get("race.md")).toBeUndefined();
	});

	describe("push", () => {
		it("uploads local file to remote and commits state", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
			addFile(localFs, "a.md", "content");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;

			const plan = makePlan([{
				path: "a.md",
				action: "push",
				local: (await localFs.stat("a.md"))!,
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(result.failed).toHaveLength(0);
			expect(remoteFs.files.has("a.md")).toBe(true);
			expect(stateStore.records.has("a.md")).toBe(true);
		});

	});

	describe("pull", () => {
		it("downloads remote file to local and commits state", async () => {
			const ctx = makeCtx();
			const remoteFs = ctx.remoteFs as MockFileSystem;
			addFile(remoteFs, "b.md", "remote content");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;

			const plan = makePlan([{
				path: "b.md",
				action: "pull",
				remote: (await remoteFs.stat("b.md"))!,
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(result.failed).toHaveLength(0);
			expect((ctx.localFs as MockFileSystem).files.has("b.md")).toBe(true);
			expect(stateStore.records.has("b.md")).toBe(true);
		});

		it("skips provider I/O for an exact action superseded after permit acquisition", async () => {
			const action: SyncAction = {
				path: "b.md", action: "pull",
				remote: { path: "b.md", isDirectory: false, size: 1, mtime: 2, hash: "" },
			};
			const plan = makePlan([action]);
			const admittedAction = plan.actions[0]!;
			const terminalRecord: SyncRecord = {
				path: "b.md", hash: "new", localMtime: 2, remoteMtime: 2,
				localSize: 1, remoteSize: 1, remoteIdentityKey: "remote-id", syncedAt: 2,
			};
			const ctx = makeCtx({
				acquireActionPermit: () => Promise.resolve({ release: vi.fn() }),
				beginAction: (candidate) => candidate === admittedAction ? { action: admittedAction, terminalRecord } : "run",
			});
			const read = vi.spyOn(ctx.remoteFs, "read");

			const result = await executePlan(plan, ctx);

			expect(result.superseded).toEqual([{ action: admittedAction, terminalRecord }]);
			expect(result.succeeded).toEqual([]);
			expect(read).not.toHaveBeenCalled();
		});

		it("holds the action permit through SyncRecord commit and result publication", async () => {
			let released = false;
			const order: string[] = [];
			const ctx = makeCtx({
				acquireActionPermit: () => Promise.resolve({ release: () => {
					released = true;
					order.push("release");
				} }),
				onProgress: () => { order.push("terminal-published"); },
			});
			const remoteFs = ctx.remoteFs as MockFileSystem;
			addFile(remoteFs, "permit.md", "x");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			const compareAndPut = stateStore.compareAndPut.bind(stateStore);
			const put = vi.spyOn(stateStore, "compareAndPut").mockImplementation((expected, record) => {
				expect(released).toBe(false);
				return compareAndPut(expected, record);
			});

			const result = await executePlan(makePlan([{
				path: "permit.md", action: "pull",
				remote: (await remoteFs.stat("permit.md"))!,
			}]), ctx);

			expect(put).toHaveBeenCalledOnce();
			expect(result.succeeded).toHaveLength(1);
			expect(released).toBe(true);
			expect(order).toEqual(["terminal-published", "release"]);
		});

		it("publishes a fatal terminal state before releasing its permit", async () => {
			const order: string[] = [];
			const ctx = makeCtx({
				acquireActionPermit: () => Promise.resolve({ release: () => { order.push("release"); } }),
				onActionFatal: () => { order.push("fatal-published"); },
			});
			addFile(ctx.remoteFs as MockFileSystem, "fatal.md", "x");
			const remote = (await ctx.remoteFs.stat("fatal.md"))!;
			vi.spyOn(ctx.remoteFs, "read").mockRejectedValue(new AuthError("expired", 401));

			await expect(executePlan(makePlan([{
				path: "fatal.md", action: "pull",
				remote,
			}]), ctx)).rejects.toThrow("expired");
			expect(order).toEqual(["fatal-published", "release"]);
		});
	});

	describe("match", () => {
		it("commits state without file I/O", async () => {
			const ctx = makeCtx();
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			addFile(ctx.localFs as MockFileSystem, "c.md", "same");
			addFile(ctx.remoteFs as MockFileSystem, "c.md", "same");
			const local = (await ctx.localFs.stat("c.md"))!;
			const remote = (await ctx.remoteFs.stat("c.md"))!;
			const localRead = vi.spyOn(ctx.localFs, "read");
			const remoteRead = vi.spyOn(ctx.remoteFs, "read");

			const plan = makePlan([{ path: "c.md", action: "match", local, remote }]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(stateStore.records.has("c.md")).toBe(true);
			expect(localRead).not.toHaveBeenCalled();
			expect(remoteRead).not.toHaveBeenCalled();
		});
	});

	describe("delete_remote", () => {
		it("deletes remote file and removes state record", async () => {
			const ctx = makeCtx();
			const remoteFs = ctx.remoteFs as MockFileSystem;
			addFile(remoteFs, "d.md", "to delete");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			stateStore.records.set("d.md", {
				path: "d.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 9, remoteSize: 9, syncedAt: 900,
			});

			const plan = makePlan([{ path: "d.md", action: "delete_remote",
				remote: (await remoteFs.stat("d.md"))!, baseline: stateStore.records.get("d.md"),
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(remoteFs.files.has("d.md")).toBe(false);
			expect(stateStore.records.has("d.md")).toBe(false);
		});
	});

	describe("delete_local", () => {
		it("deletes local file and removes state record", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as MockFileSystem;
			addFile(localFs, "e.md", "to delete");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			stateStore.records.set("e.md", {
				path: "e.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 9, remoteSize: 9, syncedAt: 900,
			});

			const plan = makePlan([{ path: "e.md", action: "delete_local",
				local: (await localFs.stat("e.md"))!, baseline: stateStore.records.get("e.md"),
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(localFs.files.has("e.md")).toBe(false);
			expect(stateStore.records.has("e.md")).toBe(false);
		});
	});

	describe("rename_remote", () => {
		it("does not commit an unbaselined case-alias rename when content races after the move", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
			addFile(localFs, "case.md", "same");
			addFile(remoteFs, "Case.md", "same").identityKey = "R";
			const local = (await localFs.stat("case.md"))!;
			const remote = (await remoteFs.stat("Case.md"))!;
			const evidence = [
				{
					kind: "alias" as const, side: "local" as const,
					requestedPath: "Case.md", resolvedPath: "case.md",
				},
			];
			const observations: PathObservation[] = [
				{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
				{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
				{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
				{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
			];
			const plan = admitBatchObservation(captureBatchObservation(
				[{ path: "Case.md", remote }, { path: "case.md", local }], evidence, observations,
				{ isConfiguredScopeCompatible: () => true, byEndpoint: new Map([["Case.md", "included"], ["case.md", "included"]]) },
				"executor-test",
			)).executable;
			const rename = remoteFs.rename.bind(remoteFs);
			vi.spyOn(remoteFs, "rename").mockImplementation(async (oldPath, newPath) => {
				await rename(oldPath, newPath);
				addFile(localFs, "case.md", "raced");
			});

			const result = await executePlan(plan, ctx);

			expect(result.blocked).toHaveLength(1);
			expect(result.succeeded).toEqual([]);
			expect((ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>)
				.records.size).toBe(0);
		});

		it("runs an admitted fresh rename-write as one commit-last action", async () => {
			const ctx = makeCtx();
			const { local, remoteFs, stateStore, action } = await arrangeFreshRename(ctx);

			const result = await executePlan(makePlan([action]), ctx);

			expect(result.failed).toEqual([]);
			expect(readText(remoteFs, "new.md")).toBe("current");
			expect(remoteFs.files.has("old.md")).toBe(false);
			expect(stateStore.records.has("old.md")).toBe(false);
			expect(stateStore.records.get("new.md")?.hash).toBe(local.hash);
		});

		it("does not retry or commit after a partial fresh rename-write failure", async () => {
			const ctx = makeCtx();
			const { remoteFs, stateStore, baseline, action } = await arrangeFreshRename(ctx);
			const write = vi.spyOn(remoteFs, "write").mockRejectedValue(new Error("write failed"));
			const rename = vi.spyOn(remoteFs, "rename");

			const result = await executePlan(makePlan([action]), ctx);

			expect(result.failed).toHaveLength(1);
			expect(rename).toHaveBeenCalledTimes(1);
			expect(write).toHaveBeenCalledTimes(1);
			expect(stateStore.records.get("old.md")).toEqual(baseline);
			expect(stateStore.records.has("new.md")).toBe(false);
		});

		it("rechecks a same-metadata remote checksum change before rename execution", async () => {
			const ctx = makeCtx();
			const { remoteFs, stateStore, baseline, action } = await arrangeFreshRename(ctx);
			baseline.remoteChecksum = { algo: "md5", value: "Q0" };
			action.remote!.remoteChecksum = { algo: "md5", value: "Q0" };
			const remote = remoteFs.files.get("old.md")!.entity;
			remote.remoteChecksum = { algo: "md5", value: "Q1" };
			remote.hash = "";
			const rename = vi.spyOn(remoteFs, "rename");

			const result = await executePlan(makePlan([action]), ctx);

			expect(result.blocked).toHaveLength(1);
			expect(result.failed).toEqual([]);
			expect(rename).not.toHaveBeenCalled();
			expect(stateStore.records.get("old.md")).toEqual(baseline);
			expect(stateStore.records.has("new.md")).toBe(false);
		});

		it.each(["observe", "verify", "commit"] as const)(
			"leaves the old baseline after the fresh %s boundary fails",
			async (boundary) => {
				const ctx = makeCtx();
				const { remoteFs, stateStore, baseline, action } = await arrangeFreshRename(ctx);
				const rename = vi.spyOn(remoteFs, "rename");
				if (boundary === "observe") {
					const original = remoteFs.stat.bind(remoteFs);
					let destinationStats = 0;
					vi.spyOn(remoteFs, "stat").mockImplementation((path) => {
						if (path === "new.md" && ++destinationStats === 2) {
							return Promise.reject(new Error("observe failed"));
						}
						return original(path);
					});
				} else if (boundary === "verify") {
					const original = remoteFs.stat.bind(remoteFs);
					vi.spyOn(remoteFs, "stat").mockImplementation(async (path) => {
						const entity = await original(path);
						return path === "new.md" && entity ? { ...entity, hash: "", remoteChecksum: undefined } : entity;
					});
					vi.spyOn(remoteFs, "read").mockRejectedValue(new Error("verify failed"));
				} else {
					vi.spyOn(stateStore, "compareAndMove").mockRejectedValue(new Error("commit failed"));
				}

				const result = await executePlan(makePlan([action]), ctx);

				expect(result.failed).toHaveLength(1);
				expect(rename).toHaveBeenCalledTimes(1);
				expect(stateStore.records.get("old.md")).toEqual(baseline);
				expect(stateStore.records.has("new.md")).toBe(false);
				expect(remoteFs.files.has("old.md")).toBe(false);
			},
		);

		it("renames remote file and commits state at new path", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
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
				local: (await localFs.stat("new.md"))!,
				remote: (await remoteFs.stat("old.md"))!,
				baseline: stateStore.records.get("old.md"),
				content: { mode: "equal" },
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
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;

			// Set up: folder A with 2 files on remote, folder B with same files locally
			addFile(remoteFs, "A/f1.md", "content1");
			addFile(remoteFs, "A/f2.md", "content2");
			addFile(localFs, "B/f1.md", "content1");
			addFile(localFs, "B/f2.md", "content2");
			for (const name of ["f1.md", "f2.md"]) stateStore.records.set(`A/${name}`,
				buildSyncRecord((await localFs.stat(`B/${name}`))!, (await remoteFs.stat(`A/${name}`))!, `A/${name}`));

			const plan = makePlan([{
				path: "B",
				action: "rename_remote",
				oldPath: "A",
				isFolder: true,
				local: (await localFs.stat("B"))!, remote: (await remoteFs.stat("A"))!,
				descendantRecords: ["f1.md", "f2.md"].map((name) => ({
					oldPath: `A/${name}`, newPath: `B/${name}`,
					source: stateStore.records.get(`A/${name}`), destination: undefined,
				})),
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

			const plan = makePlan([{ path: "f.md", action: "cleanup", baseline: stateStore.records.get("f.md") }]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(stateStore.records.has("f.md")).toBe(false);
		});
	});

	describe("conflict", () => {
		it("preserves then rotates the tracked identity and returns terminal proof", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			addFile(localFs, "new.md", "local current", 2000);
			const local = (await localFs.stat("new.md"))!;
			addFile(remoteFs, "old.md", "remote changed", 1500).identityKey = "R";
			const source = (await remoteFs.stat("old.md"))!;
			const baseline: SyncRecord = {
				path: "old.md", hash: "baseline", localMtime: 1000, remoteMtime: 1000,
				localSize: 8, remoteSize: 8, remoteIdentityKey: "R", syncedAt: 900,
			};
			stateStore.records.set("old.md", baseline);
			const action: SyncAction = {
				path: "new.md", action: "conflict", local, remote: source, baseline,
				remoteIdentitySource: source,
				publication: { source: baseline, destination: undefined },
			};

			const result = await executePlan(makePlan([action]), ctx);

			expect(result.failed).toEqual([]);
			expect(result.blocked).toEqual([]);
			expect(readText(remoteFs, "new.md")).toBe("local current");
			expect(readText(remoteFs, "new.conflict.md")).toBe("remote changed");
			expect(remoteFs.files.has("old.md")).toBe(false);
			expect(remoteFs.files.get("new.md")?.entity.identityKey).toBe("R");
			expect(result.succeeded[0]?.terminalProof).toBeDefined();
			expect(result.conflicts[0]?.terminalProof).toBe(
				result.succeeded[0]?.terminalProof,
			);
			expect(stateStore.records.get("new.md")?.remoteIdentityKey).toBe("R");
		});

		it("blocks incomplete preservation coverage before any original-path effect", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const { action, localFs, remoteFs, stateStore, baseline } = await arrangeFreshConflict(ctx);
			const localWrite = vi.spyOn(localFs, "write");
			const remoteWrite = vi.spyOn(remoteFs, "write");
			const remoteDelete = vi.spyOn(remoteFs, "delete");
			const remoteRename = vi.spyOn(remoteFs, "rename");
			ctx.conflictResolver = () => Promise.resolve({
				action: "duplicated", targetContent: new TextEncoder().encode("local current").buffer,
				targetMtime: 2000, verifiedOutputs: [],
			});

			const result = await executePlan(makePlan([action]), ctx);

			expect(result.blocked).toHaveLength(1);
			expect(result.failed).toEqual([]);
			expect(localWrite).not.toHaveBeenCalled();
			expect(remoteWrite).not.toHaveBeenCalled();
			expect(remoteDelete).not.toHaveBeenCalled();
			expect(remoteRename).not.toHaveBeenCalled();
			expect(stateStore.records.get("old.md")).toEqual(baseline);
			expect(stateStore.records.has("new.md")).toBe(false);
		});

		it("blocks when rename reports success but the source remains", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const { action, remoteFs, stateStore, baseline } = await arrangeFreshConflict(ctx);
			vi.spyOn(remoteFs, "rename").mockResolvedValue(undefined);

			const result = await executePlan(makePlan([action]), ctx);

			expect(result.blocked).toHaveLength(1);
			expect(result.failed).toEqual([]);
			expect(remoteFs.files.has("old.md")).toBe(true);
			expect(stateStore.records.get("old.md")).toEqual(baseline);
			expect(stateStore.records.has("new.md")).toBe(false);
		});

		it("blocks terminal identity mismatch without committing", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const { action, remoteFs, stateStore } = await arrangeFreshConflict(ctx);
			const originalRename = remoteFs.rename.bind(remoteFs);
			vi.spyOn(remoteFs, "rename").mockImplementation(async (oldPath, newPath) => {
				await originalRename(oldPath, newPath);
				remoteFs.files.get(newPath)!.entity.identityKey = "wrong";
			});

			const result = await executePlan(makePlan([action]), ctx);

			expect(result.blocked).toHaveLength(1);
			expect(result.failed).toEqual([]);
			expect(stateStore.records.has("new.md")).toBe(false);
		});

		it("blocks terminal byte mismatch without committing", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const { action, remoteFs, stateStore } = await arrangeFreshConflict(ctx);
			const write = remoteFs.write.bind(remoteFs);
			vi.spyOn(remoteFs, "write").mockImplementation((path, content, mtime) => write(path,
				path === "new.md" ? new TextEncoder().encode("x".repeat(content.byteLength)).buffer : content, mtime));

			const result = await executePlan(makePlan([action]), ctx);

			expect(result.blocked).toHaveLength(1);
			expect(stateStore.records.has("new.md")).toBe(false);
		});

		it("blocks when tracked R changes after preservation and before destructive effects", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const { action, remoteFs, stateStore, baseline } = await arrangeFreshConflict(ctx, true);
			const rename = vi.spyOn(remoteFs, "rename");
			const deleteTarget = vi.spyOn(remoteFs, "delete");
			ctx.conflictResolver = async (resolverCtx, strategy) => {
				const resolution = await resolveConflict(resolverCtx, strategy);
				await remoteFs.write("old.md", new TextEncoder().encode("new R version").buffer, 3000);
				return resolution;
			};

			const result = await executePlan(makePlan([action]), ctx);

			expect(result.blocked).toHaveLength(1);
			expect(result.failed).toEqual([]);
			expect(rename).not.toHaveBeenCalled();
			expect(deleteTarget).not.toHaveBeenCalled();
			expect(stateStore.records.get("old.md")).toEqual(baseline);
			expect(readText(remoteFs, "old.md")).toBe("new R version");
			expect(readText(remoteFs, "new.conflict.md")).toBe("remote changed");
		});

		it("blocks when destination Y changes after preservation and before deletion", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const { action, remoteFs, stateStore, baseline } = await arrangeFreshConflict(ctx, true);
			const rename = vi.spyOn(remoteFs, "rename");
			const deleteTarget = vi.spyOn(remoteFs, "delete");
			ctx.conflictResolver = async (resolverCtx, strategy) => {
				const resolution = await resolveConflict(resolverCtx, strategy);
				await remoteFs.write("new.md", new TextEncoder().encode("new Z version").buffer, 3000);
				return resolution;
			};

			const result = await executePlan(makePlan([action]), ctx);

			expect(result.blocked).toHaveLength(1);
			expect(result.failed).toEqual([]);
			expect(rename).not.toHaveBeenCalled();
			expect(deleteTarget).not.toHaveBeenCalled();
			expect(stateStore.records.get("old.md")).toEqual(baseline);
			expect(readText(remoteFs, "new.md")).toBe("new Z version");
			expect(readText(remoteFs, "new.conflict-2.md")).toBe("foreign occupant");
		});

		it("does not invent tracked identity authority for a foreign-only target", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
			addFile(localFs, "new.md", "local current", 2000);
			const local = (await localFs.stat("new.md"))!;
			const foreign = addFile(remoteFs, "new.md", "foreign", 1500);
			foreign.identityKey = "Y";
			const baseline: SyncRecord = {
				path: "old.md", hash: "baseline", localMtime: 1000, remoteMtime: 1000,
				localSize: 8, remoteSize: 8, syncedAt: 900,
				remoteIdentityKey: "R",
			};
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			stateStore.records.set("old.md", baseline);
			const action: SyncAction = {
				path: "new.md", action: "conflict", local, remote: (await remoteFs.stat("new.md"))!, baseline,
				publication: { source: baseline, destination: undefined },
			};

			const result = await executePlan(makePlan([action]), ctx);

			expect(result.failed).toEqual([]);
			expect(result.blocked).toEqual([]);
			expect(readText(remoteFs, "new.conflict.md")).toBe("foreign");
			expect(readText(remoteFs, "new.md")).toBe("local current");
			expect(remoteFs.files.get("new.md")?.entity.identityKey).not.toBe("R");
			expect(result.succeeded[0]?.terminalProof).toBeDefined();
		});

		it("converges a vacant target when the tracked remote identity is absent", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
			addFile(localFs, "new.md", "local current", 2000);
			const local = (await localFs.stat("new.md"))!;
			const baseline: SyncRecord = {
				path: "old.md", hash: "baseline", localMtime: 1000, remoteMtime: 1000,
				localSize: 8, remoteSize: 8, remoteIdentityKey: "R", syncedAt: 900,
			};
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			stateStore.records.set("old.md", baseline);
			const action: SyncAction = {
				path: "new.md", action: "conflict", local, baseline,
				publication: { source: baseline, destination: undefined },
			};

			const result = await executePlan(makePlan([action]), ctx);

			expect(result.failed).toEqual([]);
			expect(result.blocked).toEqual([]);
			expect(readText(remoteFs, "new.md")).toBe("local current");
			expect(remoteFs.files.has("old.md")).toBe(false);
			expect(stateStore.records.has("old.md")).toBe(false);
			expect(stateStore.records.has("new.md")).toBe(true);
			expect(result.succeeded[0]?.terminalProof).toBeDefined();
		});

		it.each(["delete", "rename", "local_write", "remote_write", "terminal_read"] as const)(
			"does not commit, retry, or roll back after the %s cut fails",
			async (cut) => {
				const ctx = makeCtx({ conflictStrategy: "duplicate" });
				const { action, localFs, remoteFs, stateStore, baseline } =
					await arrangeFreshConflict(ctx, true);
				const originalLocalWrite = localFs.write.bind(localFs);
				const originalRemoteWrite = remoteFs.write.bind(remoteFs);
				const originalRemoteRead = remoteFs.read.bind(remoteFs);
				const deleteSpy = vi.spyOn(remoteFs, "delete");
				const renameSpy = vi.spyOn(remoteFs, "rename");
				if (cut === "delete") deleteSpy.mockRejectedValue(new Error("delete cut"));
				if (cut === "rename") renameSpy.mockRejectedValue(new Error("rename cut"));
				const localWrite = vi.spyOn(localFs, "write").mockImplementation((path, bytes, mtime) =>
					cut === "local_write" && path === "new.md"
						? Promise.reject(new Error("local write cut"))
						: originalLocalWrite(path, bytes, mtime));
				const remoteWrite = vi.spyOn(remoteFs, "write").mockImplementation((path, bytes, mtime) =>
					cut === "remote_write" && path === "new.md"
						? Promise.reject(new Error("remote write cut"))
						: originalRemoteWrite(path, bytes, mtime));
				const originalStat = remoteFs.stat.bind(remoteFs);
				vi.spyOn(remoteFs, "stat").mockImplementation(async (path) => {
					const entity = await originalStat(path);
					return cut === "terminal_read" && path === "new.md" && entity &&
						remoteWrite.mock.calls.some(([written]) => written === path)
						? { ...entity, hash: "", remoteChecksum: undefined } : entity;
				});
				vi.spyOn(remoteFs, "read").mockImplementation((path) =>
					cut === "terminal_read" && path === "new.md" && remoteWrite.mock.calls.some(([written]) => written === path)
						? Promise.reject(new Error("terminal read cut"))
						: originalRemoteRead(path));

				const result = await executePlan(makePlan([action]), ctx);

				expect(result.failed).toHaveLength(1);
				expect(result.succeeded).toEqual([]);
				expect(stateStore.records.get("old.md")).toEqual(baseline);
				expect(stateStore.records.has("new.md")).toBe(false);
				expect(deleteSpy.mock.calls.filter(([path]) => path === "new.md")).toHaveLength(1);
				expect(renameSpy).toHaveBeenCalledTimes(cut === "delete" ? 0 : 1);
				expect(localWrite.mock.calls.filter(([path]) => path === "new.md").length).toBeLessThanOrEqual(1);
				expect(remoteWrite.mock.calls.filter(([path]) => path === "new.md").length).toBeLessThanOrEqual(1);
				if (cut === "local_write" || cut === "remote_write" || cut === "terminal_read") {
					expect(remoteFs.files.has("old.md")).toBe(false);
				}
			},
		);

		it("fails fast on a resolver invariant contradiction", async () => {
			const fatal = vi.fn();
			const ctx = makeCtx({ conflictStrategy: "duplicate", onActionFatal: fatal });
			const { action } = await arrangeFreshConflict(ctx);
			ctx.conflictResolver = () => Promise.resolve({
				action: "duplicated",
				verifiedOutputs: [{
					role: "primary", path: "new.conflict.md", sourcePath: "old.md",
					sourceEntity: action.remote!, sourceContent: new ArrayBuffer(0),
				}],
			});

			await expect(executePlan(makePlan([action]), ctx)).rejects.toThrow(
				"Fresh resolver omitted target content",
			);
			expect(fatal).toHaveBeenCalledOnce();
		});

		it("publishes and aborts through the existing auth path for typed resolver auth failure", async () => {
			const fatal = vi.fn();
			const ctx = makeCtx({ conflictStrategy: "duplicate", onActionFatal: fatal });
			const { action, stateStore } = await arrangeFreshConflict(ctx);
			const auth = new AuthError("expired", 401);
			ctx.conflictResolver = () => Promise.reject(new ContentProofError(
				"external_auth_failure", "source unreadable", { cause: auth },
			));

			await expect(executePlan(makePlan([action]), ctx)).rejects.toBe(auth);
			expect(fatal).toHaveBeenCalledWith(expect.anything(), auth);
			expect(stateStore.records.has("new.md")).toBe(false);
		});

		it("resolves conflict and records it in both succeeded and conflicts arrays", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
			addFile(localFs, "g.md", "local version");
			addFile(remoteFs, "g.md", "remote version");

			const plan = makePlan([{
				path: "g.md",
				action: "conflict",
				local: (await localFs.stat("g.md"))!,
				remote: (await remoteFs.stat("g.md"))!,
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.conflicts).toHaveLength(1);
			expect(result.succeeded).toHaveLength(1);
			expect(result.failed).toHaveLength(0);
		});

		it("records conflict in failed array when resolveConflict throws a non-Auth error", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
			addFile(localFs, "err.md", "local version");
			addFile(remoteFs, "err.md", "remote version");

			// Fail the first required preservation read. Compound conflicts are not retried.
			vi.spyOn(localFs, "read").mockRejectedValue(new Error("I/O error"));

			const plan = makePlan([{
				path: "err.md",
				action: "conflict",
				local: (await localFs.stat("err.md"))!,
				remote: (await remoteFs.stat("err.md"))!,
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
			const localFs = ctx.localFs as MockFileSystem;
			addFile(localFs, "good.md", "good content");
			addFile(localFs, "missing.md", "unreadable");
			const read = localFs.read.bind(localFs);
			vi.spyOn(localFs, "read").mockImplementation((path) => path === "missing.md"
				? Promise.reject(new Error("read failed")) : read(path));

			const plan = makePlan([
				{
					path: "missing.md",
					action: "push",
					local: (await localFs.stat("missing.md"))!,
				},
				{
					path: "good.md",
					action: "push",
					local: (await localFs.stat("good.md"))!,
				},
			]);

			const result = await executePlan(plan, ctx);

			expect(result.failed).toHaveLength(1);
			expect(result.failed[0]!.action.path).toBe("missing.md");
			expect(result.succeeded).toHaveLength(1);
			expect(result.succeeded[0]!.action.path).toBe("good.md");
		});

		it("waits for scheduled transfer siblings before propagating AuthError", async () => {
			let aborted = false;
			const fatal = vi.fn().mockImplementation(() => { aborted = true; });
			const ctx = makeCtx({
				onActionFatal: fatal,
				beginAction: () => aborted ? "invalidated" : "run",
				transferPool: { min: 1, start: 2, max: 2, rampAfter: 100 },
			});
			const authErr = new AuthError("Unauthorized", 401);
			let releaseSibling!: () => void;
			const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve; });

			const localFs = ctx.localFs as MockFileSystem;
			// Use path-based logic so the correct file triggers AuthError regardless of concurrency order
			for (const path of ["auth-fail.md", "other.md", "queued.md"]) addFile(localFs, path, "");
			const read = vi.spyOn(localFs, "read").mockImplementation((path: string) => {
				if (path === "auth-fail.md") return Promise.reject(authErr);
				return siblingGate.then(() => new ArrayBuffer(0));
			});

			const plan = makePlan([
				{
					path: "auth-fail.md",
					action: "push",
					local: (await localFs.stat("auth-fail.md"))!,
				},
				{
					path: "other.md",
					action: "push",
					local: (await localFs.stat("other.md"))!,
				},
				{
					path: "queued.md",
					action: "push",
					local: (await localFs.stat("queued.md"))!,
				},
			]);

			const execution = executePlan(plan, ctx);
			let rejected = false;
			void execution.catch(() => { rejected = true; });
			await vi.waitFor(() => expect(fatal).toHaveBeenCalledWith(expect.anything(), authErr));
			expect(rejected).toBe(false);

			releaseSibling();
			await expect(execution).rejects.toBe(authErr);
			expect(read).not.toHaveBeenCalledWith("queued.md");
		});

		it("preserves the first structural rejection across nested sibling settlement", async () => {
			const ctx = makeCtx();
			const remoteFs = ctx.remoteFs as MockFileSystem;
			const localFs = ctx.localFs as MockFileSystem;
			addFile(remoteFs, "first.md", "first");
			addFile(remoteFs, "slow.md", "slow");
			addFile(localFs, "second.md", "second");
			const first = new AuthError("first", 401);
			const second = new AuthError("second", 401);
			let signalFirst!: () => void;
			const firstObserved = new Promise<void>((resolve) => { signalFirst = resolve; });
			let releaseSlow!: () => void;
			const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
			const remoteDelete = remoteFs.delete.bind(remoteFs);
			vi.spyOn(remoteFs, "delete").mockImplementation((path) => {
				if (path === "first.md") {
					signalFirst();
					return Promise.reject(first);
				}
				return slow.then(() => remoteDelete(path));
			});
			vi.spyOn(localFs, "delete").mockImplementation(() =>
				firstObserved.then(() => Promise.reject(second)));

			const execution = executePlan(makePlan([
				{ path: "first.md", action: "delete_remote", remote: (await remoteFs.stat("first.md"))! },
				{ path: "slow.md", action: "delete_remote", remote: (await remoteFs.stat("slow.md"))! },
				{ path: "second.md", action: "delete_local", local: (await localFs.stat("second.md"))! },
			]), ctx);
			await firstObserved;
			await Promise.resolve();
			releaseSlow();

			await expect(execution).rejects.toBe(first);
		});

		it("aborts the cycle on AuthError during a remote delete (structural phase)", async () => {
			const ctx = makeCtx();
			const authErr = new AuthError("Unauthorized", 401);
			const remoteFs = ctx.remoteFs as MockFileSystem;
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
				{ path: "del1.md", action: "delete_remote", remote: (await remoteFs.stat("del1.md"))! },
				{ path: "del2.md", action: "delete_remote", remote: (await remoteFs.stat("del2.md"))! },
			]);

			await expect(executePlan(plan, ctx)).rejects.toThrow(AuthError);
		});

		it("aborts the cycle on AuthError during a local delete (structural phase)", async () => {
			const ctx = makeCtx();
			const authErr = new AuthError("Unauthorized", 401);
			const localFs = ctx.localFs as MockFileSystem;
			addFile(localFs, "del1.md", "content");
			addFile(localFs, "del2.md", "content");
			const origDelete = localFs.delete.bind(localFs);
			vi.spyOn(localFs, "delete").mockImplementation((path: string) => {
				if (path === "del1.md") return Promise.reject(authErr);
				return origDelete(path);
			});

			const plan = makePlan([
				{ path: "del1.md", action: "delete_local", local: (await localFs.stat("del1.md"))! },
				{ path: "del2.md", action: "delete_local", local: (await localFs.stat("del2.md"))! },
			]);

			await expect(executePlan(plan, ctx)).rejects.toThrow(AuthError);
		});

		it("aborts the cycle on AuthError during a conflict (conflict phase)", async () => {
			const order: string[] = [];
			const ctx = makeCtx({
				acquireActionPermit: () => Promise.resolve({ release: () => { order.push("release"); } }),
				onActionFatal: () => { order.push("fatal-published"); },
			});
			const authErr = new AuthError("Unauthorized", 401);
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
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
			expect(order).toEqual(["fatal-published", "release"]);
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

			addFile(ctx.localFs as MockFileSystem, "no-such-file.md", "unreadable");
			const local = (await ctx.localFs.stat("no-such-file.md"))!;
			vi.spyOn(ctx.localFs, "read").mockRejectedValue(new Error("read failed"));
			const plan = makePlan([{
				path: "no-such-file.md",
				action: "push",
				local,
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.failed).toHaveLength(1);
			expect(errorSpy).toHaveBeenCalled();
		});
	});

	describe("phase scheduling", () => {
		it("drains running priority before a component and excludes queued priority from its prefix", async () => {
			const coordinator = new PriorityCoordinator();
			const gate = deferred();
			const order: string[] = [];
			const prior = coordinator.enqueue("prior", async () => {
				await gate.promise;
				order.push("prior");
			});
			const ctx = makeCtx({ acquireActionPermit: () => coordinator.acquireNormalPermit() });
			const { action } = await arrangeFreshRename(ctx);
			const rename = ctx.remoteFs.rename.bind(ctx.remoteFs);
			let late: Promise<void> | undefined;
			vi.spyOn(ctx.remoteFs, "rename").mockImplementation(async (from, to) => {
				order.push("rename");
				late = coordinator.enqueue("late", () => {
					order.push("late");
					return Promise.resolve();
				});
				await rename(from, to);
			});
			ctx.beginAction = (action) => {
				if (action.action === "cleanup") order.push("cleanup");
				return "run";
			};
			const run = executePlan(makePlan([
				action,
				{ action: "cleanup", path: "old.md" },
			], true), ctx);
			await flush();
			expect(order).toEqual([]);
			gate.resolve();
			await prior;
			const result = await run;
			await late;
			expect(result.failed).toEqual([]);
			expect(order).toEqual(["prior", "rename", "cleanup", "late"]);
		});

		it("preserves an admitted component prefix through publication before cleanup", async () => {
			const ctx = makeCtx();
			const { action, stateStore } = await arrangeFreshRename(ctx);
			const order: string[] = [];
			ctx.beginAction = (action) => {
				if (action.action === "cleanup") {
					expect(stateStore.records.has("new.md")).toBe(true);
					expect(stateStore.records.has("old.md")).toBe(false);
				}
				order.push(action.action); return "run";
			};
			const plan = makePlan([
				action,
				{ action: "cleanup", path: "old.md" },
			], true);
			const result = await executePlan(plan, ctx);
			expect(result.failed).toEqual([]);
			expect(order).toEqual(["rename_remote", "cleanup"]);
		});

		it("does not start a component suffix after prefix failure", async () => {
			const ctx = makeCtx();
			const { action, remoteFs } = await arrangeFreshRename(ctx);
			vi.spyOn(remoteFs, "write").mockRejectedValue(new Error("prefix write failed"));
			const begin = vi.fn(() => "run" as const);
			ctx.beginAction = begin;
			const plan = makePlan([
				action,
				{ action: "cleanup", path: "missing.md" },
			], true);
			const result = await executePlan(plan, ctx);
			expect(result.failed).toHaveLength(1);
			expect(begin).toHaveBeenCalledTimes(1);
			expect(result.blocked.map((item) => item.action.action)).toEqual(["cleanup"]);
		});

		it("settles independent transfers before serial work in admitted component order", async () => {
			const order: string[] = [];
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;

			addFile(localFs, "push.md", "push");
			addFile(localFs, "conflict.md", "local");
			addFile(remoteFs, "conflict.md", "remote");
			addFile(remoteFs, "rr-old.md", "rr"); // rename_remote source (remote lane)
			addFile(localFs, "rr-new.md", "rr");
			addFile(remoteFs, "dr.md", "dr");      // delete_remote (remote lane)
			addFile(localFs, "rl-old.md", "rl");   // rename_local source (local lane)
			addFile(remoteFs, "rl-new.md", "rl");
			addFile(localFs, "dl.md", "dl");       // delete_local (local lane)
			await stateStore.put(buildSyncRecord((await localFs.stat("rr-new.md"))!, (await remoteFs.stat("rr-old.md"))!, "rr-old.md"));
			await stateStore.put(buildSyncRecord((await localFs.stat("rl-old.md"))!, (await remoteFs.stat("rl-new.md"))!, "rl-old.md"));

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
				{ path: "push.md", action: "push", local: (await localFs.stat("push.md"))! },
				{
					path: "conflict.md",
					action: "conflict",
					local: (await localFs.stat("conflict.md"))!, remote: (await remoteFs.stat("conflict.md"))!,
				},
				{
					path: "rr-new.md", action: "rename_remote", oldPath: "rr-old.md",
					local: (await localFs.stat("rr-new.md"))!, remote: (await remoteFs.stat("rr-old.md"))!,
					content: { mode: "equal" },
					baseline: stateStore.records.get("rr-old.md"),
				},
				{ path: "dr.md", action: "delete_remote", remote: (await remoteFs.stat("dr.md"))! },
				{
					path: "rl-new.md", action: "rename_local", oldPath: "rl-old.md",
					remote: (await remoteFs.stat("rl-new.md"))!, local: (await localFs.stat("rl-old.md"))!,
					content: { mode: "equal" },
					baseline: stateStore.records.get("rl-old.md"),
				},
				{ path: "dl.md", action: "delete_local", local: (await localFs.stat("dl.md"))! },
			]);

			const started: string[] = [];
			ctx.beginAction = (action) => { started.push(action.path); return "run"; };
			const result = await executePlan(plan, ctx);
			expect(result.succeeded).toHaveLength(6);
			expect(result.failed).toEqual([]);
			expect(result.blocked).toEqual([]);
			expect(order[0]).toBe("push");
			expect(started).toEqual(["push.md", ...plan.components
				.filter((component) => !component.paths.includes("push.md"))
				.flatMap((component) => component.actions.map((action) => action.path))]);
		});

		it("does not start structural ops until transfers finish (Phase 1 barrier)", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
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
				{ path: "d.md", action: "delete_remote", remote: (await remoteFs.stat("d.md"))! },
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
		it("serializes remote and local structural components across both filesystems", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
			addFile(remoteFs, "r.md", "x");
			addFile(localFs, "l.md", "y");

			let running = 0;
			let maxRunning = 0;
			const gate = deferred();
			const started = deferred();
			const gateDelete = (fs: MockFileSystem) => {
				const orig = fs.delete.bind(fs);
				vi.spyOn(fs, "delete").mockImplementation(async (path: string) => {
					running++;
					maxRunning = Math.max(maxRunning, running);
					started.resolve();
					await gate.promise;
					running--;
					return orig(path);
				});
			};
			gateDelete(remoteFs);
			gateDelete(localFs);

			const plan = makePlan([
				{ path: "r.md", action: "delete_remote", remote: (await remoteFs.stat("r.md"))! },
				{ path: "l.md", action: "delete_local", local: (await localFs.stat("l.md"))! },
			]);

			const p = executePlan(plan, ctx);
			await started.promise;
			expect(running).toBe(1);
			gate.resolve();
			await p;
			expect(maxRunning).toBe(1);
		});

		it("executes structural deletes one at a time", async () => {
			const ctx = makeCtx();
			const remoteFs = ctx.remoteFs as MockFileSystem;
			const paths = Array.from({ length: 6 }, (_, k) => `del${k}.md`);
			for (const path of paths) addFile(remoteFs, path, "x");

			let running = 0;
			let maxRunning = 0;
			const gate = deferred();
			const started = deferred();
			const orig = remoteFs.delete.bind(remoteFs);
			vi.spyOn(remoteFs, "delete").mockImplementation(async (path: string) => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				started.resolve();
				await gate.promise;
				running--;
				return orig(path);
			});

			const plan = makePlan(await Promise.all(paths.map(async (path) => ({
				path, action: "delete_remote" as const, remote: (await remoteFs.stat(path))!,
			}))));

			const p = executePlan(plan, ctx);
			await started.promise;
			expect(running).toBe(1);
			gate.resolve();
			await p;
			expect(maxRunning).toBe(1);
		});
	});

	describe("concurrent delete safety", () => {
		it("deletes the child before its parent within an ordered component", async () => {
			const ctx = makeCtx();
			const remoteFs = ctx.remoteFs as MockFileSystem;
			addFile(remoteFs, "A/child.md", "x"); // seeds folder A + the child

			// Shared topology is ordered explicitly, never submitted to the singleton pool.
			const plan = makePlan([
				{ path: "A/child.md", action: "delete_remote", remote: (await remoteFs.stat("A/child.md"))! },
				{ path: "A", action: "delete_remote", remote: (await remoteFs.stat("A"))! },
			], true);

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
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
			// A genuine conflict on foo.md (both sides, different content).
			addFile(localFs, "foo.md", "local-foo");
			addFile(remoteFs, "foo.md", "remote-foo");
			// A user file literally named foo.conflict.md, pushed in the SAME plan.
			addFile(localFs, "foo.conflict.md", "USER SIDECAR");

			const plan = makePlan([
				{ path: "foo.conflict.md", action: "push", local: (await localFs.stat("foo.conflict.md"))! },
				{
					path: "foo.md", action: "conflict",
					local: (await localFs.stat("foo.md"))!,
					remote: (await remoteFs.stat("foo.md"))!,
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
		it("reports progress once per successful action across pooled and serial components", async () => {
			const calls: Array<[number, number]> = [];
			const ctx = makeCtx({
				conflictStrategy: "duplicate",
				onProgress: (completed, total) => calls.push([completed, total]),
			});
			const localFs = ctx.localFs as MockFileSystem;
			const remoteFs = ctx.remoteFs as MockFileSystem;
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			addFile(localFs, "p.md", "p");
			addFile(localFs, "m.md", "m");
			addFile(remoteFs, "m.md", "m");
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
				{ path: "p.md", action: "push", local: (await localFs.stat("p.md"))! },
				{
					path: "m.md", action: "match",
					local: (await localFs.stat("m.md"))!, remote: (await remoteFs.stat("m.md"))!,
				},
				{
					path: "cf.md", action: "conflict",
					local: (await localFs.stat("cf.md"))!, remote: (await remoteFs.stat("cf.md"))!,
				},
				{ path: "dr.md", action: "delete_remote", remote: (await remoteFs.stat("dr.md"))!, baseline: await stateStore.get("dr.md") },
				{ path: "dl.md", action: "delete_local", local: (await localFs.stat("dl.md"))!, baseline: await stateStore.get("dl.md") },
			]);

			const result = await executePlan(plan, ctx);
			expect(result.succeeded).toHaveLength(5);
			expect(result.failed).toEqual([]);
			expect(result.blocked).toEqual([]);
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
	const pushPlan = (path = "x.md"): AuthorizedSyncPlan =>
		makePlan([{ path, action: "push", local: { path, isDirectory: false, size: 7, mtime: 1000, hash: "" } }]);

	it("retries a rate-limited (429) transfer, then succeeds", async () => {
		const ctx = makeCtx();
		const localFs = ctx.localFs as MockFileSystem;
		const remoteFs = ctx.remoteFs as MockFileSystem;
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
		const localFs = ctx.localFs as MockFileSystem;
		const remoteFs = ctx.remoteFs as MockFileSystem;
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
		const localFs = ctx.localFs as MockFileSystem;
		const remoteFs = ctx.remoteFs as MockFileSystem;
		addFile(localFs, "x.md", "content");
		const writeSpy = vi.spyOn(remoteFs, "write").mockRejectedValue(httpErr(403));

		const result = await executePlan(pushPlan(), ctx); // resolves (no abort)

		expect(result.failed).toHaveLength(1);
		expect(result.succeeded).toHaveLength(0);
		expect(writeSpy).toHaveBeenCalledTimes(1); // not retried
	});

	it("does NOT retry a notFound (404) error", async () => {
		const ctx = makeCtx();
		const localFs = ctx.localFs as MockFileSystem;
		const remoteFs = ctx.remoteFs as MockFileSystem;
		addFile(localFs, "x.md", "content");
		const writeSpy = vi.spyOn(remoteFs, "write").mockRejectedValue(httpErr(404));

		const result = await executePlan(pushPlan(), ctx);

		expect(result.failed).toHaveLength(1);
		expect(writeSpy).toHaveBeenCalledTimes(1);
	});

	it("aborts (no retry) on AuthError", async () => {
		const ctx = makeCtx();
		const localFs = ctx.localFs as MockFileSystem;
		const remoteFs = ctx.remoteFs as MockFileSystem;
		addFile(localFs, "x.md", "content");
		const writeSpy = vi.spyOn(remoteFs, "write").mockRejectedValue(new AuthError("unauthorized", 401));

		await expect(executePlan(pushPlan(), ctx)).rejects.toThrow(AuthError);
		expect(writeSpy).toHaveBeenCalledTimes(1); // AuthError is rethrown immediately
	});

	it("gives up after MAX_ACTION_RETRIES (3) → failed, without a cycle abort", async () => {
		const ctx = makeCtx();
		const localFs = ctx.localFs as MockFileSystem;
		const remoteFs = ctx.remoteFs as MockFileSystem;
		addFile(localFs, "x.md", "content");
		const writeSpy = vi.spyOn(remoteFs, "write").mockRejectedValue(httpErr(429));

		const result = await executePlan(pushPlan(), ctx); // resolves (no throw → no cycle retry)

		expect(writeSpy).toHaveBeenCalledTimes(3);
		expect(result.failed).toHaveLength(1);
	});

	it("uses ctx.classifyError (Google 403 = rate-limit), so a 403 retries", async () => {
		const ctx = makeCtx({ classifyError: () => ({ kind: "rateLimit", retryAfterMs: 1 }) });
		const localFs = ctx.localFs as MockFileSystem;
		const remoteFs = ctx.remoteFs as MockFileSystem;
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
		const localFs = ctx.localFs as MockFileSystem;
		const remoteFs = ctx.remoteFs as MockFileSystem;
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
		const localFs = ctx.localFs as MockFileSystem;
		const remoteFs = ctx.remoteFs as MockFileSystem;
		addFile(localFs, "g.md", "local version");
		addFile(remoteFs, "g.md", "remote version");
		const readSpy = vi.spyOn(remoteFs, "read").mockRejectedValue(httpErr(429));

		const result = await executePlan(makePlan([{
			path: "g.md",
			action: "conflict",
			local: (await localFs.stat("g.md"))!,
			remote: (await remoteFs.stat("g.md"))!,
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
		const { action, remoteFs } = await arrangeFreshRename(ctx);
		const renameSpy = vi.spyOn(remoteFs, "rename").mockRejectedValue(httpErr(429));

		const result = await executePlan(makePlan([action]), ctx);

		// rename tier is excluded from withIoRetry: re-running rename(oldPath, …) would hit a
		// source the first (successful) attempt already moved → a spurious failure.
		expect(result.failed).toHaveLength(1);
		expect(renameSpy).toHaveBeenCalledTimes(1);
	});
});

describe("adaptive transfer pool (Phase 1)", () => {
	function gatedWrites(remoteFs: MockFileSystem) {
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

	async function manyPushes(n: number, ctx: ExecutionContext, size = 7): Promise<AuthorizedSyncPlan> {
		const localFs = ctx.localFs as MockFileSystem;
		const actions: SyncAction[] = [];
		for (let i = 0; i < n; i++) {
			addFile(localFs, `f${i}.md`, "x".repeat(size));
			actions.push({ path: `f${i}.md`, action: "push", local: (await localFs.stat(`f${i}.md`))! });
		}
		return makePlan(actions);
	}

	it("starts transfers at the desktop pool's start concurrency (5)", async () => {
		const ctx = makeCtx(); // DESKTOP_TRANSFER_POOL (start 5)
		const remoteFs = ctx.remoteFs as MockFileSystem;
		const { gate, counter } = gatedWrites(remoteFs);

		const p = executePlan(await manyPushes(8, ctx), ctx);
		await vi.waitFor(() => expect(counter.max).toBe(5));
		gate.resolve();
		await p;
	});

	it("caps mobile transfers at the mobile pool's start concurrency (3)", async () => {
		const ctx = makeCtx({ transferPool: MOBILE_TRANSFER_POOL });
		const remoteFs = ctx.remoteFs as MockFileSystem;
		const { gate, counter } = gatedWrites(remoteFs);

		const p = executePlan(await manyPushes(8, ctx), ctx);
		await vi.waitFor(() => expect(counter.max).toBe(3));
		gate.resolve();
		await p;
	});

	it("byte-bounds transfers below the count ceiling when files are large", async () => {
		// Count would allow 10 at once, but a 30-byte budget admits only 3 of the 10-byte files.
		const ctx = makeCtx({
			transferPool: { min: 1, start: 10, max: 10, rampAfter: 100, byteBudget: 30 },
		});
		const remoteFs = ctx.remoteFs as MockFileSystem;
		const { gate, counter } = gatedWrites(remoteFs);

		const p = executePlan(await manyPushes(8, ctx, 10), ctx);
		await vi.waitFor(() => expect(counter.max).toBe(3));
		gate.resolve();
		await p;
	});

	it("lets small files reach the count ceiling under a generous byte budget", async () => {
		const ctx = makeCtx({
			transferPool: { min: 1, start: 4, max: 4, rampAfter: 100, byteBudget: 48 * 1024 * 1024 },
		});
		const remoteFs = ctx.remoteFs as MockFileSystem;
		const { gate, counter } = gatedWrites(remoteFs);

		const p = executePlan(await manyPushes(8, ctx, 7), ctx);
		await vi.waitFor(() => expect(counter.max).toBe(4));
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
