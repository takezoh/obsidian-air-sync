import { describe, it, expect, vi } from "vitest";
import { collectChanges } from "./change-detector";
import { executePlan } from "./plan-executor";
import { LocalChangeTracker } from "./local-tracker";
import {
	confirmMockPath, createMockLocalFs, createMockRemoteFs, type MockFileSystem,
	createMockStateStore,
	addFile,
	readText,
} from "../__mocks__/sync-test-helpers";
import type { RenamePair, SyncPlan } from "./types";
import { admitBatchObservation } from "./plan-admission";
import { projectScope } from "./scope-projection";
import { captureBatchObservation, prepareSyncCycleSnapshot } from "./sync-cycle-planning";
import { finalizeSyncCycle } from "./sync-cycle-finalization";
import { insertConflictSuffix } from "./conflict";

/**
 * Convergence (fixed-point) contract — the emergent property the whole engine
 * rests on (ARCHITECTURE.md design principles #4 "pipeline as data" and #5
 * "crash-safe by construction: an interrupted sync converges by re-syncing").
 *
 * Every unit test below the orchestrator pins ONE stage in isolation. None of
 * them prove the stages *compose* into a stable system: that after a successful
 * sync, an immediate re-sync plans ZERO actions. A baseline-commit that drops a
 * field, an mtime/hash sentinel mishandled, or a checksum that fails to round-
 * trip all pass the per-stage tests yet cause an infinite re-sync loop here.
 *
 * Each test drives the real pipeline composition — the core of
 * `SyncOrchestrator.executeSyncOnce()`:
 *   collectChanges → BatchObservation → PlanAdmission → executePlan (+ per-action commit)
 * — then runs it a SECOND time and asserts the plan is empty (the fixed point).
 */

interface Env {
	localFs: MockFileSystem;
	remoteFs: MockFileSystem;
	stateStore: ReturnType<typeof createMockStateStore>;
	localTracker: LocalChangeTracker;
}

function makeEnv(): Env {
	return {
		localFs: createMockLocalFs(),
		remoteFs: createMockRemoteFs("actual_resolved"),
		stateStore: createMockStateStore(),
		localTracker: new LocalChangeTracker(),
	};
}

/**
 * Run one full sync cycle and return the plan that was executed.
 *
 * This mirrors the core of `SyncOrchestrator.executeSyncOnce()`. It deliberately
 * omits the orchestrator's pre-planSync filters (ignore patterns, mobile max
 * size) since the convergence scenarios use neither; if those filters ever start
 * affecting convergence, drive `SyncOrchestrator.runSync()` here instead.
 */
async function runCycle(env: Env): Promise<SyncPlan> {
	const { localFs, remoteFs, stateStore, localTracker } = env;
	// Mirror the orchestrator: capture one snapshot at cycle start and use it for
	// both detection and the end-of-cycle acknowledge.
	const snapshot = localTracker.snapshot();
	const changeSet = await collectChanges({
		localFs,
		remoteFs,
		stateStore,
		changes: snapshot,
	});
	const scope = projectScope(changeSet);
	const admission = admitBatchObservation(captureBatchObservation(
		changeSet.entries, changeSet.identityEvidence, changeSet.observations, scope, "convergence-test",
		undefined, changeSet.candidateFacts,
	));
	expect(admission.failures).toEqual([]);
	const result = await executePlan(admission.executable, {
		localFs,
		remoteFs,
		committer: { stateStore },
		conflictStrategy: "auto_merge",
	});
	expect(result.failed).toEqual([]);
	expect(result.blocked).toEqual([]);
	const completion = await finalizeSyncCycle({ admission, result, checkpoint: remoteFs.checkpoint, scopeFingerprint: "convergence-test" });
	expect(completion.kind).toBe("clean");
	// Acknowledging the snapshot also flips the tracker into its "initialized"
	// state for the next cycle.
	localTracker.acknowledge(snapshot);
	return { actions: [...admission.executable.actions] };
}

function actionTypes(plan: SyncPlan): string[] {
	return plan.actions.map((a) => a.action).sort();
}

