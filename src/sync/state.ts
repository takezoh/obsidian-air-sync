import type { RecordRelocation, SyncRecord } from "./types";
import { IDBHelper, sanitizeDbName } from "../store/idb-helper";
import { encodeContent, decodeContent } from "../store/content-codec";

const DB_NAME_PREFIX = "air-sync";
const STORE_NAME = "sync-records";
const CONTENT_STORE_NAME = "sync-content";
/** Address lookups read this index; its uniqueness guards an fs premise, not a policy. */
const PATH_INDEX = "path";
// v4: SyncRecord checksum moved from backendMeta.contentChecksum to a typed
// remoteChecksum field — cold-start drops old records so they re-baseline.
// v5: content store now holds codec-prefixed bytes (see content-codec.ts);
// cold-start drops old un-prefixed entries so they re-baseline compressed.
// v6 added persisted rename intent. v7 removes it and cold-starts so future
// decisions derive only from terminal records and current observations.
// v8 cold-starts v7 path identity after the metadata-cache checkpoint defect:
// retaining those records can relate the already-converged old and new casing
// forever, so ordinary collection and Admission rebuild from current facts.
// v9 re-keys both stores to remoteIdentityKey and adds a unique index over path,
// so two baselines for one provider object are unrepresentable and two records at
// one address abort instead of silently displacing one another. The bump is only
// what rebuilds the path-keyed rows under the new key: it is NOT what closes the
// identity-less record class — buildSyncRecord's construction floor already did
// that, so every record reaching this schema already names its remote object.
const DB_VERSION = 9;

/** Whole-record comparison; no publication route ever compares a subset of a captured row. */
function same(current: unknown, expected: SyncRecord | undefined): boolean {
	return JSON.stringify(current) === JSON.stringify(expected);
}

/**
 * compareAndPut's merge-base invalidation predicate, referenced by every publication
 * route rather than restated: a relocation alone leaves the base in place, because
 * sync-content is keyed by the same identity and the row does not move.
 */
function invalidatesMergeBase(expected: SyncRecord | undefined, record: SyncRecord): boolean {
	return !expected || !record.hash || expected.hash !== record.hash ||
		expected.localSize !== record.localSize ||
		expected.remoteIdentityKey !== record.remoteIdentityKey;
}

/**
 * The two operations, and the only rows a publication may touch. A rename — the
 * terminal carrying the continued row's own identity at a new address — is a single
 * put, because path is no longer the key. A replacement — a compared row whose
 * identity the terminal does not carry, whether it holds the claimed address or is
 * the row this publication no longer continues — ends that correspondence with an
 * explicit delete, issued only after the caller's comparison has already passed.
 */
