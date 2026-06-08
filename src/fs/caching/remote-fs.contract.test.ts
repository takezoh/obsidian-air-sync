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
}

type MockChange =
	| { kind: "upsert"; file: MockFile }
	| { kind: "delete"; id: string };

class MockCache extends AbstractMetadataCache<MockFile> {
	protected extractId(f: MockFile): string { return f.id; }
	protected extractParentIds(f: MockFile): string[] { return [f.parentId]; }
	protected extractName(f: MockFile): string { return f.name; }
	protected isFolderEntry(): boolean { return false; }
	toEntity(path: string, f: MockFile): FileEntity {
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

	stageDelete(path: string): void {
		const entry = [...this.files.values()].find((f) => f.name === path);
		if (!entry) throw new Error(`stageDelete: no such file "${path}"`);
		this.files.delete(entry.id);
		this.events.push({ kind: "delete", id: entry.id });
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
				const { oldPath, newPath } = this.cache.applyFileChangeDetectMove(ch.file);
				if (newPath) changedPaths.add(newPath);
				if (oldPath && newPath && oldPath !== newPath) {
					changedPaths.add(oldPath);
					renamedPaths.push({ oldPath, newPath });
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
		stageRemoteDelete: (path) => remote.stageDelete(path),
	};
}

runCachingRemoteFsContract("MockRemoteFs", makeMockHarness);
