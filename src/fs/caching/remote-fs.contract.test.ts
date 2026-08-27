import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { FileEntity } from "../types";
import type { RenamePair } from "../types";
import { MetadataStore } from "../../store/metadata-store";
import { AbstractMetadataCache } from "./metadata-cache";
import { CachingRemoteFs } from "./remote-fs";
import type { IncrementalChangesResult } from "./remote-delta";
import { runCachingRemoteFsContract } from "./remote-fs-contract.test";
import type { CachingRemoteFsHarness } from "./remote-fs-contract.test";
import { createMockLocalFs } from "../../__mocks__/sync-test-helpers";
import { DEFAULT_SETTINGS } from "../../settings";
import { LocalChangeTracker } from "../../sync/local-tracker";
import { SyncOrchestrator } from "../../sync/orchestrator";
import { SyncScheduler } from "../../sync/scheduler";
import type { SyncSchedulerDeps } from "../../sync/scheduler";
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
	mtime?: number;
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
		if (f.isFolder) return { path, pathAuthority, isDirectory: true, size: 0, mtime: 0, hash: "" };
		return {
			path, pathAuthority, identityKey: f.id, isDirectory: false,
			size: new TextEncoder().encode(f.checksum).byteLength,
			mtime: f.mtime ?? 0,
			hash: "",
			remoteChecksum: { algo: "opaque", value: f.checksum },
		};
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
		const resolvePath = (file: MockFile): string | null => {
			const segments = [file.name];
			let parentId = file.parentId;
			const visited = new Set<string>([file.id]);
			while (parentId !== this.rootId) {
				if (visited.has(parentId)) return null;
				visited.add(parentId);
				const parent = this.files.get(parentId);
				if (!parent?.isFolder) return null;
				segments.unshift(parent.name);
				parentId = parent.parentId;
			}
			return segments.join("/");
		};
		return [...this.files.values()].filter((file) => resolvePath(file) === path);
	}

	/** Baseline file (no delta event) — part of the next full list. */
	seed(path: string): void {
		const id = `id${++this.idSeq}`;
		this.files.set(id, { id, name: path, parentId: this.rootId, checksum: `v-${id}`, mtime: 1000 });
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

	stageModify(path: string): void {
		const entry = [...this.files.values()].find((f) => f.name === path);
		if (!entry) throw new Error(`stageModify: no such file "${path}"`);
		const modified = { ...entry, checksum: `${entry.checksum}-next`, mtime: (entry.mtime ?? 0) + 1000 };
		this.files.set(entry.id, modified);
		this.events.push({ kind: "upsert", file: modified });
	}

	stageReplace(path: string): void {
		const entry = [...this.files.values()].find((f) => f.name === path);
		if (!entry) throw new Error(`stageReplace: no such file "${path}"`);
		this.files.delete(entry.id);
		this.events.push({ kind: "delete", id: entry.id });
		const id = `id${++this.idSeq}`;
		const replacement = {
			...entry,
			id,
			checksum: `${entry.checksum}-replacement`,
			mtime: (entry.mtime ?? 0) + 1000,
		};
		this.files.set(id, replacement);
		this.events.push({ kind: "upsert", file: replacement });
	}

	contentAt(path: string): string {
		const entry = [...this.files.values()].find((f) => f.name === path);
		if (!entry) throw new Error(`contentAt: no such file "${path}"`);
		return entry.checksum;
	}

	download(id: string): ArrayBuffer {
		const entry = this.files.get(id);
		if (!entry) throw new Error(`download: no such id "${id}"`);
		return new TextEncoder().encode(entry.checksum).buffer;
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
			path,
			pathAuthority: "actual_resolved",
			identityKey: file.id,
			isDirectory: !!file.isFolder,
			size: file.isFolder ? 0 : new TextEncoder().encode(file.checksum).byteLength,
			mtime: file.mtime ?? 0,
			hash: "",
			remoteChecksum: file.isFolder ? undefined : { algo: "opaque", value: file.checksum },
			backendMeta: { version: file.checksum },
		};
	}
	protected detachedVersionToken(file: MockFile): string | null {
		return file.isFolder || !file.checksum ? null : `mock:${file.checksum}`;
	}

	protected downloadFile(fileId: string): Promise<ArrayBuffer> {
		return Promise.resolve(this.remote.download(fileId));
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
	it("replays the complete uncommitted delta without another provider call", async () => {
		const remote = new FakeRemote();
		remote.seed("target.md");
		remote.seed("sibling.md");
		const changesSince = vi.spyOn(remote, "changesSince");
		const store = new MetadataStore<MockFile>("same-session-incomplete-replay", {
			dbNamePrefix: "air-sync-mock", version: 1,
		});
		const fs = new MockRemoteFs(remote, store);
		await fs.list();
		await fs.commitCheckpoint();
		remote.stageModify("target.md");
		remote.stageModify("sibling.md");

		const first = await fs.getChangedPaths();
		const replay = await fs.getChangedPaths();

		expect(first).toEqual({
			modified: ["target.md", "sibling.md"], deleted: [], renamed: [],
		});
		expect(replay).toEqual(first);
		expect(changesSince).toHaveBeenCalledTimes(1);

		await fs.commitCheckpoint();
		expect(await fs.getChangedPaths()).toEqual({ modified: [], deleted: [], renamed: [] });
		expect(changesSince).toHaveBeenCalledTimes(2);
		await fs.close();
	});

	it("does not turn a targeted probe without a committed cache into a full scan", async () => {
		const remote = new FakeRemote();
		remote.seed("note.md");
		const fullList = vi.spyOn(remote, "list");
		const store = new MetadataStore<MockFile>("targeted-freshness-no-checkpoint", {
			dbNamePrefix: "air-sync-mock", version: 1,
		});
		const fs = new MockRemoteFs(remote, store);

		expect(await fs.priority.observe({ path: "note.md", identityKey: "id1" })).toMatchObject({
			kind: "current",
			identityKey: "id1",
		});
		expect(fullList).not.toHaveBeenCalled();
		await fs.close();
	});

	it("refreshes one cached identity without consuming the global delta", async () => {
		const remote = new FakeRemote();
		remote.seed("note.md");
		remote.seed("other.md");
		const store = new MetadataStore<MockFile>("targeted-freshness-cursor", {
			dbNamePrefix: "air-sync-mock", version: 1,
		});
		const fs = new MockRemoteFs(remote, store);
		await fs.list();
		remote.stageModify("note.md");
		remote.stageModify("other.md");

		const fresh = await fs.priority.observe({ path: "note.md", identityKey: "id1" });

		expect(fresh.kind === "current" ? fresh.entity.remoteChecksum?.value : undefined)
			.toBe(remote.contentAt("note.md"));
		expect(await fs.getChangedPaths()).toEqual({
			modified: ["note.md", "other.md"],
			deleted: [],
			renamed: [],
		});
		await fs.close();
	});

	it.each(["rename", "delete", "replace"] as const)(
		"does not admit a targeted %s as the opened path",
		async (change) => {
			const remote = new FakeRemote();
			remote.seed("note.md");
			const store = new MetadataStore<MockFile>(`targeted-freshness-${change}`, {
				dbNamePrefix: "air-sync-mock", version: 1,
			});
			const fs = new MockRemoteFs(remote, store);
			await fs.list();
			if (change === "rename") remote.stageRename("note.md", "moved.md");
			else if (change === "delete") remote.stageDelete("note.md");
			else remote.stageReplace("note.md");

			const observed = await fs.priority.observe({ path: "note.md", identityKey: "id1" });
			expect(observed.kind).toBe(change === "delete" ? "missing" : "structural");
			expect((await fs.stat("note.md"))?.path).toBe("note.md");
			await fs.close();
		},
	);

	it("preserves an unopened path for normal sync after a file-open freshness probe", async () => {
		const remote = new FakeRemote();
		remote.seed("note.md");
		remote.seed("other.md");
		const store = new MetadataStore<MockFile>("file-open-multi-path-delta", {
			dbNamePrefix: "air-sync-mock", version: 1,
		});
		const remoteFs = new MockRemoteFs(remote, store);
		const localFs = createMockLocalFs();
		const localTracker = new LocalChangeTracker();
		const settings = {
			...DEFAULT_SETTINGS,
			vaultId: "file-open-multi-path-delta",
			backendType: "test",
		};
		const orchestrator = new SyncOrchestrator({
			getSettings: () => settings,
			saveSettings: () => Promise.resolve(),
			configDir: () => ".config-test",
			pluginId: () => "air-sync",
			localFs: () => localFs,
			remoteFs: () => remoteFs,
			backendProvider: () => null,
			onStatusChange: () => {},
			onProgress: () => {},
			notify: () => {},
			isMobile: () => false,
			isLayoutReady: () => true,
			localTracker,
		});
		await orchestrator.runSync();
		const localWrite = vi.spyOn(localFs, "write");

		remote.stageModify("note.md");
		remote.stageModify("other.md");

		const workspaceHandlers = new Map<
			string,
			(file: { path: string } | null) => Promise<void> | void
		>();
		const scheduler = new SyncScheduler({
			workspace: {
				layoutReady: true,
				on: (name: string, handler: (file: { path: string } | null) => Promise<void> | void) => {
					workspaceHandlers.set(name, handler);
					return {};
				},
				onLayoutReady: (callback: () => void) => callback(),
			} as unknown as SyncSchedulerDeps["workspace"],
			vault: { on: () => ({}) } as unknown as SyncSchedulerDeps["vault"],
			localFs: () => localFs,
			remoteFs: () => remoteFs,
			stateStore: orchestrator.state,
			localTracker,
			orchestrator,
			isExcluded: (path) => orchestrator.isExcluded(path),
			registerEvent: () => {},
			registerWindowEvent: () => {},
			registerDocumentEvent: () => {},
		});
		scheduler.start();

		await workspaceHandlers.get("file-open")!({ path: "note.md" });
		const openedPathFresh =
			new TextDecoder().decode(await localFs.read("note.md")) === remote.contentAt("note.md");
		const openedRecord = await orchestrator.state.get("note.md");
		expect(openedRecord?.remoteChecksum?.value).toBe(remote.contentAt("note.md"));

		// A naive fix that consumes the global delta for note.md reaches this point but
		// leaves the live cursor past other.md. The real normal lifecycle must still pull it.
		await orchestrator.runSync();
		const unopenedPathPreserved =
			new TextDecoder().decode(await localFs.read("other.md")) === remote.contentAt("other.md");
		expect({ openedPathFresh, unopenedPathPreserved }).toEqual({
			openedPathFresh: true,
			unopenedPathPreserved: true,
		});
		expect(localWrite.mock.calls.map(([path]) => path)).toEqual(["note.md", "other.md"]);
		scheduler.destroy();
		await orchestrator.close();
		await remoteFs.close();
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
