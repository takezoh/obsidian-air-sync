import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { RenamePair, SyncRecord } from "../sync/types";
import type { SyncStateStore } from "../sync/state";
import type { AirSyncSettings } from "../settings";
import { sha256 } from "../utils/hash";
import { normalizeSyncPath, validateRename } from "../utils/path";

/**
 * In-memory mock IFileSystem for unit tests — the single canonical test double.
 *
 * Contract-faithful: paths are normalized, renames validated, reads return
 * copies, and writes/mkdir reject type collisions — exactly as LocalFs /
 * GoogleDriveFs behave. `stat()` computes a real SHA-256 so hash-based decisions
 * are exercised through the pipeline; `list()` keeps `hash: ""` per the
 * IFileSystem contract (list may skip hashing for performance — callers stat()
 * when an accurate hash is needed). The `.files` map is exposed so tests can
 * seed/inspect state directly (e.g. attach a `remoteChecksum`).
 */
export function createMockFs(name: string): IFileSystem & {
	files: Map<string, { content: ArrayBuffer; entity: FileEntity }>;
} {
	const files = new Map<
		string,
		{ content: ArrayBuffer; entity: FileEntity }
	>();

	/** Create each directory along `path`, rejecting any component that is a file. */
	function mkdirInternal(path: string): FileEntity {
		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = files.get(current);
			if (existing && !existing.entity.isDirectory) {
				throw new Error(
					`Cannot create directory "${path}": "${current}" is a file`,
				);
			}
			if (!existing) {
				files.set(current, {
					content: new ArrayBuffer(0),
					entity: {
						path: current,
						isDirectory: true,
						size: 0,
						mtime: 0,
						hash: "",
					},
				});
			}
		}
		return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
	}

	function ensureParents(path: string): void {
		const parent = path.substring(0, path.lastIndexOf("/"));
		if (parent) mkdirInternal(parent);
	}

	return {
		name,
		files,
		list() {
			// Return fresh entities (real backends build a new FileEntity per call);
			// a caller mutating a listing result must not corrupt stored state.
			return Promise.resolve(
				Array.from(files.values()).map((f) => ({ ...f.entity })),
			);
		},
		async stat(path: string) {
			path = normalizeSyncPath(path);
			const entry = files.get(path);
			if (!entry) return null;
			const { entity } = entry;
			// A real file always has a computable hash; fill it on stat(). Preserve
			// any hash a test injected directly onto the stored entity. Always return
			// a fresh object so callers can't mutate the mock's backing store.
			if (!entity.isDirectory && !entity.hash) {
				return { ...entity, hash: await sha256(entry.content) };
			}
			return { ...entity };
		},
		async read(path: string) {
			path = normalizeSyncPath(path);
			const entry = files.get(path);
			if (!entry) throw new Error(`File not found: ${path}`);
			if (entry.entity.isDirectory) {
				throw new Error(`Not a file (is a directory): ${path}`);
			}
			// Stays async so the throws above reject (tests assert .rejects);
			// `await Promise.resolve` satisfies require-await for the sync body.
			return await Promise.resolve(entry.content.slice(0));
		},
		async write(path: string, content: ArrayBuffer, mtime: number) {
			path = normalizeSyncPath(path);
			if (files.get(path)?.entity.isDirectory) {
				throw new Error(
					`Cannot write file: "${path}" is an existing directory`,
				);
			}
			ensureParents(path);
			const entity: FileEntity = {
				path,
				isDirectory: false,
				size: content.byteLength,
				mtime,
				hash: "",
			};
			// Copy on store: real backends persist their own bytes, so a later
			// mutation of the caller's buffer must not change stored content.
			files.set(path, { content: content.slice(0), entity });
			// list() reads the stored entity (hash ""); the return value carries the
			// computed hash, mirroring a real backend's write().
			return { ...entity, hash: await sha256(content) };
		},
		async mkdir(path: string) {
			// Stays async so mkdirInternal's type-collision throw rejects.
			return await Promise.resolve(
				mkdirInternal(normalizeSyncPath(path)),
			);
		},
		listDir(dirPath: string) {
			const prefix = normalizeSyncPath(dirPath) + "/";
			const entities: FileEntity[] = [];
			for (const [p, f] of files) {
				if (
					p.startsWith(prefix) &&
					!p.substring(prefix.length).includes("/")
				) {
					entities.push({ ...f.entity });
				}
			}
			return Promise.resolve(entities);
		},
		delete(path: string) {
			path = normalizeSyncPath(path);
			const prefix = path + "/";
			for (const key of [...files.keys()]) {
				if (key === path || key.startsWith(prefix)) files.delete(key);
			}
			return Promise.resolve();
		},
		async rename(oldPath: string, newPath: string) {
			// Stays async so the validation throws below reject (tests assert .rejects).
			await Promise.resolve();
			oldPath = normalizeSyncPath(oldPath);
			newPath = normalizeSyncPath(newPath);
			validateRename(oldPath, newPath);
			const entry = files.get(oldPath);
			if (!entry) throw new Error(`File not found: ${oldPath}`);
			if (files.has(newPath)) {
				throw new Error(`Destination already exists: ${newPath}`);
			}
			ensureParents(newPath);
			// Move the entry itself
			files.delete(oldPath);
			entry.entity.path = newPath;
			files.set(newPath, entry);
			// Move descendants (folder rename)
			const prefix = oldPath + "/";
			for (const [p, f] of [...files.entries()]) {
				if (p.startsWith(prefix)) {
					const childNewPath =
						newPath + "/" + p.substring(prefix.length);
					files.delete(p);
					f.entity.path = childNewPath;
					files.set(childNewPath, f);
				}
			}
		},
		// A full incremental-checkpoint capability (all-or-nothing — see IFileSystem).
		// Defaults are no-op/empty; individual tests override a method (or delete
		// `checkpoint`) to drive cold-reconcile / commit / reset behaviour.
		checkpoint: {
			getChangedPaths: () =>
				Promise.resolve({
					modified: [] as string[],
					deleted: [] as string[],
				}),
			hasCheckpoint: () => Promise.resolve(true),
			resetCheckpoint: () => Promise.resolve(),
			commitCheckpoint: () => Promise.resolve(),
		},
	};
}

