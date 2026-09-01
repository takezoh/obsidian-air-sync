import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { FileEntity } from "../types";
import type { RenamePair } from "../types";
import { MetadataStore } from "../../store/metadata-store";
import { AbstractMetadataCache } from "./metadata-cache";
import { CachingRemoteFs } from "./remote-fs";
import type { IncrementalChangesResult } from "./remote-fs";
import { runCachingRemoteFsContract } from "../contracts/caching-remote-fs.contract";
import type { CachingRemoteFsHarness } from "../contracts/caching-remote-fs.contract";
import { resolveDetachedIdPath } from "../priority-observation";

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
		const pathAuthority = this.getPathAuthority(path);
		if (f.isFolder) return { path, pathAuthority, identityKey: f.id, isDirectory: true, size: 0, mtime: 0, hash: "" };
		return { path, pathAuthority, identityKey: f.id, isDirectory: false, size: 0, mtime: 0, hash: "", remoteChecksum: { algo: "opaque", value: f.checksum } };
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
	getById(id: string): MockFile | null { return this.files.get(id) ?? null; }
	getByPath(path: string): MockFile[] {
		const resolve = (file: MockFile): string | null => {
			const parts = [file.name];
			let parentId = file.parentId;
			const seen = new Set<string>([file.id]);
			while (parentId !== this.rootId) {
				if (seen.has(parentId)) return null;
				seen.add(parentId);
				const parent = this.files.get(parentId);
				if (!parent?.isFolder) return null;
				parts.unshift(parent.name);
				parentId = parent.parentId;
			}
			return parts.join("/");
		};
		return [...this.files.values()].filter((file) => resolve(file) === path);
	}

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

	protected fetchCurrentFile(fileId: string): Promise<MockFile | null> {
		return Promise.resolve(this.remote.getById(fileId));
	}
	protected fetchCurrentPath(path: string): Promise<MockFile[]> {
		return Promise.resolve(this.remote.getByPath(path));
	}
	protected resolveDetachedPath(file: MockFile): Promise<string | null> {
		return resolveDetachedIdPath(file, this.remote.rootId, (id) => this.fetchCurrentFile(id), {
			id: (entry) => entry.id,
			name: (entry) => entry.name,
			parents: (entry) => [entry.parentId],
			isFolder: (entry) => !!entry.isFolder,
		});
	}
	protected toDetachedEntity(path: string, file: MockFile): FileEntity {
		return {
			path, pathAuthority: "actual_resolved", identityKey: file.id,
			isDirectory: !!file.isFolder, size: 0, mtime: 0, hash: "",
			remoteChecksum: file.isFolder ? undefined : { algo: "opaque", value: file.checksum },
		};
	}
	protected detachedVersionToken(file: MockFile): string | null {
		return file.isFolder || !file.checksum ? null : `mock:${file.checksum}`;
	}

	protected downloadFile(fileId: string): Promise<ArrayBuffer> {
		const file = this.remote.getById(fileId);
		return Promise.resolve(new TextEncoder().encode(file?.checksum ?? "").buffer);
	}
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

describe("MockRemoteFs incremental authority persistence", () => {
	it("observes an identity without initializing or advancing shared cache state", async () => {
		const remote = new FakeRemote();
		remote.seed("note.md");
		const store = new MetadataStore<MockFile>("detached-priority", {
			dbNamePrefix: "air-sync-mock", version: 1,
		});
		const fs = new MockRemoteFs(remote, store);

		const observed = await fs.priority.observe({ path: "note.md", identityKey: "id1" });
		expect(observed).toMatchObject({ kind: "current", identityKey: "id1" });
		if (observed.kind !== "current") throw new Error("expected current priority observation");
		expect(await fs.priority.read(observed)).toMatchObject({ kind: "content" });
		expect(await fs.hasCheckpoint()).toBe(false);
		await fs.close();
	});
	it("rejects a duplicate-identity checkpoint before sync chooses WARM", async () => {
		const remote = new FakeRemote();
		remote.seed("c.md");
		const [file] = remote.list();
		const store = new MetadataStore<MockFile>("duplicate-identity-checkpoint", {
			dbNamePrefix: "air-sync-mock",
			version: 1,
		});
		await store.open();
		await store.saveAll([
			{ path: "C.md", file: file!, isFolder: false },
			{ path: "c.md", file: file!, isFolder: false },
		], new Map([["changesStartPageToken", "c0"]]));

		const fs = new MockRemoteFs(remote, store);

		// A cursor cannot make a malformed file map a usable checkpoint. Returning
		// true here makes the orchestrator choose WARM; the later recovery scan then
		// looks like an empty delta and a pending case-only rename is silently skipped.
		expect(await fs.hasCheckpoint()).toBe(false);
		expect((await fs.list()).map((entry) => entry.path)).toEqual(["c.md"]);

		await fs.close();
	});

	it("restores a child's own authority after its unresolved parent is confirmed", async () => {
		const remote = new FakeRemote();
		remote.seedFolderWithChild("Docs", "a.md");
		const [folder, child] = remote.list();
		const store = new MetadataStore<MockFile>("authority-restart", {
			dbNamePrefix: "air-sync-mock", version: 1,
		});
		await store.open();
		await store.saveAll([
			{ path: "Docs", file: folder!, isFolder: true, pathAuthority: "requested_echo" },
			{ path: "Docs/a.md", file: child!, isFolder: false, pathAuthority: "actual_resolved" },
		], new Map([["changesStartPageToken", "c0"]]));

		remote.stageRename("a.md", "a.md");
		const first = new MockRemoteFs(remote, store);
		await first.getChangedPaths();
		expect((await first.stat("Docs/a.md"))?.pathAuthority).toBe("requested_echo");
		await first.commitCheckpoint();
		await first.close();

		remote.stageRename("Docs", "Docs", { isFolder: true });
		const restarted = new MockRemoteFs(remote, store);
		await restarted.getChangedPaths();

		expect((await restarted.stat("Docs/a.md"))?.pathAuthority).toBe("actual_resolved");
		await restarted.close();
	});
});
