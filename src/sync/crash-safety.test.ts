import { describe, it, expect, vi } from "vitest";
import { collectChanges } from "./change-detector";
import { planSync } from "./decision-engine";
import { refinePlan } from "./rename-optimizer";
import { executePlan } from "./plan-executor";
import type { ExecutionResult } from "./plan-executor";
import { LocalChangeTracker } from "./local-tracker";
import {
	createMockFs,
	createMockStateStore,
	addFile,
	readText,
} from "../__mocks__/sync-test-helpers";
import type { SyncPlan } from "./types";

/**
 * Crash-safety contract (ARCHITECTURE.md design principle #5,
 * "crash-safe by construction"): state is committed only AFTER an action
 * succeeds, so an interrupted sync converges by simply re-syncing.
 *
 * convergence.test.ts proves the happy path reaches a fixed point. This file
 * proves the *interrupted* path: when one action fails mid-plan, its baseline is
 * never written, the successful actions still commit, and a later cycle
 * re-detects and completes the failed work — converging without manual repair.
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

/** Run one full pipeline cycle (mirrors SyncOrchestrator.executeSyncOnce). */
async function runCycle(
	env: Env,
): Promise<{ plan: SyncPlan; result: ExecutionResult; temperature: string }> {
	const { localFs, remoteFs, stateStore, localTracker } = env;
	// Mirror the orchestrator: one snapshot at cycle start drives detection AND
	// the end-of-cycle acknowledge.
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
	const result = await executePlan(plan, {
		localFs,
		remoteFs,
		committer: { stateStore },
		conflictStrategy: "auto_merge",
	});
	// The orchestrator acknowledges the snapshot's dirty paths after a cycle
	// regardless of per-action success — so a failed action is NOT kept "dirty"
	// (the tracker cannot be relied on to re-surface it). Mirror that here, then
	// assert in each test that recovery comes from the next full re-scan
	// (warm/cold), not from a lingering dirty flag.
	localTracker.acknowledge(snapshot);
	return { plan, result, temperature: changeSet.temperature };
}

describe("an interrupted sync converges by re-syncing", () => {
	it("a failed push commits no baseline; a later cycle completes it", async () => {
		const env = makeEnv();
		addFile(env.localFs, "a.md", "alpha", 1000);
		addFile(env.localFs, "b.md", "beta", 1000);
		// Both files are dirtied before the cycle, so the post-cycle acknowledge
		// clears b.md's dirty flag even though its push fails — proving recovery
		// cannot rely on the tracker and must come from the next full re-scan.
		env.localTracker.markDirty("a.md");
		env.localTracker.markDirty("b.md");

		// Fail b.md's first remote write only (simulate a mid-sync crash/network
		// drop on one action). a.md's write proceeds normally.
		const realWrite = env.remoteFs.write.bind(env.remoteFs);
		let injected = false;
		vi.spyOn(env.remoteFs, "write").mockImplementation(
			(path, content, mtime) => {
				if (path === "b.md" && !injected) {
					injected = true;
					return Promise.reject(
						new Error("network dropped mid-write"),
					);
				}
				return realWrite(path, content, mtime);
			},
		);

		const first = await runCycle(env);

		// a.md succeeded and committed; b.md failed and committed nothing.
		expect(first.result.failed.map((f) => f.action.path)).toEqual(["b.md"]);
		expect(readText(env.remoteFs, "a.md")).toBe("alpha");
		expect(await env.stateStore.get("a.md")).toBeDefined();
		expect(env.remoteFs.files.has("b.md")).toBe(false);
		// Crux of principle #5: NO baseline for the failed action.
		expect(await env.stateStore.get("b.md")).toBeUndefined();

		// Re-sync (failure now cleared). b.md is no longer dirty, so a WARM
		// full local scan — not the tracker — must re-discover it.
		const second = await runCycle(env);
		expect(second.temperature).toBe("warm");
		expect(second.plan.actions.map((a) => a.action)).toEqual(["push"]);
		expect(second.plan.actions[0]?.path).toBe("b.md");
		expect(second.result.failed).toHaveLength(0);
		expect(readText(env.remoteFs, "b.md")).toBe("beta");
		expect(await env.stateStore.get("b.md")).toBeDefined();

		// Fixed point: a third cycle plans nothing.
		const third = await runCycle(env);
		expect(third.plan.actions).toHaveLength(0);
	});

	it("a failed pull leaves the local file and baseline untouched, then recovers", async () => {
		const env = makeEnv();
		addFile(env.remoteFs, "r.md", "remote body", 2000);

		const realWrite = env.localFs.write.bind(env.localFs);
		let injected = false;
		vi.spyOn(env.localFs, "write").mockImplementation(
			(path, content, mtime) => {
				if (path === "r.md" && !injected) {
					injected = true;
					return Promise.reject(new Error("disk full"));
				}
				return realWrite(path, content, mtime);
			},
		);

		const first = await runCycle(env);
		expect(first.result.failed.map((f) => f.action.path)).toEqual(["r.md"]);
		expect(env.localFs.files.has("r.md")).toBe(false);
		expect(await env.stateStore.get("r.md")).toBeUndefined();

		// Recovery: cycle 1 committed nothing (the pull failed), so the state
		// store is still empty and this cycle re-enters COLD — a full re-scan of
		// both sides re-discovers r.md and re-pulls it. (Contrast the push test,
		// which recovers via WARM because a.md's baseline was committed.)
		const second = await runCycle(env);
		expect(second.temperature).toBe("cold");
		expect(second.result.failed).toHaveLength(0);
		expect(readText(env.localFs, "r.md")).toBe("remote body");

		const third = await runCycle(env);
		expect(third.plan.actions).toHaveLength(0);
	});
});
