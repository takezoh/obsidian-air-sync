import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { ManagedRemoteFs } from "../../../src/fs/managed/managed-remote-fs";
import { insertConflictSuffix } from "../../../src/utils/path";
import { SyncOrchestrator, type SyncOrchestratorDeps } from "../../../src/sync/orchestrator";
import { LocalChangeTracker } from "../../../src/sync/local-tracker";
import { createChecksumRegistry } from "../../../src/fs/modules/checksum-registry";
import { createMockLocalFs, mockSettings, readText } from "../../../src/__mocks__/sync-test-helpers";
import type { SyncRecord } from "../../../src/sync/types";
import { FaithfulCollisionAdapter } from "./faithful-collision-adapter";

const checksumRegistry = createChecksumRegistry();

const STORE = { dbNamePrefix: "air-sync-orchestrator-namespace", version: 1 };

function record(path: string, identityKey: string): SyncRecord {
	return {
		path, remoteIdentityKey: identityKey, hash: "h",
		localMtime: 1, remoteMtime: 1, localSize: 1, remoteSize: 1, syncedAt: 1,
	};
}

/**
 * The production boundary, driven end to end. The remote filesystem's
 * `reconcileNamespace` must build the working view itself: the collision is seeded
 * on the provider WITHOUT a prior `getChangedPaths()`, and the real `SyncOrchestrator`
 * runs the cycle. A reconcile that no longer builds its own view would leave the
 * collision for the engine (the conflict address never appears) and this fails.
 */