describe("sync converges to a fixed point", () => {
	it("local-only files push, then a re-sync plans nothing", async () => {
		const env = makeEnv();
		addFile(env.localFs, "a.md", "alpha", 1000);
		addFile(env.localFs, "dir/b.md", "beta", 1000);

		const first = await runCycle(env);
		expect(actionTypes(first)).toEqual(["push", "push"]);
		// Content propagated and baselines recorded.
		expect(readText(env.remoteFs, "a.md")).toBe("alpha");
		expect(readText(env.remoteFs, "dir/b.md")).toBe("beta");
		expect(await env.stateStore.get("a.md")).toBeDefined();
		expect(await env.stateStore.get("dir/b.md")).toBeDefined();

		const second = await runCycle(env);
		expect(second.actions).toHaveLength(0);
	});

	it("remote-only files pull, then a re-sync plans nothing", async () => {
		const env = makeEnv();
		addFile(env.remoteFs, "r.md", "remote body", 2000);

		const first = await runCycle(env);
		expect(actionTypes(first)).toEqual(["pull"]);
		expect(readText(env.localFs, "r.md")).toBe("remote body");
		expect(await env.stateStore.get("r.md")).toBeDefined();

		const second = await runCycle(env);
		expect(second.actions).toHaveLength(0);
	});

	it("a bidirectional first sync converges: both sides identical, re-sync plans nothing", async () => {
		const env = makeEnv();
		addFile(env.localFs, "local-only.md", "L", 1000);
		addFile(env.remoteFs, "remote-only.md", "R", 2000);

		const first = await runCycle(env);
		expect(actionTypes(first)).toEqual(["pull", "push"]);

		const second = await runCycle(env);
		expect(second.actions).toHaveLength(0);

		// Both stores hold both files with matching content.
		for (const fs of [env.localFs, env.remoteFs]) {
			expect(readText(fs, "local-only.md")).toBe("L");
			expect(readText(fs, "remote-only.md")).toBe("R");
		}
	});

	it("retries publication-only cover children after candidate writes outlive a record CAS failure", async () => {
		const env = makeEnv();
		addFile(env.localFs, "case.md", "local", 1000);
		const remoteSeed = addFile(env.remoteFs, "Case.md", "remote", 1000);
		remoteSeed.identityKey = "R";
		const local = (await env.localFs.stat("case.md"))!;
		const remote = (await env.remoteFs.stat("Case.md"))!;
		const candidatePaths = [local, remote].map((entity) => insertConflictSuffix("Case.md", entity.hash));
		const exactLocalStat = env.localFs.stat.bind(env.localFs);
		env.localFs.stat = async (path) => path === "Case.md"
			? { ...(await exactLocalStat("case.md"))!, path: "case.md", pathAuthority: "actual_resolved" }
			: exactLocalStat(path);
		const executeCold = async () => {
			const changes = await collectChanges({
				localFs: env.localFs, remoteFs: env.remoteFs, stateStore: env.stateStore,
				changes: env.localTracker.snapshot(),
			}, { forceFullScan: true });
			const { snapshot } = prepareSyncCycleSnapshot(
				changes, "publication-retry", { ignorePatterns: [] },
			);
			const admission = admitBatchObservation(snapshot);
			expect(admission.failures).toEqual([]);
			const result = await executePlan(admission.executable, {
				committer: { stateStore: env.stateStore },
				localFs: env.localFs, remoteFs: env.remoteFs, conflictStrategy: "auto_merge",
			});
			return { admission, result };
		};
		const compareAndPut = env.stateStore.compareAndPut.bind(env.stateStore);
		let rejectedPath: string | undefined;
		const compareSpy = vi.spyOn(env.stateStore, "compareAndPut").mockImplementation((expected, record) => {
			if (!rejectedPath && candidatePaths.includes(record.path)) {
				rejectedPath = record.path;
				return Promise.resolve(false);
			}
			return compareAndPut(expected, record);
		});

		const first = await executeCold();
		expect(first.result.failed).toHaveLength(1);
		expect(rejectedPath).toBeDefined();
		expect(env.localFs.files.has(rejectedPath!)).toBe(true);
		expect(env.remoteFs.files.has(rejectedPath!)).toBe(true);
		compareSpy.mockRestore();

		const second = await executeCold();
		const children = second.admission.executable.actions.flatMap((action) =>
			action.protocol?.kind === "preservation_cover" ? action.protocol.children : []);
		expect(children).toContainEqual(expect.objectContaining({
			candidatePath: rejectedPath, missingSides: [],
		}));
		expect(second.result.failed).toEqual([]);
		expect(second.result.blocked).toEqual([]);
		for (const path of candidatePaths) expect(await env.stateStore.get(path)).toBeDefined();
	});

	it("rejects requested-echo preservation terminals before publication and checkpoint commit", async () => {
		const env = makeEnv();
		env.remoteFs = createMockRemoteFs();
		addFile(env.localFs, "case.md", "local", 1000);
		addFile(env.remoteFs, "Case.md", "remote", 1000).identityKey = "R";
		const exactLocalStat = env.localFs.stat.bind(env.localFs);
		env.localFs.stat = async (path) => path === "Case.md"
			? { ...(await exactLocalStat("case.md"))!, path: "case.md", pathAuthority: "actual_resolved" }
			: exactLocalStat(path);
		const changes = await collectChanges({
			localFs: env.localFs, remoteFs: env.remoteFs, stateStore: env.stateStore,
			changes: env.localTracker.snapshot(),
		}, { forceFullScan: true });
		const { snapshot } = prepareSyncCycleSnapshot(changes, "requested-echo", { ignorePatterns: [] });
		const admission = admitBatchObservation(snapshot);
		expect(admission.failures).toEqual([]);
		const result = await executePlan(admission.executable, {
			committer: { stateStore: env.stateStore },
			localFs: env.localFs, remoteFs: env.remoteFs, conflictStrategy: "auto_merge",
		});
		const commit = vi.spyOn(env.remoteFs.checkpoint!, "commitCheckpoint");
		const abort = vi.spyOn(env.remoteFs.checkpoint!, "abortWorkingView");

		const completion = await finalizeSyncCycle({
			admission, result, checkpoint: env.remoteFs.checkpoint, scopeFingerprint: "requested-echo",
		});

		expect(result.failed).toEqual([]);
		expect(result.blocked).toHaveLength(1);
		expect(await env.stateStore.get(admission.executable.actions[0]?.protocol?.kind === "preservation_cover"
			? admission.executable.actions[0].protocol.children[0]!.candidatePath : "missing")).toBeUndefined();
		expect(completion).toEqual({ kind: "incomplete" });
		expect(commit).not.toHaveBeenCalled();
		expect(abort).toHaveBeenCalledOnce();
	});

	it("reacquires a completed cover when another true new file is dirty", async () => {
		const env = makeEnv();
		addFile(env.localFs, "case.md", "local", 1000);
		addFile(env.remoteFs, "Case.md", "remote", 1000).identityKey = "R";
		const exactLocalStat = env.localFs.stat.bind(env.localFs);
		env.localFs.stat = async (path) => path === "Case.md"
			? { ...(await exactLocalStat("case.md"))!, path: "case.md", pathAuthority: "actual_resolved" }
			: exactLocalStat(path);

		const initial = await runCycle(env);
		expect(initial.actions.some((action) => action.protocol?.kind === "preservation_cover")).toBe(true);

		addFile(env.localFs, "new.md", "new", 2000);
		env.localTracker.markDirty("case.md");
		env.localTracker.markDirty("new.md");
		const delta = vi.spyOn(env.remoteFs.checkpoint!, "getChangedPaths");

		const retry = await runCycle(env);

		expect(retry.actions).toMatchObject([{ action: "push", path: "new.md" }]);
		expect(delta).toHaveBeenCalledOnce();
		expect(env.remoteFs.files.has("case.md")).toBe(false);
		expect(readText(env.remoteFs, "new.md")).toBe("new");
	});

	it("retains a same-metadata tracked edit when an untracked file promotes HOT to WARM", async () => {
		const env = makeEnv();
		addFile(env.localFs, "edited.md", "old!", 1000);
		expect(actionTypes(await runCycle(env))).toEqual(["push"]);

		addFile(env.localFs, "edited.md", "new!", 1000);
		addFile(env.localFs, "new.md", "new", 2000);
		env.localTracker.markDirty("edited.md");
		env.localTracker.markDirty("new.md");

		const promoted = await runCycle(env);

		expect(promoted.actions).toMatchObject([
			{ action: "push", path: "edited.md" },
			{ action: "push", path: "new.md" },
		]);
		expect(readText(env.remoteFs, "edited.md")).toBe("new!");
		expect((await runCycle(env)).actions).toEqual([]);
	});

	it("reacquires a completed three-version cover from one dirty exact path", async () => {
		const env = makeEnv();
		addFile(env.localFs, "case.md", "local-a", 1000);
		addFile(env.remoteFs, "Case.md", "remote-b", 1000).identityKey = "B";
		addFile(env.remoteFs, "case.md", "remote-c", 1000).identityKey = "C";
		const exactLocalStat = env.localFs.stat.bind(env.localFs);
		env.localFs.stat = async (path) => path === "Case.md"
			? { ...(await exactLocalStat("case.md"))!, path: "case.md", pathAuthority: "actual_resolved" }
			: exactLocalStat(path);

		const initial = await runCycle(env);
		const cover = initial.actions.find((action) => action.protocol?.kind === "preservation_cover");
		expect(cover?.protocol?.kind === "preservation_cover" ? cover.protocol.children : []).toHaveLength(3);
		env.localTracker.markDirty("case.md");

		const retry = await runCycle(env);

		expect(retry.actions).toEqual([]);
		expect(readText(env.remoteFs, "case.md")).toBe("remote-c");
		expect(env.localFs.files.has("case.conflict.md")).toBe(false);
	});

	it("retains a three-version cover prefix and retries only the missing version", async () => {
		const env = makeEnv();
		addFile(env.localFs, "case.md", "local-a", 1000);
		addFile(env.remoteFs, "Case.md", "remote-b", 1000).identityKey = "B";
		addFile(env.remoteFs, "case.md", "remote-c", 1000).identityKey = "C";
		const exactLocalStat = env.localFs.stat.bind(env.localFs);
		env.localFs.stat = async (path) => path === "Case.md"
			? { ...(await exactLocalStat("case.md"))!, path: "case.md", pathAuthority: "actual_resolved" }
			: exactLocalStat(path);
		const runCold = async () => {
			const changes = await collectChanges({
				localFs: env.localFs, remoteFs: env.remoteFs, stateStore: env.stateStore,
				changes: env.localTracker.snapshot(),
			}, { forceFullScan: true });
			const { snapshot } = prepareSyncCycleSnapshot(changes, "three-version-partial", { ignorePatterns: [] });
			const admission = admitBatchObservation(snapshot);
			const result = await executePlan(admission.executable, {
				localFs: env.localFs, remoteFs: env.remoteFs,
				committer: { stateStore: env.stateStore }, conflictStrategy: "auto_merge",
			});
			return { admission, result };
		};
		const remoteWrite = env.remoteFs.write.bind(env.remoteFs);
		const firstWrites: string[] = [];
		vi.spyOn(env.remoteFs, "write").mockImplementation((path, content, mtime) => {
			firstWrites.push(path);
			return firstWrites.length === 3
				? Promise.reject(new Error("third child failed"))
				: remoteWrite(path, content, mtime);
		});
		const commitCheckpoint = vi.spyOn(env.remoteFs.checkpoint!, "commitCheckpoint");
		const abortWorkingView = vi.spyOn(env.remoteFs.checkpoint!, "abortWorkingView");

		const first = await runCold();
		const candidatePaths = first.admission.executable.actions.flatMap((action) =>
			action.protocol?.kind === "preservation_cover"
				? action.protocol.children.map((child) => child.candidatePath) : []);
		const missingCandidate = firstWrites[2]!;
		expect(first.admission.failures).toEqual([]);
		expect(first.result.failed).toHaveLength(1);
		expect(first.result.conflicts[0]?.resolution.duplicatePaths).toEqual(firstWrites.slice(0, 2));
		expect((await finalizeSyncCycle({
			admission: first.admission, result: first.result,
			checkpoint: env.remoteFs.checkpoint, scopeFingerprint: "three-version-partial",
		})).kind).toBe("incomplete");
		expect(commitCheckpoint).not.toHaveBeenCalled();
		expect(abortWorkingView).toHaveBeenCalledOnce();
		expect(firstWrites).toContain(missingCandidate);

		vi.restoreAllMocks();
		const secondWrites: string[] = [];
		vi.spyOn(env.remoteFs, "write").mockImplementation((path, content, mtime) => {
			secondWrites.push(path);
			return remoteWrite(path, content, mtime);
		});
		const second = await runCold();
		expect(second.admission.failures).toEqual([]);
		expect(second.result.failed).toEqual([]);
		expect(second.result.blocked).toEqual([]);
		expect(secondWrites).toEqual([missingCandidate]);
		expect(second.result.conflicts[0]?.resolution.duplicatePaths).toEqual(candidatePaths);

		vi.restoreAllMocks();
		const third = await runCold();
		expect(third.admission.failures).toEqual([]);
		expect(third.admission.executable.actions).toEqual([]);
	});

	it("fails closed when a provider lists unaddressable duplicate objects at one exact path", async () => {
		const env = makeEnv();
		addFile(env.remoteFs, "duplicate.md", "version-a", 1000).identityKey = "A";
		addFile(env.remoteFs, "other.md", "version-b", 1000).identityKey = "B";
		const visible = (await env.remoteFs.stat("duplicate.md"))!;
		const hidden = { ...(await env.remoteFs.stat("other.md"))!, path: "duplicate.md" };
		env.remoteFs.list = () => Promise.resolve([visible, hidden]);
		const remoteWrite = vi.spyOn(env.remoteFs, "write");
		const remoteDelete = vi.spyOn(env.remoteFs, "delete");
		const remoteRename = vi.spyOn(env.remoteFs, "rename");
		const commitCheckpoint = vi.spyOn(env.remoteFs.checkpoint!, "commitCheckpoint");
		const abortWorkingView = vi.spyOn(env.remoteFs.checkpoint!, "abortWorkingView");

		const changes = await collectChanges({
			localFs: env.localFs, remoteFs: env.remoteFs, stateStore: env.stateStore,
			changes: env.localTracker.snapshot(),
		}, { forceFullScan: true });
		const { snapshot } = prepareSyncCycleSnapshot(changes, "provider-duplicate", { ignorePatterns: [] });
		const admission = admitBatchObservation(snapshot);
		const result = await executePlan(admission.executable, {
			localFs: env.localFs, remoteFs: env.remoteFs,
			committer: { stateStore: env.stateStore }, conflictStrategy: "auto_merge",
		});

		expect(admission.failures).toMatchObject([{ reasons: ["conflicting_identity"] }]);
		expect(result.succeeded).toEqual([]);
		expect(remoteWrite).not.toHaveBeenCalled();
		expect(remoteDelete).not.toHaveBeenCalled();
		expect(remoteRename).not.toHaveBeenCalled();
		expect((await finalizeSyncCycle({
			admission, result, checkpoint: env.remoteFs.checkpoint,
			scopeFingerprint: "provider-duplicate",
		})).kind).toBe("incomplete");
		expect(commitCheckpoint).not.toHaveBeenCalled();
		expect(abortWorkingView).toHaveBeenCalledOnce();
	});

	it("re-observes a latent write alias as a cover on the next cycle", async () => {
		const env = makeEnv();
		addFile(env.localFs, "Case.md", "local", 1000);
		const acquire = async () => {
			const changes = await collectChanges({
				localFs: env.localFs, remoteFs: env.remoteFs, stateStore: env.stateStore,
				changes: env.localTracker.snapshot(),
			}, { forceFullScan: true });
			const { snapshot } = prepareSyncCycleSnapshot(changes, "latent-write-alias", { ignorePatterns: [] });
			return admitBatchObservation(snapshot);
		};
		const execute = (admission: ReturnType<typeof admitBatchObservation>) => executePlan(
			admission.executable,
			{
				localFs: env.localFs, remoteFs: env.remoteFs,
				committer: { stateStore: env.stateStore }, conflictStrategy: "auto_merge",
			},
		);
		const firstAdmission = await acquire();
		expect(firstAdmission.executable.actions).toMatchObject([{ action: "push", path: "Case.md" }]);
		addFile(env.remoteFs, "case.md", "remote", 2000).identityKey = "R";
		const exactRemoteStat = env.remoteFs.stat.bind(env.remoteFs);
		env.remoteFs.stat = (path) => path === "Case.md" ? exactRemoteStat("case.md") : exactRemoteStat(path);
		const firstWrite = vi.spyOn(env.remoteFs, "write");
		const commitCheckpoint = vi.spyOn(env.remoteFs.checkpoint!, "commitCheckpoint");

		const firstResult = await execute(firstAdmission);
		expect(firstResult.blocked).toHaveLength(1);
		expect(firstResult.conflicts).toEqual([]);
		expect(firstWrite).not.toHaveBeenCalled();
		expect((await finalizeSyncCycle({
			admission: firstAdmission, result: firstResult,
			checkpoint: env.remoteFs.checkpoint, scopeFingerprint: "latent-write-alias",
		})).kind).toBe("incomplete");
		expect(commitCheckpoint).not.toHaveBeenCalled();

		vi.restoreAllMocks();
		const secondAdmission = await acquire();
		expect(secondAdmission.failures).toEqual([]);
		expect(secondAdmission.executable.actions).toMatchObject([{
			action: "conflict", protocol: { kind: "preservation_cover" },
		}]);
		const secondResult = await execute(secondAdmission);
		expect(secondResult.failed).toEqual([]);
		expect(secondResult.blocked).toEqual([]);
		expect(secondResult.conflicts).toHaveLength(1);

		const thirdAdmission = await acquire();
		expect(thirdAdmission.failures).toEqual([]);
		expect(thirdAdmission.executable.actions).toEqual([]);
	});

	it("identical files first seen together resolve to match (hash-based), then converge", async () => {
		const env = makeEnv();
		// Same content on both sides, no baseline. The hot path stat()s both, so
		// this only resolves to `match` (not `conflict`) when the mock computes a
		// real SHA-256 — exercising backend-faithful hashing end-to-end.
		addFile(env.localFs, "same.md", "identical", 1000);
		addFile(env.remoteFs, "same.md", "identical", 1000);
		env.localTracker.acknowledge(env.localTracker.snapshot()); // initialize → hot path
		env.localTracker.markDirty("same.md");

		const first = await runCycle(env);
		expect(actionTypes(first)).toEqual(["match"]);
		// match is state-only: it records a baseline without touching either file.
		expect(await env.stateStore.get("same.md")).toBeDefined();
		expect(readText(env.localFs, "same.md")).toBe("identical");
		expect(readText(env.remoteFs, "same.md")).toBe("identical");

		const second = await runCycle(env);
		expect(second.actions).toHaveLength(0);
	});

	// A remote rename must collapse to a single rename_local across the WHOLE pipeline
	// (delta → plan → refine → execute → commit), then converge — not re-pull file by
	// file. This is the end-to-end regression for the Dropbox folder-rename bug (ADR 0006);
	// no per-stage test proves the rename pair, the per-file delete/pull actions, and the
	// baseline rewrite compose into a fixed point.

	/** Report a remote delta exactly once (the rename), then nothing — like a real cursor. */
	function deliverOnce(
		env: Env,
		delta: { modified: string[]; deleted: string[]; renamed: RenamePair[] },
	): void {
		let delivered = false;
		env.remoteFs.checkpoint!.getChangedPaths = () => {
			if (delivered) return Promise.resolve({ modified: [], deleted: [] });
			delivered = true;
			return Promise.resolve(delta);
		};
	}

	it("a remote FOLDER rename collapses to one rename_local, then converges", async () => {
		const env = makeEnv();
		addFile(env.localFs, "dir/b.md", "beta", 1000);
		addFile(env.localFs, "dir/c.md", "gamma", 1000);

		// Cycle 1: push both files; now in sync at the old folder path.
		expect(actionTypes(await runCycle(env))).toEqual(["push", "push"]);

		// The folder is renamed on the remote: move it there and report the rename once.
		await env.remoteFs.rename("dir", "papers");
		confirmMockPath(env.remoteFs, "papers");
		deliverOnce(env, {
			modified: ["papers/b.md", "papers/c.md"],
			deleted: ["dir/b.md", "dir/c.md"],
			renamed: [{ oldPath: "dir", newPath: "papers", isFolder: true }],
		});

		// Cycle 2: a SINGLE rename_local — not delete_local×2 + pull×2.
		const renameCycle = await runCycle(env);
		expect(actionTypes(renameCycle)).toEqual(["rename_local"]);
		expect(readText(env.localFs, "papers/b.md")).toBe("beta");
		expect(readText(env.localFs, "papers/c.md")).toBe("gamma");
		expect(env.localFs.files.has("dir/b.md")).toBe(false);
		// Baselines moved with the folder (no stale dir/* record to resurrect).
		expect(await env.stateStore.get("papers/b.md")).toBeDefined();
		expect(await env.stateStore.get("dir/b.md")).toBeUndefined();

		// Cycle 3: fixed point.
		expect((await runCycle(env)).actions).toHaveLength(0);
	});

	it("a remote FILE rename collapses to one rename_local, then converges", async () => {
		const env = makeEnv();
		addFile(env.localFs, "note.md", "body", 1000);

		expect(actionTypes(await runCycle(env))).toEqual(["push"]);

		await env.remoteFs.rename("note.md", "renamed.md");
		confirmMockPath(env.remoteFs, "renamed.md");
		deliverOnce(env, {
			modified: ["renamed.md"],
			deleted: ["note.md"],
			renamed: [{ oldPath: "note.md", newPath: "renamed.md" }],
		});

		const renameCycle = await runCycle(env);
		expect(actionTypes(renameCycle)).toEqual(["rename_local"]);
		expect(readText(env.localFs, "renamed.md")).toBe("body");
		expect(env.localFs.files.has("note.md")).toBe(false);
		expect(await env.stateStore.get("renamed.md")).toBeDefined();
		expect(await env.stateStore.get("note.md")).toBeUndefined();

		expect((await runCycle(env)).actions).toHaveLength(0);
	});
});
