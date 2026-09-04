import type { RenamePair, SyncRecord } from "./types";
import { IDBHelper, sanitizeDbName } from "../store/idb-helper";
import { encodeContent, decodeContent } from "../store/content-codec";

const DB_NAME_PREFIX = "air-sync";
const STORE_NAME = "sync-records";
const CONTENT_STORE_NAME = "sync-content";
// v4: SyncRecord checksum moved from backendMeta.contentChecksum to a typed
// remoteChecksum field — cold-start drops old records so they re-baseline.
// v5: content store now holds codec-prefixed bytes (see content-codec.ts);
// cold-start drops old un-prefixed entries so they re-baseline compressed.
// v6 added persisted rename intent. v7 removes it and cold-starts so future
// decisions derive only from terminal records and current observations.
// v8 cold-starts v7 path identity after the metadata-cache checkpoint defect:
// retaining those records can relate the already-converged old and new casing
// forever, so ordinary collection and Admission rebuild from current facts.
const DB_VERSION = 8;

/** Persistent store for sync records using IndexedDB */
export class SyncStateStore {
	private helper: IDBHelper;

	constructor(vaultId: string) {
		this.helper = new IDBHelper({
			dbName: `${DB_NAME_PREFIX}-${sanitizeDbName(vaultId)}`,
			version: DB_VERSION,
			onUpgrade: (db, oldVersion) => {
				// Cold start: drop all stores and recreate on any schema version change
				if (oldVersion > 0) {
					for (const name of Array.from(db.objectStoreNames)) {
						db.deleteObjectStore(name);
					}
				}
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME, { keyPath: "path" });
				}
				if (!db.objectStoreNames.contains(CONTENT_STORE_NAME)) {
					db.createObjectStore(CONTENT_STORE_NAME, { keyPath: "path" });
				}
			},
		});
	}

	async open(): Promise<void> {
		await this.helper.open();
	}

	async close(): Promise<void> {
		await this.helper.close();
	}

	/** Get a sync record by path */
	async get(path: string): Promise<SyncRecord | undefined> {
		return this.helper.runTransaction(STORE_NAME, "readonly", (tx) => {
			const req = tx.objectStore(STORE_NAME).get(path);
			return () => req.result as SyncRecord | undefined;
		});
	}

	/** Get multiple sync records by paths, returning only found entries */
	async getMany(paths: string[]): Promise<Map<string, SyncRecord>> {
		return this.helper.runTransaction(STORE_NAME, "readonly", (tx) => {
			const store = tx.objectStore(STORE_NAME);
			const reqs = paths.map((p) => ({ path: p, req: store.get(p) }));
			return () => {
				const result = new Map<string, SyncRecord>();
				for (const { path, req } of reqs) {
					const record = req.result as SyncRecord | undefined;
					if (record !== undefined) {
						result.set(path, record);
					}
				}
				return result;
			};
		});
	}

	/** Get all sync records (without prevSyncContent for lightweight listing) */
	async getAll(): Promise<SyncRecord[]> {
		return this.helper.runTransaction(STORE_NAME, "readonly", (tx) => {
			const req = tx.objectStore(STORE_NAME).getAll();
			return () => req.result as SyncRecord[];
		});
	}

	/** Save or update a sync record */
	async put(record: SyncRecord): Promise<void> {
		await this.helper.runTransaction(STORE_NAME, "readwrite", (tx) => {
			tx.objectStore(STORE_NAME).put(record);
			return () => {};
		});
	}

	/** Replace a record only when the same transaction still observes the expected baseline. */
	async compareAndPut(expected: SyncRecord | undefined, record: SyncRecord): Promise<boolean> {
		return this.helper.runTransaction(STORE_NAME, "readwrite", (tx) => {
			const store = tx.objectStore(STORE_NAME);
			const request = store.get(record.path);
			let replaced = false;
			request.onsuccess = () => {
				const current = request.result as SyncRecord | undefined;
				if (JSON.stringify(current) !== JSON.stringify(expected)) return;
				store.put(record);
				replaced = true;
			};
			return () => replaced;
		});
	}

	/** Atomically replace an exact old-path baseline with its new-path record. */
	async compareAndMove(expected: SyncRecord, record: SyncRecord): Promise<boolean> {
		return this.helper.runTransaction([STORE_NAME, CONTENT_STORE_NAME], "readwrite", (tx) => {
			const store = tx.objectStore(STORE_NAME);
			const contentStore = tx.objectStore(CONTENT_STORE_NAME);
			const request = store.get(expected.path);
			let moved = false;
			request.onsuccess = () => {
				const current = request.result as SyncRecord | undefined;
				if (JSON.stringify(current) !== JSON.stringify(expected)) return;
				store.put(record);
				store.delete(expected.path);
				contentStore.delete(expected.path);
				moved = true;
			};
			return () => moved;
		});
	}

	/** Delete a sync record by path */
	async delete(path: string): Promise<void> {
		await this.helper.runTransaction([STORE_NAME, CONTENT_STORE_NAME], "readwrite", (tx) => {
			tx.objectStore(STORE_NAME).delete(path);
			tx.objectStore(CONTENT_STORE_NAME).delete(path);
			return () => {};
		});
	}

	/**
	 * Batch-rewrite paths for multiple sync records in a single transaction.
	 * Uses IDB onsuccess callbacks to chain get→delete→put within the same
	 * transaction. runTransaction resolves on tx.oncomplete, which fires
	 * after all queued operations (including onsuccess-issued ones) complete.
	 */
	async rewritePaths(renames: RenamePair[]): Promise<void> {
		if (renames.length === 0) return;
		await this.helper.runTransaction([STORE_NAME, CONTENT_STORE_NAME], "readwrite", (tx) => {
			const store = tx.objectStore(STORE_NAME);
			const contentStore = tx.objectStore(CONTENT_STORE_NAME);
			for (const { oldPath, newPath } of renames) {
				const recordReq = store.get(oldPath);
				recordReq.onsuccess = () => {
					const record = recordReq.result as SyncRecord | undefined;
					if (record) {
						store.delete(oldPath);
						store.put({ ...record, path: newPath, syncedAt: Date.now() });
					}
				};
				const contentReq = contentStore.get(oldPath);
				contentReq.onsuccess = () => {
					const content = contentReq.result as { path: string; content: ArrayBuffer } | undefined;
					if (content) {
						contentStore.delete(oldPath);
						contentStore.put({ ...content, path: newPath });
					}
				};
			}
			return () => {};
		});
	}

	/** Clear all terminal sync records and merge-base content. */
	async clear(): Promise<void> {
		await this.helper.runTransaction(
			[STORE_NAME, CONTENT_STORE_NAME],
			"readwrite",
			(tx) => {
			tx.objectStore(STORE_NAME).clear();
			tx.objectStore(CONTENT_STORE_NAME).clear();
			return () => {};
			},
		);
	}

	/** Store prevSyncContent separately for a path (compressed via content-codec) */
	async putContent(path: string, content: ArrayBuffer): Promise<void> {
		const encoded = encodeContent(content);
		await this.helper.runTransaction(CONTENT_STORE_NAME, "readwrite", (tx) => {
			tx.objectStore(CONTENT_STORE_NAME).put({ path, content: encoded });
			return () => {};
		});
	}

	/** Get prevSyncContent for a path (decompressed via content-codec) */
	async getContent(path: string): Promise<ArrayBuffer | undefined> {
		const stored = await this.helper.runTransaction(CONTENT_STORE_NAME, "readonly", (tx) => {
			const req = tx.objectStore(CONTENT_STORE_NAME).get(path);
			return () => {
				const result = req.result as { path: string; content: ArrayBuffer } | undefined;
				return result?.content;
			};
		});
		// Decode outside the transaction: the thunk runs inside tx.oncomplete, where a
		// throw would escape the promise (hanging getContent) rather than reject. Corrupt
		// or unknown-format base content is non-authoritative — treat it as absent so the
		// merge falls back gracefully and the entry re-baselines on the next sync.
		if (!stored) return undefined;
		try {
			return decodeContent(stored);
		} catch {
			return undefined;
		}
	}
}
