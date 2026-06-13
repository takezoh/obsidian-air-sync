import { describe, it, expect, vi } from "vitest";
import { collectChanges } from "./change-detector";
import { LocalChangeTracker } from "./local-tracker";
import {
	createMockFs,
	createMockStateStore,
	addFile,
} from "../__mocks__/sync-test-helpers";
import type { SyncRecord } from "./types";

/**
 * Delta-first contract (ARCHITECTURE.md design principle #3): only process files
 * that changed. O(n) full scans are allowed ONLY on cold start. The hot path —
 * tracker initialized with dirty paths — must touch the changed paths alone and
 * must NOT enumerate the whole vault (no localFs.list()).
 *
 * Without this guard a refactor could silently make every sync O(n): the result
 * would still be correct, just quadratically slower on large vaults. This pins
 * the cost model, not just the output.
 */

function baseline(path: string): SyncRecord {
	return {
		path,
		hash: "h",
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 5,
		remoteSize: 5,
		syncedAt: 900,
	};
}

describe("the hot path is O(delta), not O(vault)", () => {
	it("stats only the dirty path and never lists the whole vault", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const stateStore = createMockStateStore();
		const localTracker = new LocalChangeTracker();

		// 50 files in sync on both sides, each with a baseline.
		for (let i = 0; i < 50; i++) {
			const p = `note-${i}.md`;
			addFile(localFs, p, "alpha", 1000);
			addFile(remoteFs, p, "alpha", 1000);
			await stateStore.put(baseline(p));
		}

		// Initialize the tracker (flip out of cold start) and dirty exactly one file.
		localTracker.acknowledge(localTracker.snapshot());
		localTracker.markDirty("note-7.md");

		const listSpy = vi.spyOn(localFs, "list");
		const remoteListSpy = vi.spyOn(remoteFs, "list");
		const localStatSpy = vi.spyOn(localFs, "stat");
		const remoteStatSpy = vi.spyOn(remoteFs, "stat");

		const changeSet = await collectChanges({
			localFs,
			remoteFs,
			stateStore,
			changes: localTracker.snapshot(),
		});

		// Hot temperature, and the full-scan entry point was never used on
		// EITHER side — neither local nor remote enumerates the whole vault.
		expect(changeSet.temperature).toBe("hot");
		expect(listSpy).not.toHaveBeenCalled();
		expect(remoteListSpy).not.toHaveBeenCalled();

		// Work is bounded by the delta (1 path), independent of the 50-file vault.
		expect(localStatSpy).toHaveBeenCalledTimes(1);
		expect(localStatSpy).toHaveBeenCalledWith("note-7.md");
		expect(remoteStatSpy).toHaveBeenCalledTimes(1);
		expect(remoteStatSpy).toHaveBeenCalledWith("note-7.md");
	});

	it("cold start is the one place a full scan is allowed", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const stateStore = createMockStateStore();
		const localTracker = new LocalChangeTracker();

		addFile(localFs, "only.md", "x", 1000);
		// Fresh tracker + empty store → cold: a full list() is expected here.
		const listSpy = vi.spyOn(localFs, "list");

		const changeSet = await collectChanges({
			localFs,
			remoteFs,
			stateStore,
			changes: localTracker.snapshot(),
		});

		expect(changeSet.temperature).toBe("cold");
		expect(listSpy).toHaveBeenCalled();
	});
});
