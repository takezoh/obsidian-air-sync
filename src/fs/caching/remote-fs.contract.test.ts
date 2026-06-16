import "fake-indexeddb/auto";
import type { FileEntity } from "../types";
import type { RenamePair } from "../types";
import { MetadataStore } from "../../store/metadata-store";
import { AbstractMetadataCache } from "./metadata-cache";
import { CachingRemoteFs } from "./remote-fs";
import type { IncrementalChangesResult } from "./remote-fs";
import { runCachingRemoteFsContract } from "./remote-fs-contract";
import type { CachingRemoteFsHarness } from "./remote-fs-contract";

// A minimal id-addressed backend over an in-memory remote. It exists only to drive
// the shared crash-safety contract against the base machinery — proving the base is
// correct independent of Google Drive (and serving as the template a real backend
// follows to run runCachingRemoteFsContract in one line).

interface MockFile {
	id: string;
	name: string;
	parentId: string;
	checksum: string;
	isFolder?: boolean;
}

type MockChange =
	| { kind: "upsert"; file: MockFile }
	| { kind: "delete"; id: string };

class MockCache extends AbstractMetadataCache<MockFile> {
	protected extractId(f: MockFile): string { return f.id; }
	protected extractParentIds(f: MockFile): string[] { return [f.parentId]; }
	protected extractName(f: MockFile): string { return f.name; }
	protected isFolderEntry(f: MockFile): boolean { return !!f.isFolder; }
	toEntity(path: string, f: MockFile): FileEntity {
		if (f.isFolder) return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
		return { path, isDirectory: false, size: 0, mtime: 0, hash: "", remoteChecksum: { algo: "opaque", value: f.checksum } };
	}
}

/** In-memory remote: a flat file set plus an append-only delta log keyed by cursor. */
class FakeRemote {
	readonly rootId = "root";
	private files = new Map<string, MockFile>();
	private events: MockChange[] = [];
	private idSeq = 0;

	/** Current head cursor — "cN" means N events have happened. */
	head(): string { return `c${this.events.length}`; }
	list(): MockFile[] { return [...this.files.values()]; }

	/** Baseline file (no delta event) — part of the next full list. */
	seed(path: string): void {
		const id = `id${++this.idSeq}`;
		this.files.set(id, { id, name: path, parentId: this.rootId, checksum: `v-${id}` });
	}

	/** Baseline folder + one child (no delta event) — part of the next full list. */
	seedFolderWithChild(folderPath: string, childName: string): void {
		const folderId = `id${++this.idSeq}`;
		const childId = `id${++this.idSeq}`;
		this.files.set(folderId, { id: folderId, name: folderPath, parentId: this.rootId, checksum: `v-${folderId}`, isFolder: true });
		this.files.set(childId, { id: childId, name: childName, parentId: folderId, checksum: `v-${childId}` });
	}

	stageDelete(path: string): void {
		const entry = [...this.files.values()].find((f) => f.name === path);
		if (!entry) throw new Error(`stageDelete: no such file "${path}"`);
		this.files.delete(entry.id);
		this.events.push({ kind: "delete", id: entry.id });
	}

	// Id-addressed: a rename is a SINGLE upsert carrying the new name. A folder's children
	// keep their parentId (paths are derived), so only the folder is re-emitted — the cache
	// reparents the subtree. Order-independent by construction (no path-keyed tombstone).
	stageRename(oldPath: string, newPath: string, opts?: { isFolder?: boolean }): void {
		const match = opts?.isFolder
			? (f: MockFile) => f.name === oldPath && !!f.isFolder
			: (f: MockFile) => f.name === oldPath;
		const entry = [...this.files.values()].find(match);
		if (!entry) throw new Error(`stageRename: no such path "${oldPath}"`);
		const renamed: MockFile = { ...entry, name: newPath };
		this.files.set(entry.id, renamed);
		this.events.push({ kind: "upsert", file: renamed });
	}

	changesSince(cursor: string): { changes: MockChange[]; newCursor: string } {
		const from = cursor.startsWith("c") ? Number(cursor.slice(1)) : 0;
		return { changes: this.events.slice(from), newCursor: this.head() };
	}
}

class MockRemoteFs extends CachingRemoteFs<MockFile> {
	readonly name = "mock";

	constructor(private remote: FakeRemote, store: MetadataStore<MockFile>) {
		super(remote.rootId, new MockCache(remote.rootId), store);
	}

	protected getStartCursor(): Promise<string> { return Promise.resolve(this.remote.head()); }
	protected fullList(): Promise<MockFile[]> { return Promise.resolve(this.remote.list()); }
	protected assertRootAlive(): Promise<void> { return Promise.resolve(); }

	protected fetchChanges(cursor: string): Promise<IncrementalChangesResult> {
		const { changes, newCursor } = this.remote.changesSince(cursor);
		const changedPaths = new Set<string>();
		const renamedPaths: RenamePair[] = [];
		for (const ch of changes) {
			if (ch.kind === "delete") {
				const path = this.cache.getPathById(ch.id);
				if (path) {
					for (const d of this.cache.collectDescendants(path)) changedPaths.add(d);
					changedPaths.add(path);
					this.cache.removeTree(path);
				}
			} else {
				const { oldPath, newPath, wasFolder, oldDescendants } = this.cache.applyFileChangeDetectMove(ch.file);
				if (newPath) changedPaths.add(newPath);
				if (oldPath && newPath && oldPath !== newPath) {
					changedPaths.add(oldPath);
					for (const d of oldDescendants) changedPaths.add(d);
					renamedPaths.push({ oldPath, newPath, isFolder: wasFolder || undefined });
					if (wasFolder) for (const nd of this.cache.collectDescendants(newPath)) changedPaths.add(nd);
				}
			}
		}
		return Promise.resolve({ needsFullScan: false, newToken: newCursor, changedPaths, renamedPaths });
	}

	protected downloadFile(): Promise<ArrayBuffer> { return Promise.resolve(new ArrayBuffer(0)); }
	protected deleteRemote(): Promise<void> { return Promise.resolve(); }

	write(): Promise<FileEntity> { throw new Error("mock: write not implemented"); }
	mkdir(): Promise<FileEntity> { throw new Error("mock: mkdir not implemented"); }
	rename(): Promise<void> { throw new Error("mock: rename not implemented"); }
}

function makeMockHarness(): CachingRemoteFsHarness<MockFile> {
	const remote = new FakeRemote();
	return {
		makeStore: (id) => new MetadataStore<MockFile>(id, { dbNamePrefix: "air-sync-mock", version: 1 }),
		makeFs: (store) => new MockRemoteFs(remote, store),
		seedFile: (path) => remote.seed(path),
		seedFolderWithChild: (folderPath, childName) => remote.seedFolderWithChild(folderPath, childName),
		stageRemoteDelete: (path) => remote.stageDelete(path),
		stageRemoteRename: (oldPath, newPath, opts) => remote.stageRename(oldPath, newPath, opts),
	};
}

runCachingRemoteFsContract("MockRemoteFs", makeMockHarness);
