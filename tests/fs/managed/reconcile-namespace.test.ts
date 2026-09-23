import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { ManagedRemoteFs } from "../../../src/fs/managed/managed-remote-fs";
import { insertConflictSuffix } from "../../../src/utils/path";
import { FaithfulCollisionAdapter } from "./faithful-collision-adapter";

const STORE = { dbNamePrefix: "air-sync-reconcile-test", version: 1 };

function makeFs(adapter: FaithfulCollisionAdapter, vaultId: string): ManagedRemoteFs {
	return new ManagedRemoteFs({
		adapter, name: "faithful", rootFolderId: adapter.rootId, vaultId, store: STORE,
	});
}

/**
 * Two root-level files, the moved one seeded first so its id sorts lower. A full
 * scan followed by a committed checkpoint is the clean vault the next cycle starts
 * from; the moved object then lands on the established object's address.
 */
async function seedAndCollide(adapter: FaithfulCollisionAdapter, vaultId: string) {
	const movedId = adapter.seedFile("Other.md", "other");
	const establishedId = adapter.seedFile("Note.md", "note");
	const fs = makeFs(adapter, vaultId);
	await fs.list();
	await fs.commitCheckpoint();
	adapter.enqueue(adapter.simulateRename(movedId, "Note.md"));
	await fs.getChangedPaths();
	return { fs, movedId, establishedId };
}

const policy = (overrides: Partial<Parameters<ManagedRemoteFs["namespaceReconciliation"]["reconcileNamespace"]>[0]> = {}) => ({
	isInScope: () => true,
	keeper: () => Promise.resolve(undefined),
	...overrides,
});

