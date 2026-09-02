import { describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { createMockRemoteFs } from "../__mocks__/sync-test-helpers";
import { renameDebtEvidence } from "./rename-debt";
import { SyncStateStore, type RenameDebt } from "./state";
import { resetRescanState } from "./sync-rescan";

function debt(namespace: string, oldPath: string, newPath: string): RenameDebt {
	return {
		namespace, side: "local", oldPath, newPath, isFolder: true,
		oldDisposition: "included", newDisposition: "included",
	};
}

describe("resetRescanState", () => {
	it("clears only current-target debt and preserves remote pending evidence", async () => {
		const store = new SyncStateStore(`rescan-${crypto.randomUUID()}`);
		const current = debt("test:root", "A", "B");
		const other = debt("test:other", "X", "Y");
		await store.upsertRenameDebts([current, other]);
		const remoteEvidence = {
			...renameDebtEvidence(current), side: "remote" as const, identityKey: "remote-id",
		};
		const remoteFs = createMockRemoteFs();
		const resetCheckpoint = vi.fn().mockResolvedValue(undefined);
		remoteFs.checkpoint!.resetCheckpoint = resetCheckpoint;

		const pending = await resetRescanState({
			checkpoint: remoteFs.checkpoint, namespace: "test:root",
			pendingEvidence: [renameDebtEvidence(current), remoteEvidence], stateStore: store,
		});

		expect(resetCheckpoint).toHaveBeenCalledTimes(1);
		expect(await store.getRenameDebts("test:root")).toEqual([]);
		expect(await store.getRenameDebts("test:other")).toEqual([other]);
		expect(pending).toEqual([remoteEvidence]);
		await store.close();
	});

	it("retains debt and pending evidence when checkpoint reset fails", async () => {
		const store = new SyncStateStore(`rescan-${crypto.randomUUID()}`);
		const current = debt("test:root", "A", "B");
		await store.upsertRenameDebts([current]);
		const pending = [renameDebtEvidence(current)];
		const remoteFs = createMockRemoteFs();
		remoteFs.checkpoint!.resetCheckpoint = vi.fn().mockRejectedValue(new Error("reset failed"));

		await expect(resetRescanState({
			checkpoint: remoteFs.checkpoint, namespace: "test:root",
			pendingEvidence: pending, stateStore: store,
		})).rejects.toThrow("reset failed");

		expect(await store.getRenameDebts("test:root")).toEqual([current]);
		expect(pending).toEqual([renameDebtEvidence(current)]);
		await store.close();
	});
});
