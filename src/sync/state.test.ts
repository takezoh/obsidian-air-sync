import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { SyncStateStore } from "./state";
import type { SyncRecord } from "./types";
import type { FileEntity } from "../fs/types";
import { commitAction } from "./state-committer";
import { IDBTransactionError, sanitizeDbName } from "../store/idb-helper";

/**
 * Observe the store's calls and not only its final contents. A rename and a
 * replacement can leave the same image behind; only the deletes a transaction
 * actually issues tell them apart, so every case that names one of the two
 * operations asserts the exact list. The spy calls through, so every write the
 * cases make is still performed by the real store.
 */
const deleteSpy = vi.spyOn(IDBObjectStore.prototype, "delete");
function keyOf(key: IDBValidKey | IDBKeyRange | undefined): string {
	return typeof key === "string" ? key : JSON.stringify(key);
}
function traceStoreDeletes(): () => string[] {
	deleteSpy.mockClear();
	return () => deleteSpy.mock.contexts.map((context, index) =>
		`${(context as IDBObjectStore).name}:${keyOf(deleteSpy.mock.calls[index]?.[0])}`);
}

function makeRecord(path: string, overrides: Partial<SyncRecord> = {}): SyncRecord {
	return {
		path,
		hash: "abc",
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 100,
		remoteSize: 100,
		remoteIdentityKey: `id:${path}`,
		syncedAt: 900,
		...overrides,
	};
}

async function seedVersion6Database(vaultId: string): Promise<void> {
	const dbName = `air-sync-${sanitizeDbName(vaultId)}`;
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.open(dbName, 6);
		request.onupgradeneeded = () => {
			const db = request.result;
			const records = db.createObjectStore("sync-records", { keyPath: "path" });
			records.put(makeRecord("legacy.md"));
			const contents = db.createObjectStore("sync-content", { keyPath: "path" });
			contents.put({ path: "legacy.md", content: new Uint8Array([1, 2, 3]).buffer });
			const debts = db.createObjectStore("rename-debt", { keyPath: "key" });
			debts.put({
				key: "legacy", namespace: "dropbox:root", side: "local",
				oldPath: "Case.md", newPath: "case.md", isFolder: false,
				oldDisposition: "included", newDisposition: "included",
			});
		};
		request.onerror = () => reject(request.error ?? new Error("Failed to seed version 5 database"));
		request.onsuccess = () => {
			request.result.close();
			resolve();
		};
	});
}

async function seedVersion7Database(vaultId: string): Promise<void> {
	const dbName = `air-sync-${sanitizeDbName(vaultId)}`;
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.open(dbName, 7);
		request.onupgradeneeded = () => {
			const db = request.result;
			const records = db.createObjectStore("sync-records", { keyPath: "path" });
			records.put(makeRecord("Templates/a.md", { remoteIdentityKey: "remote-a" }));
			const contents = db.createObjectStore("sync-content", { keyPath: "path" });
			contents.put({ path: "Templates/a.md", content: new Uint8Array([1, 2, 3]).buffer });
		};
		request.onerror = () => reject(request.error ?? new Error("Failed to seed version 7 database"));
		request.onsuccess = () => {
			request.result.close();
			resolve();
		};
	});
}

/** The path-keyed correspondence this schema replaces, seeded as a real v8 database. */
async function seedVersion8Database(vaultId: string): Promise<void> {
	const dbName = `air-sync-${sanitizeDbName(vaultId)}`;
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.open(dbName, 8);
		request.onupgradeneeded = () => {
			const db = request.result;
			const records = db.createObjectStore("sync-records", { keyPath: "path" });
			records.put(makeRecord("kept.md", { remoteIdentityKey: "remote-kept" }));
			const contents = db.createObjectStore("sync-content", { keyPath: "path" });
			contents.put({ path: "kept.md", content: new Uint8Array([1, 2, 3]).buffer });
		};
		request.onerror = () => reject(request.error ?? new Error("Failed to seed version 8 database"));
		request.onsuccess = () => {
			request.result.close();
			resolve();
		};
	});
}