/** In-memory mock SyncStateStore for unit tests */
export function createMockStateStore(): {
	records: Map<string, SyncRecord>;
	contents: Map<string, ArrayBuffer>;
} & SyncStateStore {
	const records = new Map<string, SyncRecord>();
	const contents = new Map<string, ArrayBuffer>();
	return {
		records,
		contents,
		async open() {},
		async close() {},
		get(path: string) {
			return Promise.resolve(records.get(path));
		},
		getMany(paths: string[]) {
			const result = new Map<string, SyncRecord>();
			for (const p of paths) {
				const r = records.get(p);
				if (r !== undefined) result.set(p, r);
			}
			return Promise.resolve(result);
		},
		getAll() {
			return Promise.resolve(Array.from(records.values()));
		},
		put(record: SyncRecord) {
			records.set(record.path, record);
			return Promise.resolve();
		},
		delete(path: string) {
			records.delete(path);
			contents.delete(path);
			return Promise.resolve();
		},
		rewritePaths(renames: RenamePair[]) {
			for (const { oldPath, newPath } of renames) {
				const record = records.get(oldPath);
				if (record) {
					records.delete(oldPath);
					records.set(newPath, {
						...record,
						path: newPath,
						syncedAt: Date.now(),
					});
				}
				const content = contents.get(oldPath);
				if (content) {
					contents.delete(oldPath);
					contents.set(newPath, content);
				}
			}
			return Promise.resolve();
		},
		clear() {
			records.clear();
			contents.clear();
			return Promise.resolve();
		},
		putContent(path: string, content: ArrayBuffer) {
			contents.set(path, content);
			return Promise.resolve();
		},
		getContent(path: string) {
			return Promise.resolve(contents.get(path));
		},
	} as unknown as {
		records: Map<string, SyncRecord>;
		contents: Map<string, ArrayBuffer>;
	} & SyncStateStore;
}

/** Create a FileEntity + ArrayBuffer pair from text content */
export function makeFile(
	path: string,
	content: string,
	mtime = 1000,
): { entity: FileEntity; content: ArrayBuffer } {
	const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
	return {
		entity: {
			path,
			isDirectory: false,
			size: buf.byteLength,
			mtime,
			hash: "",
		},
		content: buf,
	};
}

/** Add a file to a mock FS and return its entity */
export function addFile(
	fs: ReturnType<typeof createMockFs>,
	path: string,
	text: string,
	mtime = 1000,
): FileEntity {
	// Seed under the same canonical key the FS methods look up by, so a
	// non-normalized path (e.g. "/a.md") can't become invisible to stat()/read().
	path = normalizeSyncPath(path);
	const buf = new TextEncoder().encode(text).buffer as ArrayBuffer;
	// Ensure parent directories exist
	const parentPath = path.substring(0, path.lastIndexOf("/"));
	if (parentPath) {
		const parts = parentPath.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!fs.files.has(current)) {
				const dirEntity: FileEntity = {
					path: current,
					isDirectory: true,
					size: 0,
					mtime: 0,
					hash: "",
				};
				fs.files.set(current, {
					content: new ArrayBuffer(0),
					entity: dirEntity,
				});
			}
		}
	}
	const entity: FileEntity = {
		path,
		isDirectory: false,
		size: buf.byteLength,
		mtime,
		hash: "",
	};
	fs.files.set(path, { content: buf, entity });
	return entity;
}

/** Read a file from a mock FS as a string */
export function readText(
	fs: ReturnType<typeof createMockFs>,
	path: string,
): string {
	const entry = fs.files.get(path);
	if (!entry) throw new Error(`Not found: ${path}`);
	return new TextDecoder().decode(entry.content);
}

/**
 * A complete, type-checked `AirSyncSettings` for tests. Typed so that adding a
 * required settings field breaks compilation here (and at every call site)
 * rather than silently drifting. Override any field via `overrides`.
 */
export function mockSettings(
	overrides: Partial<AirSyncSettings> = {},
): AirSyncSettings {
	return {
		vaultId: "test-vault",
		backendType: "test",
		conflictStrategy: "auto_merge",
		ignorePatterns: [],
		syncDotPaths: [],
		// Mirror production DEFAULT_SETTINGS for behaviour-affecting flags so tests
		// don't run under a configuration real users never have.
		enableThreeWayMerge: true,
		mobileMaxFileSizeMB: 10,
		screenWakeLockOnSync: false,
		showSyncNotifications: false,
		enableLogging: false,
		logLevel: "info",
		backendData: {},
		lastSyncedIdentity: "",
		...overrides,
	};
}