function publishRecord(
	tx: IDBTransaction,
	expectedRow: SyncRecord | undefined,
	record: SyncRecord,
	expectedOccupant: SyncRecord | undefined,
): void {
	const store = tx.objectStore(STORE_NAME);
	const content = tx.objectStore(CONTENT_STORE_NAME);
	for (const ended of [expectedOccupant, expectedRow]) {
		if (!ended || ended.remoteIdentityKey === record.remoteIdentityKey) continue;
		store.delete(ended.remoteIdentityKey);
		content.delete(ended.remoteIdentityKey);
	}
	store.put(record);
	if (invalidatesMergeBase(expectedRow, record)) content.delete(record.remoteIdentityKey);
}

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
					const records = db.createObjectStore(STORE_NAME, { keyPath: "remoteIdentityKey" });
					records.createIndex(PATH_INDEX, "path", { unique: true });
				}
				if (!db.objectStoreNames.contains(CONTENT_STORE_NAME)) {
					db.createObjectStore(CONTENT_STORE_NAME, { keyPath: "remoteIdentityKey" });
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
			const req = tx.objectStore(STORE_NAME).index(PATH_INDEX).get(path);
			return () => req.result as SyncRecord | undefined;
		});
	}

	/** Get multiple sync records by paths, returning only found entries */
	async getMany(paths: string[]): Promise<Map<string, SyncRecord>> {
		// Every cycle asks for the records at its contended addresses, and almost every
		// cycle has none. Opening a transaction to issue zero requests costs a database
		// round trip for a result that is already known.
		if (paths.length === 0) return new Map();
		return this.helper.runTransaction(STORE_NAME, "readonly", (tx) => {
			const index = tx.objectStore(STORE_NAME).index(PATH_INDEX);
			const reqs = paths.map((p) => ({ path: p, req: index.get(p) }));
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

	/**
	 * Get multiple sync records by their provider identity, returning only found
	 * entries. The store is keyed by identity, so a row can be read wherever its
	 * object currently lives — the counterpart of {@link getMany}, which reads by
	 * address.
	 */
	async getManyByIdentity(identities: readonly string[]): Promise<Map<string, SyncRecord>> {
		if (identities.length === 0) return new Map();
		return this.helper.runTransaction(STORE_NAME, "readonly", (tx) => {
			const store = tx.objectStore(STORE_NAME);
			const reqs = identities.map((identity) => ({ identity, req: store.get(identity) }));
			return () => {
				const result = new Map<string, SyncRecord>();
				for (const { identity, req } of reqs) {
					const record = req.result as SyncRecord | undefined;
					if (record !== undefined) result.set(identity, record);
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

	/**
	 * Save or update a sync record, uncompared. It is the one route that can reach the
	 * unique path index: two records for different identities at one address abort the
	 * transaction, which can only mean the filesystem layer's path-uniqueness guarantee
	 * is broken. The failure propagates rather than being caught or compensated.
	 */
	async put(record: SyncRecord): Promise<void> {
		await this.helper.runTransaction(STORE_NAME, "readwrite", (tx) => {
			tx.objectStore(STORE_NAME).put(record);
			return () => {};
		});
	}

	/**
	 * Replace a record only when the same transaction still observes both captured
	 * expectations: `expectedRow`, the row this publication continues, keyed by the
	 * terminal's own provider identity; and `expectedOccupant`, whatever currently
	 * holds the terminal address, read through the unique path index. Neither is
	 * defaulted from the other — under an identity key they are different rows — and
	 * the comparison precedes every write, so a stale expectation destroys nothing.
	 */
	async compareAndPut(
		expectedRow: SyncRecord | undefined,
		record: SyncRecord,
		expectedOccupant: SyncRecord | undefined,
	): Promise<boolean> {
		return this.helper.runTransaction([STORE_NAME, CONTENT_STORE_NAME], "readwrite", (tx) => {
			const store = tx.objectStore(STORE_NAME);
			// A captured row whose identity the terminal does not carry is not continued
			// by this publication, so it is read where it lives and compared there before
			// it ends — the terminal's own identity must then hold no row at all.
			const ended = expectedRow && expectedRow.remoteIdentityKey !== record.remoteIdentityKey
				? expectedRow : undefined;
			const row = store.get(record.remoteIdentityKey);
			const endedRow = ended ? store.get(ended.remoteIdentityKey) : undefined;
			const occupant = store.index(PATH_INDEX).get(record.path);
			let replaced = false;
			occupant.onsuccess = () => {
				if (!same(row.result, ended ? undefined : expectedRow) ||
					!same(endedRow?.result, ended) ||
					!same(occupant.result, expectedOccupant)) return;
				publishRecord(tx, expectedRow, record, expectedOccupant);
				replaced = true;
			};
			return () => replaced;
		});
	}

	/**
	 * Delete the captured record by its identity, after proving in the same transaction
	 * that it is both still that row and still the occupant of `path`. With no expected
	 * record there is no row to address, so this verifies the address is vacant, deletes
	 * nothing, and returns true.
	 */
	async compareAndDelete(path: string, expected: SyncRecord | undefined): Promise<boolean> {
		return this.helper.runTransaction([STORE_NAME, CONTENT_STORE_NAME], "readwrite", (tx) => {
			const store = tx.objectStore(STORE_NAME);
			const row = expected ? store.get(expected.remoteIdentityKey) : undefined;
			const occupant = store.index(PATH_INDEX).get(path);
			let deleted = false;
			occupant.onsuccess = () => {
				if (!same(row?.result, expected) || !same(occupant.result, expected)) return;
				if (expected) {
					store.delete(expected.remoteIdentityKey);
					tx.objectStore(CONTENT_STORE_NAME).delete(expected.remoteIdentityKey);
				}
				deleted = true;
			};
			return () => deleted;
		});
	}

	/** Unconditional test/setup removal; execution uses exact comparison. */
	async delete(path: string): Promise<void> {
		await this.helper.runTransaction([STORE_NAME, CONTENT_STORE_NAME], "readwrite", (tx) => {
			const store = tx.objectStore(STORE_NAME);
			const occupant = store.index(PATH_INDEX).get(path);
			occupant.onsuccess = () => {
				const record = occupant.result as SyncRecord | undefined;
				if (!record) return;
				store.delete(record.remoteIdentityKey);
				tx.objectStore(CONTENT_STORE_NAME).delete(record.remoteIdentityKey);
			};
			return () => {};
		});
	}

	/** Compare the entire admitted folder mapping against one transaction image. */
	async compareAndRewritePaths(relocations: readonly RecordRelocation[]): Promise<boolean> {
		const sources = new Set(relocations.map((item) => item.source.path));
		const targets = new Set(relocations.map((item) => item.terminal.path));
		if (sources.size !== relocations.length || targets.size !== relocations.length) return false;
		// Every item updates one identity-keyed row in place, so no member vacates an
		// address for another member to claim. Refuse the whole set when one item's
		// terminal address is a *different* item's source address — a cyclic set is one
		// such arrangement — while admitting self-overlap, where an unmoved item's
		// terminal address is its own source address.
		if (relocations.some((item) => item.source.path !== item.terminal.path &&
			sources.has(item.terminal.path))) return false;
		if (relocations.length === 0) return true;
		return this.helper.runTransaction([STORE_NAME, CONTENT_STORE_NAME], "readwrite", (tx) => {
			const store = tx.objectStore(STORE_NAME);
			const index = store.index(PATH_INDEX);
			const reads = relocations.map((item) => ({
				item,
				source: store.get(item.source.remoteIdentityKey),
				destination: index.get(item.terminal.path),
			}));
			let published = false;
			reads[reads.length - 1]!.destination.onsuccess = () => {
				if (reads.some(({ item, source, destination }) =>
					!same(source.result, item.source) || !same(destination.result, item.destination))) return;
				for (const { item } of reads) publishRecord(tx, item.source, item.terminal, item.destination);
				published = true;
			};
			return () => published;
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

	/** Store prevSyncContent separately for one remote identity (compressed via content-codec) */
	async putContent(remoteIdentityKey: string, content: ArrayBuffer): Promise<void> {
		const encoded = encodeContent(content);
		await this.helper.runTransaction(CONTENT_STORE_NAME, "readwrite", (tx) => {
			tx.objectStore(CONTENT_STORE_NAME).put({ remoteIdentityKey, content: encoded });
			return () => {};
		});
	}

	/** A delayed best-effort merge-base refresh belongs to exactly one terminal record. */
	async compareAndPutContent(expected: SyncRecord, content: ArrayBuffer): Promise<boolean> {
		const encoded = encodeContent(content);
		return this.helper.runTransaction([STORE_NAME, CONTENT_STORE_NAME], "readwrite", (tx) => {
			const request = tx.objectStore(STORE_NAME).get(expected.remoteIdentityKey);
			let replaced = false;
			request.onsuccess = () => {
				if (!same(request.result, expected)) return;
				tx.objectStore(CONTENT_STORE_NAME).put({
					remoteIdentityKey: expected.remoteIdentityKey, content: encoded,
				});
				replaced = true;
			};
			return () => replaced;
		});
	}

	/** Get prevSyncContent for one remote identity (decompressed via content-codec) */
	async getContent(remoteIdentityKey: string): Promise<ArrayBuffer | undefined> {
		const stored = await this.helper.runTransaction(CONTENT_STORE_NAME, "readonly", (tx) => {
			const req = tx.objectStore(CONTENT_STORE_NAME).get(remoteIdentityKey);
			return () => {
				const result = req.result as { remoteIdentityKey: string; content: ArrayBuffer } | undefined;
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
