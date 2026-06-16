import { describe, it, expect } from "vitest";
import { collectChanges } from "./change-detector";
import { planSync } from "./decision-engine";
import { refinePlan } from "./rename-optimizer";
import { executePlan } from "./plan-executor";
import { LocalChangeTracker } from "./local-tracker";
import {
	createMockFs,
	createMockStateStore,
	addFile,
	readText,
} from "../__mocks__/sync-test-helpers";
import type { RenamePair, SyncPlan } from "./types";

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
 *   collectChanges → planSync → refinePlan → executePlan (+ per-action commit)
 * — then runs it a SECOND time and asserts the plan is empty (the fixed point).
 */

interface Env {
	localFs: ReturnType<typeof createMockFs>;
	remoteFs: ReturnType<typeof createMockFs>;
	stateStore: ReturnType<typeof createMockStateStore>;
	localTracker: LocalChangeTracker;
}

function makeEnv(): Env {
	return {
		localFs: createMockFs("local"),
		remoteFs: createMockFs("remote"),
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
	const plan = refinePlan(
		planSync(changeSet.entries),
		snapshot.renamePairs,
		snapshot.folderRenamePairs,
		changeSet.remoteRenamePairs,
	);
	await executePlan(plan, {
		localFs,
		remoteFs,
		committer: { stateStore },
		conflictStrategy: "auto_merge",
	});
	// Acknowledging the snapshot also flips the tracker into its "initialized"
	// state for the next cycle.
	localTracker.acknowledge(snapshot);
	return plan;
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
