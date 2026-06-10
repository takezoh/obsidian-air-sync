import { describe, it, expect, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBHelper, isConnectionClosingError, sanitizeDbName } from "./idb-helper";

describe("IDBHelper", () => {
	let helper: IDBHelper;

	afterEach(async () => {
		await helper?.close();
	});

	function createHelper(): IDBHelper {
		helper = new IDBHelper({
			dbName: `test-idb-${Math.random()}`,
			version: 1,
			onUpgrade: (db) => {
				if (!db.objectStoreNames.contains("items")) {
					db.createObjectStore("items", { keyPath: "id" });
				}
			},
		});
		return helper;
	}

	it("open/close are idempotent", async () => {
		const h = createHelper();
		await h.open();
		await h.open();
		await h.close();
		await h.close();
	});

	it("runTransaction writes and reads data", async () => {
		const h = createHelper();

		await h.runTransaction("items", "readwrite", (tx) => {
			tx.objectStore("items").put({ id: "a", value: 42 });
			return () => {};
		});

		const result = await h.runTransaction("items", "readonly", (tx) => {
			const req = tx.objectStore("items").get("a");
			return () => req.result as { id: string; value: number };
		});

		expect(result).toEqual({ id: "a", value: 42 });
	});

	it("recovers after onversionchange closes the db", async () => {
		const h = createHelper();
		await h.open();

		const internal = h as unknown as {
			db: IDBDatabase | null;
			openPromise: Promise<void> | null;
		};
		internal.db?.close();
		internal.db = null;
		internal.openPromise = null;

		// getDb() should re-open
		const db = await h.getDb();
		expect(db).toBeTruthy();
	});

	it("recovers when transaction() throws 'connection is closing'", async () => {
		const h = createHelper();
		await h.runTransaction("items", "readwrite", (tx) => {
			tx.objectStore("items").put({ id: "a", value: 42 });
			return () => {};
		});

		// Simulate iOS closing the connection under us: the cached db handle throws
		// on the first transaction() call, then the helper must drop it and reopen.
		const internal = h as unknown as { db: IDBDatabase | null };
		const realDb = internal.db!;
		let threw = false;
		internal.db = new Proxy(realDb, {
			get(target, prop, receiver) {
				if (prop === "transaction" && !threw) {
					return () => {
						threw = true;
						const err = new Error(
							"Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
						);
						err.name = "InvalidStateError";
						throw err;
					};
				}
				const value: unknown = Reflect.get(target, prop, receiver);
				return typeof value === "function"
					? (value as (...args: unknown[]) => unknown).bind(target)
					: value;
			},
		});

		const result = await h.runTransaction("items", "readonly", (tx) => {
			const req = tx.objectStore("items").get("a");
			return () => req.result as { id: string; value: number };
		});

		expect(threw).toBe(true);
		expect(result).toEqual({ id: "a", value: 42 });
	});
});

describe("isConnectionClosingError", () => {
	it("matches InvalidStateError by name", () => {
		const err = new Error("boom");
		err.name = "InvalidStateError";
		expect(isConnectionClosingError(err)).toBe(true);
	});

	it("matches wrapped errors by message", () => {
		expect(
			isConnectionClosingError(new Error("Transaction aborted: The database connection is closing.")),
		).toBe(true);
	});

	it("ignores unrelated errors and non-errors", () => {
		expect(isConnectionClosingError(new Error("network down"))).toBe(false);
		expect(isConnectionClosingError("connection is closing")).toBe(false);
	});
});

describe("sanitizeDbName", () => {
	it("replaces non-alphanumeric characters", () => {
		expect(sanitizeDbName("my vault/name.ext")).toBe("my_vault_name_ext");
	});

	it("preserves hyphens and underscores", () => {
		expect(sanitizeDbName("vault-id_123")).toBe("vault-id_123");
	});
});
