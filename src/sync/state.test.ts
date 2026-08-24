import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { SyncStateStore } from "./state";
import type { RenameDebt } from "./state";
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

function makeDebt(overrides: Partial<RenameDebt> = {}): RenameDebt {
	return {
		namespace: "onedrive:vault-1",
		side: "local",
		oldPath: "A.md",
		newPath: "a.md",
		isFolder: false,
		oldDisposition: "included",
		newDisposition: "included",
		...overrides,
	};
}

async function seedVersion5Database(vaultId: string): Promise<void> {
	const dbName = `air-sync-${sanitizeDbName(vaultId)}`;
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.open(dbName, 5);
		request.onupgradeneeded = () => {
			const db = request.result;
			const records = db.createObjectStore("sync-records", { keyPath: "path" });
			records.put(makeRecord("legacy.md"));
			const contents = db.createObjectStore("sync-content", { keyPath: "path" });
			contents.put({ path: "legacy.md", content: new Uint8Array([1, 2, 3]).buffer });
		};
		request.onerror = () => reject(request.error ?? new Error("Failed to seed version 5 database"));
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

	it("delete: removes a record and its content", async () => {
		const content = new TextEncoder().encode("hello").buffer.slice(0);
		await store.put(makeRecord("a.md"));
		await store.putContent("a.md", content);

		await store.delete("a.md");

		expect(await store.get("a.md")).toBeUndefined();
		expect(await store.getContent("a.md")).toBeUndefined();
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

	it("schema upgrade cold-starts legacy records and merge bases", async () => {
		await store.close();
		const vaultId = `upgrade-vault-${Math.random()}`;
		await seedVersion5Database(vaultId);
		store = new SyncStateStore(vaultId);

		await store.open();

		expect(await store.getAll()).toEqual([]);
		expect(await store.getContent("legacy.md")).toBeUndefined();
		expect(await store.getRenameDebts("onedrive:vault-1")).toEqual([]);
	});

	it("rename debt upsert replaces the same edge and retains distinct unresolved edges", async () => {
		await store.upsertRenameDebts([makeDebt({ oldDisposition: "unknown" })]);
		await store.upsertRenameDebts([
			makeDebt({ oldDisposition: "included" }),
			makeDebt({ oldPath: "B.md", newPath: "b.md" }),
		]);

		const debts = await store.getRenameDebts("onedrive:vault-1");
		expect(debts).toHaveLength(2);
		expect(debts).toContainEqual(makeDebt({ oldDisposition: "included" }));
		expect(debts).toContainEqual(makeDebt({ oldPath: "B.md", newPath: "b.md" }));
	});

	it("rename debt grows by unique unresolved edges across cycles and decreases on resolution", async () => {
		await store.upsertRenameDebts([makeDebt()]);
		await store.upsertRenameDebts([
			makeDebt({ oldPath: "B.md", newPath: "b.md" }),
			makeDebt({ oldPath: "C.md", newPath: "c.md" }),
		]);
		expect(await store.getRenameDebts("onedrive:vault-1")).toHaveLength(3);

		await store.deleteRenameDebts([makeDebt({ oldPath: "B.md", newPath: "b.md" })]);
		expect(await store.getRenameDebts("onedrive:vault-1")).toEqual([
			makeDebt(),
			makeDebt({ oldPath: "C.md", newPath: "c.md" }),
		]);
	});

	it("clearRenameDebts removes only the selected backend/root namespace", async () => {
		await store.upsertRenameDebts([
			makeDebt(),
			makeDebt({ namespace: "dropbox:vault-2" }),
		]);

		await store.clearRenameDebts("onedrive:vault-1");

		expect(await store.getRenameDebts("onedrive:vault-1")).toEqual([]);
		expect(await store.getRenameDebts("dropbox:vault-2")).toEqual([
			makeDebt({ namespace: "dropbox:vault-2" }),
		]);
	});

	it("clear removes authoritative rename debt with records and content", async () => {
		const content = new TextEncoder().encode("merge base").buffer.slice(0);
		await store.put(makeRecord("A.md"));
		await store.putContent("A.md", content);
		await store.upsertRenameDebts([makeDebt()]);

		await store.clear();

		expect(await store.getAll()).toEqual([]);
		expect(await store.getContent("A.md")).toBeUndefined();
		expect(await store.getRenameDebts("onedrive:vault-1")).toEqual([]);
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
