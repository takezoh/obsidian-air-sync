import type { SyncRecord } from "./types";
import { IDBHelper, sanitizeDbName } from "../store/idb-helper";

const DB_NAME_PREFIX = "smart-sync";
const STORE_NAME = "sync-records";
const CONTENT_STORE_NAME = "sync-content";
const DB_VERSION = 3;
const LOCAL_SNAPSHOT_KEY = "__localSnapshot";

/** Snapshot of local vault state for startup delta detection */
export interface LocalFileSnapshot {
	/** path → { mtime, size } */
	files: Record<string, { m: number; s: number }>;
}

/** Persistent store for sync records using IndexedDB */
export class SyncStateStore {
	private helper: IDBHelper;

	constructor(vaultId: string) {
		this.helper = new IDBHelper({
			dbName: `${DB_NAME_PREFIX}-${sanitizeDbName(vaultId)}`,
			version: DB_VERSION,
			onUpgrade: (db, oldVersion) => {
				// Drop and recreate stores on schema-breaking upgrades (v2→v3: size → localSize/remoteSize)
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

	/** Get all sync records (without prevSyncContent for lightweight listing) */
	async getAll(): Promise<SyncRecord[]> {
		return this.helper.runTransaction(STORE_NAME, "readonly", (tx) => {
			const req = tx.objectStore(STORE_NAME).getAll();
			return () => req.result as SyncRecord[];
		});
	}

	/** Get multiple sync records by paths in a single transaction (O(delta)) */
	async getMany(paths: string[]): Promise<SyncRecord[]> {
		if (paths.length === 0) return [];
		return this.helper.runTransaction(STORE_NAME, "readonly", (tx) => {
			const store = tx.objectStore(STORE_NAME);
			const requests = paths.map((p) => store.get(p));
			return () =>
				requests
					.map((r) => r.result as SyncRecord | undefined)
					.filter((r): r is SyncRecord => r !== undefined);
		});
	}

	/** Save or update a sync record */
	async put(record: SyncRecord): Promise<void> {
		await this.helper.runTransaction(STORE_NAME, "readwrite", (tx) => {
			tx.objectStore(STORE_NAME).put(record);
			return () => {};
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

	/** Clear all sync records and content */
	async clear(): Promise<void> {
		await this.helper.runTransaction([STORE_NAME, CONTENT_STORE_NAME], "readwrite", (tx) => {
			tx.objectStore(STORE_NAME).clear();
			tx.objectStore(CONTENT_STORE_NAME).clear();
			return () => {};
		});
	}

	/** Store prevSyncContent separately for a path */
	async putContent(path: string, content: ArrayBuffer): Promise<void> {
		await this.helper.runTransaction(CONTENT_STORE_NAME, "readwrite", (tx) => {
			tx.objectStore(CONTENT_STORE_NAME).put({ path, content });
			return () => {};
		});
	}

	/** Get prevSyncContent for a path */
	async getContent(path: string): Promise<ArrayBuffer | undefined> {
		return this.helper.runTransaction(CONTENT_STORE_NAME, "readonly", (tx) => {
			const req = tx.objectStore(CONTENT_STORE_NAME).get(path);
			return () => {
				const result = req.result as { path: string; content: ArrayBuffer } | undefined;
				return result?.content;
			};
		});
	}

	/** Save the local vault snapshot for future startup delta detection */
	async saveLocalSnapshot(snapshot: LocalFileSnapshot): Promise<void> {
		const json = JSON.stringify(snapshot);
		const content = new TextEncoder().encode(json).buffer as ArrayBuffer;
		await this.putContent(LOCAL_SNAPSHOT_KEY, content);
	}

	/** Load the saved local vault snapshot, or null if not found */
	async loadLocalSnapshot(): Promise<LocalFileSnapshot | null> {
		const content = await this.getContent(LOCAL_SNAPSHOT_KEY);
		if (!content) return null;
		try {
			const json = new TextDecoder().decode(content);
			const parsed = JSON.parse(json) as LocalFileSnapshot;
			if (!parsed.files || typeof parsed.files !== "object") return null;
			return parsed;
		} catch {
			return null;
		}
	}
}
