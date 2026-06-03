import { describe, it, expect, vi } from "vitest";
import { planSync } from "./decision-engine";
import { executePlan } from "./plan-executor";
import { collectChanges } from "./change-detector";
import { LocalChangeTracker } from "./local-tracker";
import {
	createMockFs,
	createMockStateStore,
	addFile,
} from "../__mocks__/sync-test-helpers";
import type { SyncStateStore } from "./state";
import type { MixedEntity, SyncRecord } from "./types";
import type { FileEntity } from "../fs/types";

/**
 * Delete-safety contracts.
 *
 * §2-1: the old volume-based `safety-check` hard-aborted any 100%-deletion plan
 * with no count floor, so a single legitimate deletion never propagated while the
 * orchestrator reported success. The guard was removed; a lone deletion now plans
 * and executes normally — pinned GREEN below.
 *
 * Phantom warm deletion: a warm sync reads the in-memory vault index
 * (getAllLoadedFiles), which can under-report. An erroneous deletion is PREVENTED
 * at the source — `collectChanges` re-stat()s each baseline path absent from the
 * listing against the authoritative filesystem (`LocalFs.stat` falls back to the
 * adapter), so an unindexed-but-on-disk file is never deleted; a genuinely absent
 * file is still deleted.
 */

const CONTENT = "content"; // 7 bytes

function baselineRecord(path: string): SyncRecord {
	return {
		path,
		hash: "h",
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: CONTENT.length,
		remoteSize: CONTENT.length,
		syncedAt: 900,
	};
}

describe("§2-1 (fixed): a lone deletion is no longer silently aborted", () => {
	it("a lone local deletion is planned as delete_remote", () => {
		// local missing, remote unchanged vs baseline, baseline present.
		const remote: FileEntity = {
			path: "note.md",
			isDirectory: false,
			size: CONTENT.length,
			mtime: 1000,
			hash: "h",
		};
		const entry: MixedEntity = {
			path: "note.md",
			remote,
			prevSync: baselineRecord("note.md"),
		};
		expect(planSync([entry]).actions[0]?.action).toBe("delete_remote");
	});

	it("a lone delete_remote actually executes (no abort path remains)", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const stateStore = createMockStateStore();
		addFile(remoteFs, "note.md", CONTENT, 1000);
		await stateStore.put(baselineRecord("note.md"));

		const result = await executePlan(
			{ actions: [{ path: "note.md", action: "delete_remote" }] },
			{
				localFs,
				remoteFs,
				committer: { stateStore: stateStore as unknown as SyncStateStore },
				conflictStrategy: "auto_merge",
			},
		);

		expect(result.succeeded).toHaveLength(1);
		expect(remoteFs.files.has("note.md")).toBe(false);
		expect(await stateStore.get("note.md")).toBeUndefined();
	});
});

describe("phantom warm deletion: an incomplete listing does not mass-delete", () => {
	// Each baseline path absent from the (incomplete) listing is re-stat()'d
	// against the authoritative filesystem; the files exist on disk, so no
	// deletion is planned. This is prevention at the source — not recovery.
	it("a warm sync whose listing omits on-disk files plans zero delete_remote", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const stateStore = createMockStateStore();
		const localTracker = new LocalChangeTracker();

		// 20 files exist on both sides with baselines, but the local listing comes
		// back empty (an incomplete getAllLoadedFiles before the index settles).
		// The files are still present on disk, so stat() finds every one.
		for (let i = 0; i < 20; i++) {
			const p = `note-${i}.md`;
			addFile(remoteFs, p, CONTENT, 1000);
			addFile(localFs, p, CONTENT, 1000);
			await stateStore.put(baselineRecord(p));
		}
		vi.spyOn(localFs, "list").mockResolvedValueOnce([]);

		const changeSet = await collectChanges({
			localFs,
			remoteFs,
			stateStore,
			localTracker,
		});
		const deletes = planSync(changeSet.entries).actions.filter(
			(a) => a.action === "delete_remote",
		).length;

		expect(deletes).toBe(0);
	});

	it("a genuinely deleted file (absent on disk too) is still planned as delete_remote", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const stateStore = createMockStateStore();
		const localTracker = new LocalChangeTracker();

		addFile(remoteFs, "gone.md", CONTENT, 1000);
		await stateStore.put(baselineRecord("gone.md"));
		// gone.md is in neither the listing nor on disk → a real deletion.

		const changeSet = await collectChanges({
			localFs,
			remoteFs,
			stateStore,
			localTracker,
		});
		const action = planSync(changeSet.entries).actions.find(
			(a) => a.path === "gone.md",
		);
		expect(action?.action).toBe("delete_remote");
	});
});