describe("SyncOrchestrator × ManagedRemoteFs — the reconciliation boundary is wired", () => {
	it("renames the non-keeper and commits only on the follow-up cycle", async () => {
		const vaultId = `ns-orchestrator-${Math.random()}`;
		const adapter = new FaithfulCollisionAdapter();
		const movedId = adapter.seedFile("Other.md", "other");
		const establishedId = adapter.seedFile("Note.md", "note");
		const fs = new ManagedRemoteFs({
			adapter, name: "faithful", rootFolderId: adapter.rootId, vaultId, store: STORE,
		});
		await fs.list();
		await fs.commitCheckpoint();
		const conflictTarget = insertConflictSuffix("Note.md", `id-${movedId}`);

		const statuses: string[] = [];
		const localFs = createMockLocalFs();
		const deps: SyncOrchestratorDeps = {
			getSettings: () => mockSettings({ vaultId, backendType: "googledrive" }),
			saveSettings: vi.fn().mockResolvedValue(undefined),
			configDir: () => ".cfg",
			pluginId: () => "test-plugin",
			localFs: () => localFs,
			remoteFs: () => fs,
			backendProvider: () => null,
			checksumRegistry,
			onStatusChange: (status) => statuses.push(status),
			onProgress: vi.fn(),
			notify: vi.fn(),
			isMobile: () => false,
			isLayoutReady: () => true,
			localTracker: new LocalChangeTracker(),
		};
		const orchestrator = new SyncOrchestrator(deps);
		const reconcile = vi.spyOn(fs.namespaceReconciliation, "reconcileNamespace");
		const abortWorkingView = vi.spyOn(fs, "abortWorkingView");
		const commitCheckpoint = vi.spyOn(fs, "commitCheckpoint");
		// BOTH claimants are already-synced, each with a record at its own path. The
		// keeper must still be the record holder at the CONTENDED address; an
		// implementation that asks which claimants hold any record finds two and falls
		// through to the arbiter winner (the lower id), which is the old bug.
		await orchestrator.state.put(record("Other.md", movedId));
		await orchestrator.state.put(record("Note.md", establishedId));

		// The moved object lands on the established address AFTER the checkpoint.
		adapter.enqueue(adapter.simulateRename(movedId, "Note.md"));

		// No `fs.getChangedPaths()`: reconciliation must build the working view itself.
		await orchestrator.runSync();

		// The contended path's record holder kept the plain address; the other claimant
		// was renamed. This is what the "both already-synced" shape pins.
		expect((await adapter.getByPath("Note.md")).map((object) => object.id)).toEqual([establishedId]);
		expect((await adapter.getByPath(conflictTarget)).map((object) => object.id)).toEqual([movedId]);
		// The repair is TWO reconciles: the first reports changed and aborts, the second
		// finds nothing left to repair, and only then does the follow-up commit. A cycle
		// that kept going after the abort and committed would not reach a second
		// reconcile, so the full order is pinned, not just the counts.
		expect(reconcile).toHaveBeenCalledTimes(2);
		expect(abortWorkingView).toHaveBeenCalledTimes(1);
		expect(commitCheckpoint).toHaveBeenCalledTimes(1);
		const firstReconcile = reconcile.mock.invocationCallOrder[0]!;
		const abort = abortWorkingView.mock.invocationCallOrder[0]!;
		const secondReconcile = reconcile.mock.invocationCallOrder[1]!;
		const commit = commitCheckpoint.mock.invocationCallOrder[0]!;
		expect(firstReconcile).toBeLessThan(abort);
		expect(abort).toBeLessThan(secondReconcile);
		expect(secondReconcile).toBeLessThan(commit);
		expect(await fs.checkpoint?.hasCheckpoint()).toBe(true);
		// The follow-up reached the vault: both settled addresses are readable locally
		// with their own content, so an empty-delta follow-up cannot pass.
		expect((await localFs.stat("Note.md"))?.isDirectory).toBe(false);
		expect(readText(localFs, "Note.md")).toBe("note");
		expect((await localFs.stat(conflictTarget))?.isDirectory).toBe(false);
		expect(readText(localFs, conflictTarget)).toBe("other");
		// The collision never reached the engine as an error.
		expect(statuses).not.toContain("partial_error");

		await orchestrator.close();
		await fs.close();
	});

	it("settles the collision on the COLD (no checkpoint) path", async () => {
		const vaultId = `ns-orchestrator-cold-${Math.random()}`;
		const adapter = new FaithfulCollisionAdapter();
		const movedId = adapter.seedFile("Other.md", "other");
		const establishedId = adapter.seedFile("Note.md", "note");
		const fs = new ManagedRemoteFs({
			adapter, name: "faithful", rootFolderId: adapter.rootId, vaultId, store: STORE,
		});
		// NO checkpoint: the collision exists on the provider before any list, so the
		// cycle goes cold and reconciliation must build its working view from the full
		// scan (AC-RECON-002 parity). A reconcile that only worked off a delta would
		// never see this contention.
		adapter.simulateRename(movedId, "Note.md");
		const conflictTarget = insertConflictSuffix("Note.md", `id-${movedId}`);

		const localFs = createMockLocalFs();
		const statuses: string[] = [];
		const orchestrator = new SyncOrchestrator({
			getSettings: () => mockSettings({ vaultId, backendType: "googledrive" }),
			saveSettings: vi.fn().mockResolvedValue(undefined),
			configDir: () => ".cfg",
			pluginId: () => "test-plugin",
			localFs: () => localFs,
			remoteFs: () => fs,
			backendProvider: () => null,
			checksumRegistry,
			onStatusChange: (status) => statuses.push(status),
			onProgress: vi.fn(),
			notify: vi.fn(),
			isMobile: () => false,
			isLayoutReady: () => true,
			localTracker: new LocalChangeTracker(),
		});
		const abortWorkingView = vi.spyOn(fs, "abortWorkingView");
		const commitCheckpoint = vi.spyOn(fs, "commitCheckpoint");
		await orchestrator.state.put(record("Note.md", establishedId));

		expect(await fs.checkpoint?.hasCheckpoint()).toBe(false);
		await orchestrator.runSync();

		// The record holder kept the contended address; the other object survives at the
		// conflict address. The cold view is retried, not committed, until it settles.
		expect((await adapter.getByPath("Note.md")).map((object) => object.id)).toEqual([establishedId]);
		expect((await adapter.getByPath(conflictTarget)).map((object) => object.id)).toEqual([movedId]);
		expect(abortWorkingView).toHaveBeenCalledTimes(1);
		expect(commitCheckpoint).toHaveBeenCalledTimes(1);
		expect(await fs.checkpoint?.hasCheckpoint()).toBe(true);
		expect((await localFs.stat("Note.md"))?.isDirectory).toBe(false);
		expect((await localFs.stat(conflictTarget))?.isDirectory).toBe(false);
		expect(statuses).not.toContain("partial_error");

		await orchestrator.close();
		await fs.close();
	});
});