describe("SyncStateStore", () => {
	let store: SyncStateStore;

	beforeEach(() => {
		store = new SyncStateStore(`test-vault-${Math.random()}`);
	});

	afterEach(async () => {
		await store.close();
	});

	it("open: opens successfully and can be called multiple times", async () => {
		await store.open();
		await store.open(); // idempotent
	});

	it("put + get: round-trips a sync record", async () => {
		const record = makeRecord("notes/hello.md", { remoteIdentityKey: "remote-id-1" });
		await store.put(record);
		const result = await store.get("notes/hello.md");
		expect(result).toEqual(record);
	});

	it("compareAndDelete: removes the exact record and its merge base together", async () => {
		const record = makeRecord("note.md");
		await store.put(record);
		await store.putContent(record.remoteIdentityKey, new Uint8Array([1, 2]).buffer);
		expect(await store.compareAndDelete(record.path, record)).toBe(true);
		expect(await store.get(record.path)).toBeUndefined();
		expect(await store.getContent(record.remoteIdentityKey)).toBeUndefined();
	});

	it("compareAndDelete: preserves a changed record and content on mismatch", async () => {
		const expected = makeRecord("note.md");
		const current = { ...expected, hash: "newer", syncedAt: 2000 };
		const bytes = new Uint8Array([3, 4]).buffer;
		await store.put(current);
		await store.putContent(current.remoteIdentityKey, bytes);
		expect(await store.compareAndDelete(current.path, expected)).toBe(false);
		expect(await store.compareAndDelete(current.path, undefined)).toBe(false);
		expect(await store.get(current.path)).toEqual(current);
		expect(await store.getContent(current.remoteIdentityKey)).toEqual(bytes);
	});

	// The identity floor is inside the construction function, before any store write:
	// an identity-less remote entity leaves both stores exactly as they were, and the
	// action fails so the cycle cannot complete.
	it("commitAction: an identity-less remote entity publishes nothing to either store", async () => {
		await store.open();
		const baseline = makeRecord("note.md", { remoteIdentityKey: "remote-1" });
		const base = new Uint8Array([1, 2]).buffer;
		await store.put(baseline);
		await store.putContent(baseline.remoteIdentityKey, base);
		const entity = (side: "local" | "remote"): FileEntity => ({
			path: "note.md", isDirectory: false, size: 5, mtime: 2000, hash: `${side}-hash`,
		});
		const local = entity("local");
		const remote = entity("remote");

		await expect(commitAction(
			{
				path: "note.md", action: "pull", local, remote, baseline,
				publication: { source: baseline, destination: baseline },
			},
			local, remote, { stateStore: store },
		)).rejects.toThrow("SyncRecord refused: remote entity carries no provider identity");

		expect(await store.get("note.md")).toEqual(baseline);
		expect(await store.getContent(baseline.remoteIdentityKey)).toEqual(base);
	});

	it("get: returns undefined for nonexistent path", async () => {
		const result = await store.get("does-not-exist.md");
		expect(result).toBeUndefined();
	});

	it("getMany: returns records for existing paths", async () => {
		await store.put(makeRecord("a.md"));
		await store.put(makeRecord("b.md"));
		await store.put(makeRecord("c.md"));

		const result = await store.getMany(["a.md", "c.md"]);
		expect(result.size).toBe(2);
		expect(result.get("a.md")).toEqual(makeRecord("a.md"));
		expect(result.get("c.md")).toEqual(makeRecord("c.md"));
	});

	it("getMany: omits nonexistent paths", async () => {
		await store.put(makeRecord("a.md"));

		const result = await store.getMany(["a.md", "missing.md"]);
		expect(result.size).toBe(1);
		expect(result.has("missing.md")).toBe(false);
	});

	it("getMany: returns empty map for empty input", async () => {
		const result = await store.getMany([]);
		expect(result.size).toBe(0);
	});

	it("getMany: returns empty map when no records exist", async () => {
		const result = await store.getMany(["a.md", "b.md"]);
		expect(result.size).toBe(0);
	});

	it("getAll: returns all stored records", async () => {
		await store.put(makeRecord("a.md"));
		await store.put(makeRecord("b.md"));
		await store.put(makeRecord("c.md"));

		const all = await store.getAll();
		expect(all).toHaveLength(3);
		const paths = all.map((r) => r.path).sort();
		expect(paths).toEqual(["a.md", "b.md", "c.md"]);
	});

	it("getAll: returns empty array when no records exist", async () => {
		const all = await store.getAll();
		expect(all).toHaveLength(0);
	});

	it("put: updates an existing record", async () => {
		await store.put(makeRecord("a.md", { localSize: 100 }));
		await store.put(makeRecord("a.md", { localSize: 200 }));

		const result = await store.get("a.md");
		expect(result?.localSize).toBe(200);

		const all = await store.getAll();
		expect(all).toHaveLength(1);
	});

	it("compareAndPut rejects a stale expected record without overwriting the winner", async () => {
		const baseline = makeRecord("a.md", { syncedAt: 1 });
		const winner = makeRecord("a.md", { syncedAt: 2, remoteSize: 200 });
		await store.put(baseline);
		await store.put(winner);

		expect(await store.compareAndPut(baseline, makeRecord("a.md", { syncedAt: 3 }), baseline)).toBe(false);
		expect(await store.get("a.md")).toEqual(winner);
	});

	it("compareAndPut atomically replaces the exact expected record", async () => {
		const baseline = makeRecord("a.md", { syncedAt: 1 });
		const next = makeRecord("a.md", { syncedAt: 2, remoteSize: 200 });
		await store.put(baseline);

		expect(await store.compareAndPut(baseline, next, baseline)).toBe(true);
		expect(await store.get("a.md")).toEqual(next);
	});

	it("compareAndPut invalidates an incompatible base only when publication succeeds", async () => {
		const baseline = makeRecord("A.md", { hash: "old" });
		const terminal = { ...baseline, hash: "new" };
		const bytes = new Uint8Array([1]).buffer;
		await store.put(baseline);
		await store.putContent(baseline.remoteIdentityKey, bytes);
		expect(await store.compareAndPut(undefined, terminal, undefined)).toBe(false);
		expect(await store.getContent(baseline.remoteIdentityKey)).toEqual(bytes);
		expect(await store.compareAndPut(baseline, terminal, baseline)).toBe(true);
		expect(await store.getContent(baseline.remoteIdentityKey)).toBeUndefined();
	});

	it("a rename is a single put: no delete is issued and the merge base stays in place", async () => {
		const baseline = makeRecord("old.md", { syncedAt: 1, remoteIdentityKey: "K" });
		const next = makeRecord("new.md", { syncedAt: 2, remoteIdentityKey: "K" });
		const base = new Uint8Array([1]).buffer;
		await store.put(baseline);
		await store.putContent("K", base);

		const issued = traceStoreDeletes();
		expect(await store.compareAndPut(baseline, next, undefined)).toBe(true);

		// The primary key does not move, so the whole operation is one put: a delete
		// issued here would be this case failing, not an implementation detail.
		expect(issued()).toEqual([]);
		expect(await store.get("old.md")).toBeUndefined();
		expect(await store.get("new.md")).toEqual(next);
		expect(await store.getAll()).toEqual([next]);
		// sync-content is keyed the same way, so the identically keyed base is untouched.
		expect(await store.getContent("K")).toEqual(base);
	});

	it("a content-changing rename invalidates the base by compareAndPut's own predicate", async () => {
		const baseline = makeRecord("old.md", { remoteIdentityKey: "K", hash: "old" });
		const next = { ...baseline, path: "new.md", hash: "new", syncedAt: 2 };
		await store.put(baseline);
		await store.putContent("K", new Uint8Array([1]).buffer);

		const issued = traceStoreDeletes();
		expect(await store.compareAndPut(baseline, next, undefined)).toBe(true);

		// The single delete is the base's, from the invalidation predicate — not a row move.
		expect(issued()).toEqual(["sync-content:K"]);
		expect(await store.get("new.md")).toEqual(next);
		expect(await store.getContent("K")).toBeUndefined();
	});

	it("compareAndPut preserves both addresses when the expected row is stale", async () => {
		const baseline = makeRecord("old.md", { syncedAt: 1, remoteIdentityKey: "K" });
		const winner = makeRecord("old.md", { syncedAt: 2, remoteIdentityKey: "K" });
		const existingNew = makeRecord("new.md", { syncedAt: 3, remoteIdentityKey: "KN" });
		await store.put(winner);
		await store.put(existingNew);

		const terminal = makeRecord("new.md", { syncedAt: 4, remoteIdentityKey: "K" });
		expect(await store.compareAndPut(baseline, terminal, existingNew)).toBe(false);
		expect(await store.get("old.md")).toEqual(winner);
		expect(await store.get("new.md")).toEqual(existingNew);
	});

	it("one remote identity holds one row: a second address leaves only the later one", async () => {
		const first = makeRecord("first.md", { remoteIdentityKey: "K" });
		const second = { ...first, path: "second.md", syncedAt: 2 };
		await store.put(first);
		await store.put(second);

		expect(await store.getAll()).toEqual([second]);
		expect(await store.get("first.md")).toBeUndefined();
		expect(await store.get("second.md")).toEqual(second);
	});

	it("a replacement deletes the compared incumbent as its own operation", async () => {
		const incumbent = makeRecord("P.md", { remoteIdentityKey: "K1" });
		const terminal = makeRecord("P.md", { remoteIdentityKey: "K2", syncedAt: 2 });
		await store.put(incumbent);
		await store.putContent("K1", new Uint8Array([1]).buffer);

		const issued = traceStoreDeletes();
		expect(await store.compareAndPut(undefined, terminal, incumbent)).toBe(true);

		// Observed as calls, not inferred from the image: the incumbent's row and its base
		// are removed explicitly, inside the transaction that claims the address.
		expect(issued()).toEqual([
			"sync-records:K1", "sync-content:K1", "sync-content:K2",
		]);
		expect(await store.getAll()).toEqual([terminal]);
		expect(await store.get("P.md")).toEqual(terminal);
		expect(await store.getContent("K1")).toBeUndefined();
	});

	it("a replacement whose captured incumbent has changed deletes nothing and returns false", async () => {
		const captured = makeRecord("P.md", { remoteIdentityKey: "K1" });
		const winner = { ...captured, syncedAt: 99 };
		const terminal = makeRecord("P.md", { remoteIdentityKey: "K2", syncedAt: 2 });
		const base = new Uint8Array([1]).buffer;
		await store.put(winner);
		await store.putContent("K1", base);

		const issued = traceStoreDeletes();
		// The comparison precedes the delete, so a stale expectation cannot destroy a row
		// the engine never admitted.
		expect(await store.compareAndPut(undefined, terminal, captured)).toBe(false);

		expect(issued()).toEqual([]);
		expect(await store.getAll()).toEqual([winner]);
		expect(await store.getContent("K1")).toEqual(base);
		expect(await store.getContent("K2")).toBeUndefined();
	});

	it("an address permutation commits the first publication and refuses the second", async () => {
		const a = makeRecord("A.md", { remoteIdentityKey: "KA" });
		const b = makeRecord("B.md", { remoteIdentityKey: "KB" });
		await store.put(a);
		await store.put(b);

		// No ordering, no refusal of the arrangement, no disposition: whichever
		// publication arrives first commits, and the other finds its expectation stale.
		expect(await store.compareAndPut(a, { ...a, path: "B.md" }, b)).toBe(true);
		expect(await store.compareAndPut(b, { ...b, path: "A.md" }, undefined)).toBe(false);
		expect(await store.getAll()).toEqual([{ ...a, path: "B.md" }]);
	});

	it("a baseline-free create refuses a non-vacant address; a recordless delete proves vacancy", async () => {
		const incumbent = makeRecord("P.md", { remoteIdentityKey: "K1" });
		await store.put(incumbent);

		const issued = traceStoreDeletes();
		const terminal = makeRecord("P.md", { remoteIdentityKey: "K2" });
		expect(await store.compareAndPut(undefined, terminal, undefined)).toBe(false);
		expect(await store.compareAndDelete("P.md", undefined)).toBe(false);
		expect(await store.compareAndDelete("vacant.md", undefined)).toBe(true);

		expect(issued()).toEqual([]);
		expect(await store.getAll()).toEqual([incumbent]);
	});

	it("the uncompared put aborts on the unique path index instead of displacing the incumbent", async () => {
		const incumbent = makeRecord("shared.md", { remoteIdentityKey: "K1" });
		const intruder = makeRecord("shared.md", { remoteIdentityKey: "K2" });
		const base = new Uint8Array([1]).buffer;
		await store.put(incumbent);
		await store.putContent("K1", base);

		const issued = traceStoreDeletes();
		// Every replacement deletes its own incumbent and so never reaches the index. The
		// only route that can is the uncompared put, and the two outcomes have different
		// SHAPES: an ordinary stale expectation returns false, a violated fs premise
		// throws out of the transaction. Not asserted by DOMException name — idb-helper
		// rejects from tx.onerror with tx.error still null, so every abort is unnamed
		// there; that helper defect is neither repaired nor worked around here.
		await expect(store.compareAndPut(undefined, intruder, undefined)).resolves.toBe(false);
		await expect(store.put(intruder)).rejects.toBeInstanceOf(IDBTransactionError);

		// Nothing was swallowed into a boolean, caught, mapped to false, or compensated by
		// deleting the incumbent to make room: both stores are exactly as they were.
		expect(issued()).toEqual([]);
		expect(await store.getAll()).toEqual([incumbent]);
		expect(await store.get("shared.md")).toEqual(incumbent);
		expect(await store.getContent("K1")).toEqual(base);
		expect(await store.getContent("K2")).toBeUndefined();
	});

	it("delete: removes a record and its content", async () => {
		const content = new TextEncoder().encode("hello").buffer.slice(0);
		await store.put(makeRecord("a.md"));
		await store.putContent("id:a.md", content);

		await store.delete("a.md");

		expect(await store.get("a.md")).toBeUndefined();
		expect(await store.getContent("id:a.md")).toBeUndefined();
	});

	it("compareAndPut refuses an uncaptured occupant and preserves both merge bases", async () => {
		const source = makeRecord("A.md", { remoteIdentityKey: "X" });
		const destination = makeRecord("B.md", { remoteIdentityKey: "Z" });
		await store.put(source);
		await store.put(destination);
		await store.putContent("X", new Uint8Array([1]).buffer);
		await store.putContent("Z", new Uint8Array([2]).buffer);

		const issued = traceStoreDeletes();
		expect(await store.compareAndPut(source, { ...source, path: "B.md" }, undefined)).toBe(false);

		expect(issued()).toEqual([]);
		expect(await store.get("A.md")).toEqual(source);
		expect(await store.get("B.md")).toEqual(destination);
		expect(await store.getContent("X")).toEqual(new Uint8Array([1]).buffer);
		expect(await store.getContent("Z")).toEqual(new Uint8Array([2]).buffer);
	});

	it("compareAndPut replaces an explicitly captured foreign occupant without identity policy", async () => {
		const source = makeRecord("A.md", { remoteIdentityKey: "X" });
		const destination = makeRecord("B.md", { remoteIdentityKey: "Z" });
		const terminal = { ...source, path: "B.md", syncedAt: 901 };
		await store.put(source);
		await store.put(destination);
		await store.putContent("Z", new Uint8Array([2]).buffer);

		const issued = traceStoreDeletes();
		expect(await store.compareAndPut(source, terminal, destination)).toBe(true);

		// One relocation of X's own row (no delete) and one explicit end of Z's.
		expect(issued()).toEqual(["sync-records:Z", "sync-content:Z"]);
		expect(await store.get("A.md")).toBeUndefined();
		expect(await store.get("B.md")).toEqual(terminal);
		expect(await store.getContent("Z")).toBeUndefined();
	});

	it("compareAndPut never deletes its result when the continued row already holds the address", async () => {
		const source = makeRecord("A.md");
		const terminal = { ...source, syncedAt: 902 };
		await store.put(source);

		const issued = traceStoreDeletes();
		expect(await store.compareAndPut(source, terminal, source)).toBe(true);

		expect(issued()).toEqual([]);
		expect(await store.get("A.md")).toEqual(terminal);
	});

	it("compareAndPutContent cannot attach a late base to a different terminal record", async () => {
		const captured = makeRecord("A.md");
		const current = { ...captured, hash: "new", syncedAt: 902 };
		await store.put(current);
		await store.putContent("id:A.md", new Uint8Array([2]).buffer);
		expect(await store.compareAndPutContent(captured, new Uint8Array([1]).buffer)).toBe(false);
		expect(await store.getContent("id:A.md")).toEqual(new Uint8Array([2]).buffer);
		expect(await store.compareAndPutContent(current, new Uint8Array([3]).buffer)).toBe(true);
		expect(await store.getContent("id:A.md")).toEqual(new Uint8Array([3]).buffer);
	});

	it("compareAndRewritePaths refuses an overlapping or cyclic set and publishes nothing", async () => {
		const a = makeRecord("A.md", { remoteIdentityKey: "X" });
		const b = makeRecord("B.md", { remoteIdentityKey: "Y" });
		await store.put(a);
		await store.put(b);

		const issued = traceStoreDeletes();
		// Each item updates one identity-keyed row in place, so no member vacates an
		// address for another to take: A's terminal address is B's source address and B's
		// row is still in it. Nothing here orders, stages or reserves a temporary.
		expect(await store.compareAndRewritePaths([
			{ source: a, destination: b, terminal: { ...a, path: "B.md" } },
			{ source: b, destination: undefined, terminal: { ...b, path: "C.md" } },
		])).toBe(false);
		// The cyclic arrangement, constructed directly so the case survives a rewrite of
		// the production loop that builds these sets.
		expect(await store.compareAndRewritePaths([
			{ source: a, destination: b, terminal: { ...a, path: "B.md" } },
			{ source: b, destination: a, terminal: { ...b, path: "A.md" } },
		])).toBe(false);

		expect(issued()).toEqual([]);
		expect(await store.get("A.md")).toEqual(a);
		expect(await store.get("B.md")).toEqual(b);
		expect(await store.getAll()).toHaveLength(2);
	});

	it("a twelve-child folder relocation publishes under one image and keeps every base", async () => {
		const children = Array.from({ length: 12 }, (_, index) =>
			makeRecord(`A/f${index}.md`, { remoteIdentityKey: `K${index}` }));
		for (const [index, child] of children.entries()) {
			await store.put(child);
			await store.putContent(child.remoteIdentityKey, new Uint8Array([index]).buffer);
		}

		const issued = traceStoreDeletes();
		expect(await store.compareAndRewritePaths(children.map((child) => ({
			source: child, destination: undefined,
			terminal: { ...child, path: child.path.replace("A/", "B/") },
		})))).toBe(true);

		expect(issued()).toEqual([]);
		expect((await store.getAll()).map((record) => record.path).sort())
			.toEqual(children.map((child) => `B/f${children.indexOf(child)}.md`).sort());
		for (const [index, child] of children.entries()) {
			expect(await store.getContent(child.remoteIdentityKey))
				.toEqual(new Uint8Array([index]).buffer);
		}
	});

	it("a relocation that also changes content invalidates every child's base, never some", async () => {
		const children = [0, 1, 2].map((index) =>
			makeRecord(`A/f${index}.md`, { remoteIdentityKey: `K${index}` }));
		for (const child of children) {
			await store.put(child);
			await store.putContent(child.remoteIdentityKey, new Uint8Array([1]).buffer);
		}

		expect(await store.compareAndRewritePaths(children.map((child) => ({
			source: child, destination: undefined,
			terminal: { ...child, path: child.path.replace("A/", "B/"), hash: "rewritten" },
		})))).toBe(true);

		for (const child of children) {
			expect(await store.getContent(child.remoteIdentityKey)).toBeUndefined();
		}
	});

	it("a relocation onto captured foreign incumbents replaces each of them under one image", async () => {
		const a = makeRecord("A/f1.md", { remoteIdentityKey: "KA1" });
		const b = makeRecord("A/f2.md", { remoteIdentityKey: "KA2" });
		const foreign1 = makeRecord("B/f1.md", { remoteIdentityKey: "KF1" });
		const foreign2 = makeRecord("B/f2.md", { remoteIdentityKey: "KF2" });
		for (const record of [a, b, foreign1, foreign2]) await store.put(record);
		await store.putContent("KF1", new Uint8Array([9]).buffer);

		const issued = traceStoreDeletes();
		expect(await store.compareAndRewritePaths([
			{ source: a, destination: foreign1, terminal: { ...a, path: "B/f1.md" } },
			{ source: b, destination: foreign2, terminal: { ...b, path: "B/f2.md" } },
		])).toBe(true);

		// Each such item is an ordinary replacement, discharged by the same rule as any
		// other displacement rather than by aborting on the index.
		expect(issued()).toEqual([
			"sync-records:KF1", "sync-content:KF1", "sync-records:KF2", "sync-content:KF2",
		]);
		expect((await store.getAll())
			.map((record) => `${record.path}@${record.remoteIdentityKey}`).sort())
			.toEqual(["B/f1.md@KA1", "B/f2.md@KA2"]);
		expect(await store.getContent("KF1")).toBeUndefined();
	});

	it("compareAndRewritePaths preserves all records and content on any mismatch", async () => {
		const a = makeRecord("old/a.md");
		const b = makeRecord("old/b.md");
		const winner = makeRecord("new/b.md", { hash: "foreign" });
		await store.put(a);
		await store.put(b);
		await store.put(winner);
		await store.putContent(a.remoteIdentityKey, new Uint8Array([1]).buffer);
		expect(await store.compareAndRewritePaths([
			{ source: a, destination: undefined, terminal: { ...a, path: "new/a.md" } },
			{ source: b, destination: undefined, terminal: { ...b, path: "new/b.md" } },
		])).toBe(false);
		expect(await store.getAll()).toEqual(expect.arrayContaining([a, b, winner]));
		expect(await store.getAll()).toHaveLength(3);
		expect(await store.getContent(a.remoteIdentityKey)).toEqual(new Uint8Array([1]).buffer);
	});

	it("compareAndRewritePaths rejects duplicate targets and admits self-overlap", async () => {
		const a = makeRecord("A.md");
		const b = makeRecord("B.md");
		await store.put(a);
		await store.put(b);
		expect(await store.compareAndRewritePaths([
			{ source: a, destination: undefined, terminal: { ...a, path: "C.md" } },
			{ source: b, destination: undefined, terminal: { ...b, path: "C.md" } },
		])).toBe(false);
		// Self-overlap — an unmoved item whose terminal address is its own source address
		// — is not overlap, and is admitted.
		expect(await store.compareAndRewritePaths([
			{ source: a, destination: a, terminal: { ...a, syncedAt: 903 } },
		])).toBe(true);
		expect(await store.get("A.md")).toEqual({ ...a, syncedAt: 903 });
		expect(await store.get("B.md")).toEqual(b);
	});

	it("delete: does not throw for nonexistent path", async () => {
		await expect(store.delete("nonexistent.md")).resolves.toBeUndefined();
	});

	it("clear: removes all records and content", async () => {
		const content = new TextEncoder().encode("data").buffer.slice(0);
		await store.put(makeRecord("a.md"));
		await store.put(makeRecord("b.md"));
		await store.putContent("id:a.md", content);

		await store.clear();

		expect(await store.getAll()).toHaveLength(0);
		expect(await store.getContent("id:a.md")).toBeUndefined();
	});

	it("schema upgrade removes v6 operation debt and cold-starts terminal state", async () => {
		await store.close();
		const vaultId = `upgrade-vault-${Math.random()}`;
		await seedVersion6Database(vaultId);
		store = new SyncStateStore(vaultId);

		await store.open();

		expect(await store.getAll()).toEqual([]);
		expect(await store.getContent("id:legacy.md")).toBeUndefined();
		expect(store).not.toHaveProperty("getRenameDebts");
		expect(store).not.toHaveProperty("upsertRenameDebts");
		expect(store).not.toHaveProperty("deleteRenameDebts");
		expect(store).not.toHaveProperty("clearRenameDebts");
	});

	it("schema upgrade drops v7 path identity so current facts can be collected normally", async () => {
		await store.close();
		const vaultId = `case-cold-start-vault-${Math.random()}`;
		await seedVersion7Database(vaultId);
		store = new SyncStateStore(vaultId);

		await store.open();

		expect(await store.getAll()).toEqual([]);
		expect(await store.getContent("remote-a")).toBeUndefined();
	});

	it("schema cold-starts the v8 path-keyed correspondence and re-keys both stores", async () => {
		await store.close();
		const vaultId = `rekey-vault-${Math.random()}`;
		await seedVersion8Database(vaultId);
		store = new SyncStateStore(vaultId);

		await store.open();

		// The proof is a real previous-version database that no longer has any rows, not
		// the arguments the upgrade callback happened to receive.
		expect(await store.getAll()).toEqual([]);
		expect(await store.get("kept.md")).toBeUndefined();
		expect(await store.getContent("remote-kept")).toBeUndefined();
		// And the schema it cold-started into is the identity-keyed one: a row is found
		// by its current address through the path index, having never moved.
		const record = makeRecord("one.md", { remoteIdentityKey: "K" });
		await store.put(record);
		await store.put({ ...record, path: "two.md" });
		expect(await store.getAll()).toEqual([{ ...record, path: "two.md" }]);
		expect(await store.get("one.md")).toBeUndefined();
		expect(await store.get("two.md")).toEqual({ ...record, path: "two.md" });
	});

	it("clear removes terminal records and content", async () => {
		const content = new TextEncoder().encode("merge base").buffer.slice(0);
		await store.put(makeRecord("A.md"));
		await store.putContent("id:A.md", content);
		await store.clear();

		expect(await store.getAll()).toEqual([]);
		expect(await store.getContent("id:A.md")).toBeUndefined();
	});

	it("putContent + getContent: round-trips content", async () => {
		const content = new TextEncoder().encode("hello world").buffer.slice(0);
		await store.putContent("remote-test", content);

		const result = await store.getContent("remote-test");
		expect(result).toBeDefined();
		const text = new TextDecoder().decode(result);
		expect(text).toBe("hello world");
	});

	it("getContent: returns undefined for an identity with no merge base", async () => {
		const result = await store.getContent("remote-nonexistent");
		expect(result).toBeUndefined();
	});

	it("close: can be called multiple times safely", async () => {
		await store.open();
		await store.close();
		await store.close();
	});

	it("concurrent open() calls resolve without error", async () => {
		await Promise.all([store.open(), store.open(), store.open()]);
		// Should work normally after concurrent opens
		await store.put(makeRecord("a.md"));
		const result = await store.get("a.md");
		expect(result?.path).toBe("a.md");
	});

	it("close then re-open works correctly", async () => {
		await store.put(makeRecord("a.md"));
		await store.close();
		await store.open();
		const result = await store.get("a.md");
		expect(result?.path).toBe("a.md");
	});

	it("re-opens after close", async () => {
		await store.put(makeRecord("a.md"));
		await store.close();

		// Re-open and verify data persists
		const result = await store.get("a.md");
		expect(result?.path).toBe("a.md");
	});

	it("recovers after onversionchange closes the db", async () => {
		await store.put(makeRecord("a.md"));

		// Simulate onversionchange: close db and null it out
		const internal = store as unknown as {
			helper: { db: IDBDatabase | null; openPromise: Promise<void> | null };
		};
		internal.helper.db?.close();
		internal.helper.db = null;
		internal.helper.openPromise = null;

		// getDb() should re-open and recover
		const result = await store.get("a.md");
		expect(result?.path).toBe("a.md");
	});
});