describe("ManagedRemoteFs.namespaceReconciliation — the filesystem repairs the provider namespace", () => {
	it("renames the non-keeper by identity and reports changed", async () => {
		const adapter = new FaithfulCollisionAdapter();
		const { fs, movedId, establishedId } = await seedAndCollide(adapter, "reconcile-selected");
		const target = insertConflictSuffix("Note.md", `id-${establishedId}`);

		const result = await fs.namespaceReconciliation.reconcileNamespace(policy());

		expect(result.kind).toBe("changed");
		// On the provider: the keeper untouched, the non-keeper at the conflict address.
		expect((await adapter.getByPath("Note.md")).map((object) => object.id)).toEqual([movedId]);
		expect((await adapter.getByPath(target)).map((object) => object.id)).toEqual([establishedId]);
		// In the working view the rename's own endpoint is applied.
		expect((await fs.stat("Note.md"))?.identityKey).toBe(movedId);
		expect((await fs.stat(target))?.identityKey).toBe(establishedId);
		await fs.close();
	});

	it("verifies the admitted address with one provider read, without walking the parent chain", async () => {
		const adapter = new FaithfulCollisionAdapter();
		const movedId = adapter.seedFile("docs/Other.md", "other");      // creates the docs folder
		const establishedId = adapter.seedFile("docs/Note.md", "note");
		const fs = makeFs(adapter, "reconcile-nested");
		await fs.list();
		await fs.commitCheckpoint();
		// The moved object lands on the established object's nested address.
		adapter.enqueue(adapter.simulateRename(movedId, "Note.md"));
		await fs.getChangedPaths();
		const getById = vi.spyOn(adapter, "getById");

		const result = await fs.namespaceReconciliation.reconcileNamespace(policy());

		expect(result.kind).toBe("changed");
		// The renamed object is re-observed once; `docs` is resolved from the working
		// view, not fetched, so depth is not a per-ancestor provider read.
		expect(getById).toHaveBeenCalledTimes(1);
		const target = insertConflictSuffix("docs/Note.md", `id-${establishedId}`);
		expect((await adapter.getByPath("docs/Note.md")).map((object) => object.id)).toEqual([movedId]);
		expect((await adapter.getByPath(target)).map((object) => object.id)).toEqual([establishedId]);
		await fs.close();
	});

	it("renames the admitted claimant instead when the engine names the withheld claimant the keeper", async () => {
		const adapter = new FaithfulCollisionAdapter();
		const { fs, movedId, establishedId } = await seedAndCollide(adapter, "reconcile-keeper-policy");
		const target = insertConflictSuffix("Note.md", `id-${movedId}`);

		const result = await fs.namespaceReconciliation.reconcileNamespace(
			policy({ keeper: () => Promise.resolve(establishedId) }),
		);

		expect(result.kind).toBe("changed");
		expect((await adapter.getByPath("Note.md")).map((object) => object.id)).toEqual([establishedId]);
		expect((await adapter.getByPath(target)).map((object) => object.id)).toEqual([movedId]);

		// The evicted keeper is not lost to the cache. Discarding the working view and
		// re-reading the settled provider facts converges: the drain re-seats the evicted
		// claimant from the metadata the cache handed back, so no repair is re-planned.
		await fs.abortWorkingView();
		await fs.getChangedPaths();
		const replay = await fs.namespaceReconciliation.reconcileNamespace(
			policy({ keeper: () => Promise.resolve(establishedId) }),
		);
		expect(replay.kind).toBe("settled");
		expect((await fs.stat("Note.md"))?.identityKey).toBe(establishedId);
		await fs.close();
	});

	it("settles after the working view is discarded and the settled provider facts are re-read", async () => {
		const adapter = new FaithfulCollisionAdapter();
		const { fs } = await seedAndCollide(adapter, "reconcile-convergence");
		expect((await fs.namespaceReconciliation.reconcileNamespace(policy())).kind).toBe("changed");

		await fs.abortWorkingView();
		await fs.getChangedPaths();

		expect((await fs.namespaceReconciliation.reconcileNamespace(policy())).kind).toBe("settled");
		await fs.close();
	});

	it("does not touch a provider object at an out-of-scope address", async () => {
		const adapter = new FaithfulCollisionAdapter();
		const { fs } = await seedAndCollide(adapter, "reconcile-out-of-scope");
		const move = vi.spyOn(adapter, "move");

		const result = await fs.namespaceReconciliation.reconcileNamespace(policy({ isInScope: () => false }));

		expect(result.kind).toBe("settled");
		expect(move).not.toHaveBeenCalled();
		await fs.close();
	});

	it("performs at most one rename per contended address per cycle, settling three claimants over cycles", async () => {
		const adapter = new FaithfulCollisionAdapter();
		const first = adapter.seedFile("A.md", "a");      // sorts lowest: keeps the address
		const second = adapter.seedFile("Note.md", "b");  // the established sibling
		const third = adapter.seedFile("C.md", "c");
		const fs = makeFs(adapter, "reconcile-many-claimants");
		await fs.list();
		await fs.commitCheckpoint();
		adapter.enqueue(adapter.simulateRename(first, "Note.md"));
		adapter.enqueue(adapter.simulateRename(third, "Note.md"));
		await fs.getChangedPaths();
		const move = vi.spyOn(adapter, "move");

		expect((await fs.namespaceReconciliation.reconcileNamespace(policy())).kind).toBe("changed");
		expect(move).toHaveBeenCalledTimes(1);
		expect((await adapter.getByPath(insertConflictSuffix("Note.md", `id-${second}`))).map((o) => o.id))
			.toEqual([second]);
		// Two claimants remain at the address: the next cycle settles one more.
		expect((await adapter.getByPath("Note.md")).map((o) => o.id).sort()).toEqual([first, third].sort());

		await fs.abortWorkingView();
		await fs.getChangedPaths();
		expect((await fs.namespaceReconciliation.reconcileNamespace(policy())).kind).toBe("changed");
		expect(move).toHaveBeenCalledTimes(2);
		await fs.abortWorkingView();
		await fs.getChangedPaths();
		expect((await fs.namespaceReconciliation.reconcileNamespace(policy())).kind).toBe("settled");
		expect(move).toHaveBeenCalledTimes(2);
		await fs.close();
	});

	it("re-renames a reconciled object with its refreshed version token", async () => {
		const adapter = new FaithfulCollisionAdapter();
		const { fs, movedId, establishedId } = await seedAndCollide(adapter, "reconcile-then-rerename");
		const conflictTarget = insertConflictSuffix("Note.md", `id-${movedId}`);
		expect((await fs.namespaceReconciliation.reconcileNamespace(
			policy({ keeper: () => Promise.resolve(establishedId) }))).kind).toBe("changed");
		// The repaired cycle aborts its view; the follow-up re-reads the settled facts.
		await fs.abortWorkingView();
		await fs.getChangedPaths();
		// The moved object now sits at the conflict address. A later cycle renames the
		// same committed object again; its cached version must be the post-rename one.
		await fs.rename(conflictTarget, "Moved.md");
		expect((await adapter.getByPath("Moved.md")).map((object) => object.id)).toEqual([movedId]);
		await fs.close();
	});

	it("reports failed, without a wrong-object move, when the backend refuses the rename", async () => {
		const adapter = new FaithfulCollisionAdapter();
		const { fs } = await seedAndCollide(adapter, "reconcile-refused");
		vi.spyOn(adapter, "move").mockRejectedValue(new Error("insufficient permissions"));

		const result = await fs.namespaceReconciliation.reconcileNamespace(policy());

		expect(result.kind).toBe("failed");
		if (result.kind !== "failed") throw new Error("unreachable");
		expect(result.failures).toHaveLength(1);
		await fs.close();
	});
});
