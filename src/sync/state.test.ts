import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { SyncStateStore } from "./state";
import type { SyncRecord } from "./types";
import { sanitizeDbName } from "../store/idb-helper";

function makeRecord(path: string, overrides: Partial<SyncRecord> = {}): SyncRecord {
	return {
		path,
		hash: "abc",
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 100,
		remoteSize: 100,
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
		await store.putContent(record.path, new Uint8Array([1, 2]).buffer);
		expect(await store.compareAndDelete(record.path, record)).toBe(true);
		expect(await store.get(record.path)).toBeUndefined();
		expect(await store.getContent(record.path)).toBeUndefined();
	});

	it("compareAndDelete: preserves a changed record and content on mismatch", async () => {
		const expected = makeRecord("note.md");
		const current = { ...expected, hash: "newer", syncedAt: 2000 };
		const bytes = new Uint8Array([3, 4]).buffer;
		await store.put(current);
		await store.putContent(current.path, bytes);
		expect(await store.compareAndDelete(current.path, expected)).toBe(false);
		expect(await store.compareAndDelete(current.path, undefined)).toBe(false);
		expect(await store.get(current.path)).toEqual(current);
		expect(await store.getContent(current.path)).toEqual(bytes);
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

		expect(await store.compareAndPut(baseline, makeRecord("a.md", { syncedAt: 3 }))).toBe(false);
		expect(await store.get("a.md")).toEqual(winner);
	});

	it("compareAndPut atomically replaces the exact expected record", async () => {
		const baseline = makeRecord("a.md", { syncedAt: 1 });
		const next = makeRecord("a.md", { syncedAt: 2, remoteSize: 200 });
		await store.put(baseline);

		expect(await store.compareAndPut(baseline, next)).toBe(true);
		expect(await store.get("a.md")).toEqual(next);
	});

	it("compareAndPut invalidates an incompatible base only when publication succeeds", async () => {
		const baseline = makeRecord("A.md", { hash: "old" });
		const terminal = { ...baseline, hash: "new" };
		const bytes = new Uint8Array([1]).buffer;
		await store.put(baseline);
		await store.putContent(baseline.path, bytes);
		expect(await store.compareAndPut(undefined, terminal)).toBe(false);
		expect(await store.getContent(baseline.path)).toEqual(bytes);
		expect(await store.compareAndPut(baseline, terminal)).toBe(true);
		expect(await store.getContent(baseline.path)).toBeUndefined();
	});

	it("compareAndMove atomically replaces the exact old-path record and content", async () => {
		const baseline = makeRecord("old.md", { syncedAt: 1 });
		const next = makeRecord("new.md", { syncedAt: 2 });
		await store.put(baseline);
		await store.putContent("old.md", new Uint8Array([1]).buffer);

		expect(await store.compareAndMove(baseline, next)).toBe(true);
		expect(await store.get("old.md")).toBeUndefined();
		expect(await store.getContent("old.md")).toBeUndefined();
		expect(await store.get("new.md")).toEqual(next);
	});

	it("compareAndMove preserves both paths when the expected old record is stale", async () => {
		const baseline = makeRecord("old.md", { syncedAt: 1 });
		const winner = makeRecord("old.md", { syncedAt: 2 });
		const existingNew = makeRecord("new.md", { syncedAt: 3 });
		await store.put(winner);
		await store.put(existingNew);

		expect(await store.compareAndMove(baseline, makeRecord("new.md", { syncedAt: 4 }))).toBe(false);
		expect(await store.get("old.md")).toEqual(winner);
		expect(await store.get("new.md")).toEqual(existingNew);
	});

	it("delete: removes a record and its content", async () => {
		const content = new TextEncoder().encode("hello").buffer.slice(0);
		await store.put(makeRecord("a.md"));
		await store.putContent("a.md", content);

		await store.delete("a.md");

		expect(await store.get("a.md")).toBeUndefined();
		expect(await store.getContent("a.md")).toBeUndefined();
	});

	it("compareAndMove refuses an uncaptured destination and preserves both merge bases", async () => {
		const source = makeRecord("A.md", { remoteIdentityKey: "X" });
		const destination = makeRecord("B.md", { remoteIdentityKey: "Z" });
		await store.put(source);
		await store.put(destination);
		await store.putContent("A.md", new Uint8Array([1]).buffer);
		await store.putContent("B.md", new Uint8Array([2]).buffer);

		expect(await store.compareAndMove(source, { ...source, path: "B.md" })).toBe(false);
		expect(await store.get("A.md")).toEqual(source);
		expect(await store.get("B.md")).toEqual(destination);
		expect(await store.getContent("A.md")).toEqual(new Uint8Array([1]).buffer);
		expect(await store.getContent("B.md")).toEqual(new Uint8Array([2]).buffer);
	});

	it("compareAndMove compares an explicitly captured foreign destination without identity policy", async () => {
		const source = makeRecord("A.md", { remoteIdentityKey: "X" });
		const destination = makeRecord("B.md", { remoteIdentityKey: "Z" });
		const terminal = { ...source, path: "B.md", syncedAt: 901 };
		await store.put(source);
		await store.put(destination);
		await store.putContent("B.md", new Uint8Array([2]).buffer);

		expect(await store.compareAndMove(source, terminal, destination)).toBe(true);
		expect(await store.get("A.md")).toBeUndefined();
		expect(await store.get("B.md")).toEqual(terminal);
		expect(await store.getContent("B.md")).toBeUndefined();
	});

	it("compareAndMove never deletes its result when source and destination are the same key", async () => {
		const source = makeRecord("A.md");
		const terminal = { ...source, syncedAt: 902 };
		await store.put(source);
		expect(await store.compareAndMove(source, terminal, source)).toBe(true);
		expect(await store.get("A.md")).toEqual(terminal);
	});

	it("compareAndPutContent cannot attach a late base to a different terminal record", async () => {
		const captured = makeRecord("A.md");
		const current = { ...captured, hash: "new", syncedAt: 902 };
		await store.put(current);
		await store.putContent("A.md", new Uint8Array([2]).buffer);
		expect(await store.compareAndPutContent(captured, new Uint8Array([1]).buffer)).toBe(false);
		expect(await store.getContent("A.md")).toEqual(new Uint8Array([2]).buffer);
		expect(await store.compareAndPutContent(current, new Uint8Array([3]).buffer)).toBe(true);
		expect(await store.getContent("A.md")).toEqual(new Uint8Array([3]).buffer);
	});

	it("compareAndRewritePaths reads overlapping keys before removing any source", async () => {
		const a = makeRecord("A.md", { remoteIdentityKey: "X" });
		const b = makeRecord("B.md", { remoteIdentityKey: "Y" });
		await store.put(a);
		await store.put(b);
		expect(await store.compareAndRewritePaths([
			{ source: a, destination: b, terminal: { ...a, path: "B.md" } },
			{ source: b, destination: undefined, terminal: { ...b, path: "C.md" } },
		])).toBe(true);
		expect(await store.get("A.md")).toBeUndefined();
		expect(await store.get("B.md")).toEqual({ ...a, path: "B.md" });
		expect(await store.get("C.md")).toEqual({ ...b, path: "C.md" });
	});

	it("compareAndRewritePaths preserves all records and content on any mismatch", async () => {
		const a = makeRecord("old/a.md");
		const b = makeRecord("old/b.md");
		const winner = makeRecord("new/b.md", { hash: "foreign" });
		await store.put(a);
		await store.put(b);
		await store.put(winner);
		await store.putContent(a.path, new Uint8Array([1]).buffer);
		expect(await store.compareAndRewritePaths([
			{ source: a, destination: undefined, terminal: { ...a, path: "new/a.md" } },
			{ source: b, destination: undefined, terminal: { ...b, path: "new/b.md" } },
		])).toBe(false);
		expect(await store.getAll()).toEqual(expect.arrayContaining([a, b, winner]));
		expect(await store.getAll()).toHaveLength(3);
		expect(await store.getContent(a.path)).toEqual(new Uint8Array([1]).buffer);
	});

	it("compareAndRewritePaths rejects duplicate targets and supports same-key members", async () => {
		const a = makeRecord("A.md");
		const b = makeRecord("B.md");
		await store.put(a);
		await store.put(b);
		expect(await store.compareAndRewritePaths([
			{ source: a, destination: undefined, terminal: { ...a, path: "C.md" } },
			{ source: b, destination: undefined, terminal: { ...b, path: "C.md" } },
		])).toBe(false);
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
		await store.putContent("a.md", content);

		await store.clear();

		expect(await store.getAll()).toHaveLength(0);
		expect(await store.getContent("a.md")).toBeUndefined();
	});

	it("schema upgrade removes v6 operation debt and cold-starts terminal state", async () => {
		await store.close();
		const vaultId = `upgrade-vault-${Math.random()}`;
		await seedVersion6Database(vaultId);
		store = new SyncStateStore(vaultId);

		await store.open();

		expect(await store.getAll()).toEqual([]);
		expect(await store.getContent("legacy.md")).toBeUndefined();
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
		expect(await store.getContent("Templates/a.md")).toBeUndefined();
	});

	it("clear removes terminal records and content", async () => {
		const content = new TextEncoder().encode("merge base").buffer.slice(0);
		await store.put(makeRecord("A.md"));
		await store.putContent("A.md", content);
		await store.clear();

		expect(await store.getAll()).toEqual([]);
		expect(await store.getContent("A.md")).toBeUndefined();
	});

	it("putContent + getContent: round-trips content", async () => {
		const content = new TextEncoder().encode("hello world").buffer.slice(0);
		await store.putContent("notes/test.md", content);

		const result = await store.getContent("notes/test.md");
		expect(result).toBeDefined();
		const text = new TextDecoder().decode(result);
		expect(text).toBe("hello world");
	});

	it("getContent: returns undefined for nonexistent path", async () => {
		const result = await store.getContent("nonexistent.md");
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
