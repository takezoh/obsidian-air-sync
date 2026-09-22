import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { FileEntity } from "../types";
import { MetadataStore } from "../../store/metadata-store";
import { AbstractMetadataCache } from "./metadata-cache";
import { CachingRemoteFs } from "./remote-fs";
import { applyIdDeltaPage, createIdDeltaResult } from "./id-delta";
import type { IncrementalChangesResult, RemoteDelta } from "./remote-fs";
import { runCachingRemoteFsContract } from "../../../tests/fs/contracts/caching-remote-fs.contract";
import type { CachingRemoteFsHarness } from "../../../tests/fs/contracts/caching-remote-fs.contract";
import { resolveDetachedIdPath } from "../priority-observation";
import type { RemoteObject } from "../../backend-api";
import { NormalizedMetadataCache } from "../managed/normalized-metadata-cache";

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
	/** Folder path → its subtree, outside the bound root until it is moved in. */
	private pendingOutside = new Map<string, MockFile[]>();
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

	/**
	 * Baseline object with ids and parentage spelled out — part of the next full
	 * list, no delta event. `seed`/`seedFolderWithChild` generate both for the
	 * shared contract; a contention fixture has to name them, because WHICH id wins
	 * a contended address is the thing under test.
	 */
	seedRaw(file: MockFile): void {
		this.files.set(file.id, file);
	}

	/** The same named object, arriving through the DELTA rather than the baseline. */
	stageRaw(file: MockFile): void {
		this.files.set(file.id, file);
		this.events.push({ kind: "upsert", file });
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

	/**
	 * A folder + `a.md` + `sub/b.md` held OUTSIDE the bound root: absent from `list()`
	 * and from the delta log until {@link stageMoveIntoRoot} moves it in. The mock has no
	 * provider to probe, and its base-machinery delta carries no per-backend re-listing
	 * seam, so the move emits the COMPLETE shape (folder then every descendant) — the
	 * facts the base itself must be able to serve. Google Drive's folder-only delta and
	 * the re-listing that completes it are that backend's own harness's business.
	 */
	seedFolderOutsideRoot(folderPath: string): void {
		const folderId = `id${++this.idSeq}`;
		const subId = `id${++this.idSeq}`;
		const aId = `id${++this.idSeq}`;
		const bId = `id${++this.idSeq}`;
		this.pendingOutside.set(folderPath, [
			{ id: folderId, name: folderPath, parentId: this.rootId, checksum: `v-${folderId}`, isFolder: true },
			{ id: aId, name: "a.md", parentId: folderId, checksum: `v-${aId}` },
			{ id: subId, name: "sub", parentId: folderId, checksum: `v-${subId}`, isFolder: true },
			{ id: bId, name: "b.md", parentId: subId, checksum: `v-${bId}` },
		]);
	}

	stageMoveIntoRoot(folderPath: string): void {
		const seeded = this.pendingOutside.get(folderPath);
		if (!seeded) throw new Error(`stageMoveIntoRoot: no folder seeded outside the root at "${folderPath}"`);
		this.pendingOutside.delete(folderPath);
		for (const file of seeded) {
			this.files.set(file.id, file);
			this.events.push({ kind: "upsert", file });
		}
	}

	/** Delete one object by its id — the only way to name one of two same-named folders. */
	stageDeleteById(id: string): void {
		if (!this.files.delete(id)) throw new Error(`stageDeleteById: no such id "${id}"`);
		this.events.push({ kind: "delete", id });
	}

	/** Rename one object by its id, leaving its parent where it is. */
	stageRenameById(id: string, name: string): void {
		const entry = this.files.get(id);
		if (!entry) throw new Error(`stageRenameById: no such id "${id}"`);
		const renamed: MockFile = { ...entry, name };
		this.files.set(id, renamed);
		this.events.push({ kind: "upsert", file: renamed });
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
	private failAfterFirstChange = false;
	private expireCursorOnce = false;

	constructor(private remote: FakeRemote, store: MetadataStore<MockFile>) {
		super(remote.rootId, new MockCache(remote.rootId), store);
	}

	protected getStartCursor(): Promise<string> { return Promise.resolve(this.remote.head()); }
	protected fullList(): Promise<MockFile[]> { return Promise.resolve(this.remote.list()); }
	protected assertRootAlive(): Promise<void> { return Promise.resolve(); }
	requestLaterPageFailure(): void { this.failAfterFirstChange = true; }
	/** Answer the next delta the way an expired cursor does (Google Drive's 410). */
	requestCursorExpiry(): void { this.expireCursorOnce = true; }

	protected fetchChanges(cursor: string): Promise<IncrementalChangesResult> {
		if (this.expireCursorOnce) {
			this.expireCursorOnce = false;
			return Promise.resolve({ needsFullScan: true, changedPaths: new Set<string>() });
		}
		const { changes, newCursor } = this.remote.changesSince(cursor);
		// The production applier, not a copy of it: what this harness pins is the
		// shared cache and delta contract every id-addressed backend runs. Each change
		// is its own page, which keeps the provider's event order and lets a later page
		// fail after an earlier one was applied.
		const acc = createIdDeltaResult();
		for (const [index, ch] of changes.entries()) {
			applyIdDeltaPage(this.cache, acc, [ch.kind === "delete"
				? { id: ch.id, isFolder: false, file: undefined }
				: { id: ch.file.id, isFolder: !!ch.file.isFolder, file: ch.file }]);
			if (index === 0 && this.failAfterFirstChange) {
				this.failAfterFirstChange = false;
				throw new Error("injected later page failure");
			}
		}
		return Promise.resolve({
			needsFullScan: false, newToken: newCursor, changedPaths: acc.changedPaths,
			renamedPaths: acc.renamedPaths, contended: acc.displacements,
		});
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
	let fs: MockRemoteFs | null = null;
	return {
		makeStore: (id) => new MetadataStore<MockFile>(id, { dbNamePrefix: "air-sync-mock", version: 1 }),
		makeFs: (store) => {
			fs = new MockRemoteFs(remote, store);
			return fs;
		},
		seedFile: (path) => remote.seed(path),
		seedFolderWithChild: (folderPath, childName) => remote.seedFolderWithChild(folderPath, childName),
		stageRemoteDelete: (path) => remote.stageDelete(path),
		failNextDeltaAfterFirstPage: () => fs?.requestLaterPageFailure(),
		stageRemoteRename: (oldPath, newPath, opts) => remote.stageRename(oldPath, newPath, opts),
		seedFolderOutsideRoot: (folderPath) => remote.seedFolderOutsideRoot(folderPath),
		stageMoveIntoRoot: (folderPath) => remote.stageMoveIntoRoot(folderPath),
		// The base machinery's own answer, independent of any provider: this double is
		// id-addressed with derived paths, so two live ids compose one address whenever
		// two objects share a name under one parent. `alsoParentedBy` is ignored — the
		// double is single-parent, which is the shape every non-Drive family has.
		collision: {
			kind: "stages",
			stage: (claimants, route) => {
				if (route === "expired") fs?.requestCursorExpiry();
				for (const claimant of claimants) {
					const file: MockFile = {
						id: claimant.id,
						name: claimant.name,
						// An orphan's parent is one nothing in the listing names, so the
						// path resolver falls back to its bare name and its spelling
						// stays a guess.
						parentId: claimant.orphaned ? "vanished" : claimant.parentId ?? remote.rootId,
						checksum: `v-${claimant.id}`,
						isFolder: claimant.isFolder,
					};
					if (route === "delta") remote.stageRaw(file);
					else remote.seedRaw(file);
				}
			},
		},
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

// ─────────────────────────────────────────────────────────────────────────────
// The identity a rename pair carries is the ENTITY PROJECTION's, never the cache's
// internal address. `NormalizedMetadataCache.extractId` is `RemoteObject.id`, and the
// pair producer must carry that same projection. The legacy per-backend cache that once
// made the two functions differ (Dropbox's `entry.id ?? entry.path_lower`) is gone: the
// normalized object's id is required, so an "address without identity" shape does not
// exist on the managed path.
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal full-scan-only FS over the normalized cache: every delta expires, forcing diffById. */
class NormalizedFullScanFs extends CachingRemoteFs<RemoteObject> {
	readonly name = "normalized-full-scan";
	private staged: RemoteObject[] = [];

	constructor() {
		super("root", new NormalizedMetadataCache("root"));
	}

	/** Replace what the next full list returns. */
	stage(entries: RemoteObject[]): void { this.staged = entries; }

	protected getStartCursor(): Promise<string> { return Promise.resolve("cursor"); }
	protected fullList(): Promise<RemoteObject[]> { return Promise.resolve(this.staged); }
	protected assertRootAlive(): Promise<void> { return Promise.resolve(); }
	/** Always expired ⇒ the cursor-expiry fallback (full scan + diffById) runs. */
	protected fetchChanges(): Promise<IncrementalChangesResult> {
		return Promise.resolve({ needsFullScan: true, changedPaths: new Set<string>() });
	}

	protected downloadFile(): Promise<ArrayBuffer> { throw new Error("not implemented"); }
	protected deleteRemote(): Promise<void> { throw new Error("not implemented"); }
	protected fetchCurrentFile(): Promise<RemoteObject | null> { throw new Error("not implemented"); }
	protected fetchCurrentPath(): Promise<RemoteObject[] | null> { throw new Error("not implemented"); }
	protected resolveDetachedPath(): Promise<string | null> { throw new Error("not implemented"); }
	protected toDetachedEntity(): FileEntity { throw new Error("not implemented"); }
	protected detachedVersionToken(): string | null { throw new Error("not implemented"); }
	write(): Promise<FileEntity> { throw new Error("not implemented"); }
	mkdir(): Promise<FileEntity> { throw new Error("not implemented"); }
	rename(): Promise<void> { throw new Error("not implemented"); }
}

function normalizedRootFile(id: string, name: string): RemoteObject {
	return { kind: "file", id, name, location: { addressing: "parent_id", parentId: null } };
}

describe("diffById identity source", () => {
	it("carries the projected identity for a case-only rename", async () => {
		const fs = new NormalizedFullScanFs();
		fs.stage([normalizedRootFile("id:7", "Note.md")]);
		expect(await fs.getChangedPaths()).toBeNull(); // initial full scan captures "now"

		// Case-only rename: name (the derived path segment) changes, id does not.
		fs.stage([normalizedRootFile("id:7", "note.md")]);
		const delta = await fs.getChangedPaths();

		expect(delta?.renamed).toEqual([
			{ oldPath: "Note.md", newPath: "note.md", isFolder: undefined, identityKey: "id:7" },
		]);
		// …and it matches the entity projection the public surface reports.
		expect(delta?.renamed?.[0]?.identityKey).toBe((await fs.stat("note.md"))?.identityKey);
	});
});

/**
 * The three producers of `RemoteDelta.deleted`, enumerated completely, and the one
 * attribution rule all three obey.
 *
 *  1. `_applyIncrementalChanges`' `hasFile` split over a drain's changed paths.
 *  2. `diffById`'s vanished-id sweep — the route a cursor expiry takes, and the one
 *     measured to reach `delete_local`.
 *  3. `id-delta.ts`'s "old path and no new path" branch, which decides its own half
 *     (it separates a genuine move out of the tracked root from a displacement) and
 *     feeds what is left into producer 1, so the carrier below is what closes it.
 *
 * A path whose absence is attributable to a contention decided this cycle is
 * excluded at all three. An absence that cannot be attributed is classified exactly
 * as it always was — which is a deletion.
 */
describe("the three producers of RemoteDelta.deleted", () => {
	let dbSeq = 0;
	function makeStore(): MetadataStore<MockFile> {
		return new MetadataStore<MockFile>(`absence-authority-${++dbSeq}`, {
			dbNamePrefix: "air-sync-mock", version: 1,
		});
	}

	const mockFile = (id: string, name: string, parentId: string, isFolder?: boolean): MockFile =>
		({ id, name, parentId, checksum: `v-${id}`, isFolder });

	/**
	 * Seed a committed checkpoint holding exactly `rows`, so the next cycle restores
	 * it and replays rather than cold-scanning.
	 */
	async function seedCheckpoint(store: MetadataStore<MockFile>, rows: MockFile[], paths: string[]): Promise<void> {
		await store.open();
		await store.saveAll(
			rows.map((file, index) => ({ path: paths[index]!, file, isFolder: !!file.isFolder })),
			new Map([["changesStartPageToken", "c0"]]),
		);
	}

	describe("producer 1 — _applyIncrementalChanges' hasFile split over the drain's changed paths", () => {
		/**
		 * A folder claims `docs`, which a FILE holds; the cache admits the file and
		 * withholds the folder, whose own address (`old`, with a child) is vacated as a
		 * result. The drain reports those paths changed and declares the contention —
		 * producer 3's half — and this is where the declaration has to stop them
		 * becoming deletions. (A second FOLDER would be merged, and lose nothing.)
		 */
		async function runWithheldFolderDelta(): Promise<{ delta: RemoteDelta; fs: MockRemoteFs }> {
			const remote = new FakeRemote();
			remote.seedRaw(mockFile("a-docs", "docs", remote.rootId));
			remote.seedRaw(mockFile("z-old", "old", remote.rootId, true));
			remote.seedRaw(mockFile("z-child", "a.md", "z-old"));
			const fs = new MockRemoteFs(remote, makeStore());
			await fs.list();

			// `z-old` is renamed to `docs`, which `a-docs` already holds.
			remote.stageRename("old", "docs", { isFolder: true });
			const delta = await fs.checkpoint.getChangedPaths();
			if (!delta) throw new Error("expected a delta");
			return { delta: delta as RemoteDelta, fs };
		}

		it("excludes the address a withheld claimant vacated, and its subtree, from deleted", async () => {
			const { delta, fs } = await runWithheldFolderDelta();

			expect(delta.deleted).toEqual([]);
			await fs.close();
		});

		it("names the contention instead, with both ids and every absent address", async () => {
			const { fs } = await runWithheldFolderDelta();

			expect(fs.takeWorkingViewContentions()).toEqual([{
				path: "docs",
				admittedId: "a-docs",
				withheldId: "z-old",
				displacedPaths: ["old", "old/a.md"],
				reason: "lowest_stable_id",
				owesRemediation: true,
			}]);
			await fs.close();
		});

		it("still reports a genuine remote deletion, which is what becomes checkpoint_deleted", async () => {
			const remote = new FakeRemote();
			remote.seed("keep.md");
			remote.seed("gone.md");
			const fs = new MockRemoteFs(remote, makeStore());
			await fs.list();

			remote.stageDelete("gone.md");
			const delta = await fs.checkpoint.getChangedPaths();

			expect(delta?.deleted).toEqual(["gone.md"]);
			expect(fs.takeWorkingViewContentions()).toEqual([]);
			await fs.close();
		});
	});

	describe("producer 2 — diffById's vanished-id sweep on the cursor-expiry route", () => {
		/**
		 * The measured snapshot fixture: `docs` and its two children are in the
		 * committed checkpoint under one folder id, and the fresh scan finds a second
		 * folder claiming `docs` that wins the address. Every one of the three paths
		 * vanishes from the working view, and before this unit all three reached
		 * `deleted` — the chain the issue measured all the way to `delete_local`.
		 */
		async function runFolderCollisionScan(): Promise<{ delta: RemoteDelta; fs: MockRemoteFs }> {
			const remote = new FakeRemote();
			const loser = mockFile("z-docs", "docs", remote.rootId, true);
			const childA = mockFile("z-a", "a.md", "z-docs");
			const childB = mockFile("z-b", "b.md", "z-docs");
			for (const file of [loser, childA, childB]) remote.seedRaw(file);

			const store = makeStore();
			await seedCheckpoint(store, [loser, childA, childB], ["docs", "docs/a.md", "docs/b.md"]);

			// A `docs` FILE appears remotely; its id sorts below the cached folder's. (A
			// second folder would be merged beside the first, taking nothing from it.)
			remote.seedRaw(mockFile("a-docs", "docs", remote.rootId));

			const fs = new MockRemoteFs(remote, store);
			fs.requestCursorExpiry();
			const delta = await fs.checkpoint.getChangedPaths();
			if (!delta) throw new Error("expected a delta");
			return { delta: delta as RemoteDelta, fs };
		}

		it("yields an empty deleted for docs, docs/a.md and docs/b.md", async () => {
			const { delta, fs } = await runFolderCollisionScan();

			expect(delta.deleted).toEqual([]);
			await fs.close();
		});

		it("reports all three as displaced, naming the withheld folder id", async () => {
			const { fs } = await runFolderCollisionScan();

			expect(fs.takeWorkingViewContentions()).toEqual([{
				path: "docs",
				admittedId: "a-docs",
				withheldId: "z-docs",
				displacedPaths: ["docs/a.md", "docs/b.md"],
				reason: "lowest_stable_id",
				owesRemediation: true,
			}]);
			expect(await fs.stat("docs")).toMatchObject({ identityKey: "a-docs" });
			await fs.close();
		});

		it("leaves a bare-name-collapsed orphan's old path out of deleted after a forced 410", async () => {
			const remote = new FakeRemote();
			// Its parent folder is outside the listing, so the resolver falls back to the
			// bare name and marks the spelling a request echo rather than provider topology.
			const orphan = mockFile("orphan", "Notes.md", "detached-parent");
			remote.seedRaw(orphan);

			const store = makeStore();
			await seedCheckpoint(store, [orphan], ["Notes.md"]);

			// A real root-level `Notes.md` now exists; its spelling is provider-resolved,
			// so the arbiter admits it and the orphan's guess is withheld.
			remote.seedRaw(mockFile("keeper", "Notes.md", remote.rootId));

			const fs = new MockRemoteFs(remote, store);
			fs.requestCursorExpiry();
			const delta = await fs.checkpoint.getChangedPaths();

			expect(delta?.deleted).toEqual([]);
			expect(fs.takeWorkingViewContentions()).toEqual([{
				path: "Notes.md",
				admittedId: "keeper",
				withheldId: "orphan",
				displacedPaths: [],
				reason: "path_authority",
				// The guess addresses an object whose parent chain never reached the bound
				// root, so there is nothing on the provider to rename.
				owesRemediation: false,
			}]);
			await fs.close();
		});

		it("still sweeps an id the provider really dropped into deleted", async () => {
			const remote = new FakeRemote();
			const keep = mockFile("keep", "keep.md", remote.rootId);
			const gone = mockFile("gone", "gone.md", remote.rootId);
			remote.seedRaw(keep);

			const store = makeStore();
			await seedCheckpoint(store, [keep, gone], ["keep.md", "gone.md"]);

			const fs = new MockRemoteFs(remote, store);
			fs.requestCursorExpiry();
			const delta = await fs.checkpoint.getChangedPaths();

			expect(delta?.deleted).toEqual(["gone.md"]);
			expect(fs.takeWorkingViewContentions()).toEqual([]);
			await fs.close();
		});
	});

	describe("producer 3 — id-delta's old-path-and-no-new-path branch, which feeds producer 1", () => {
		it("carries the drain's own contention facts through to the classification", async () => {
			const { delta, fs } = await (async () => {
				const remote = new FakeRemote();
				remote.seedRaw(mockFile("a-docs", "docs", remote.rootId));
				remote.seedRaw(mockFile("z-old", "old", remote.rootId, true));
				remote.seedRaw(mockFile("z-child", "a.md", "z-old"));
				const fs = new MockRemoteFs(remote, makeStore());
				await fs.list();
				remote.stageRename("old", "docs", { isFolder: true });
				const delta = await fs.checkpoint.getChangedPaths();
				if (!delta) throw new Error("expected a delta");
				return { delta: delta as RemoteDelta, fs };
			})();

			// Without the displacement facts the two vacated addresses arrive at producer 1
			// as ordinary changed paths that no longer resolve — indistinguishable from
			// a deletion. The working view's own drain is what tells them apart.
			expect(fs.takeWorkingViewContentions().flatMap((fact) => fact.displacedPaths)).toEqual(["old", "old/a.md"]);
			expect(delta.deleted).toEqual([]);
			expect(delta.modified).toEqual([]);
			await fs.close();
		});

		it("keeps a move outside the tracked root a deletion, because nothing displaced it", async () => {
			const remote = new FakeRemote();
			remote.seedFolderWithChild("Docs", "a.md");
			remote.seed("note.md");
			const fs = new MockRemoteFs(remote, makeStore());
			await fs.list();

			remote.stageDelete("note.md");
			const delta = await fs.checkpoint.getChangedPaths();

			expect(delta?.deleted).toEqual(["note.md"]);
			expect(fs.takeWorkingViewContentions()).toEqual([]);
			await fs.close();
		});
	});

	/**
	 * Two provider folders with one name are one vault folder. Nothing about that is a
	 * contention, and nothing that happens to one of them may reach the other's contents.
	 */
	describe("a vault folder made of several provider folders", () => {
		function twoDocsFolders(): FakeRemote {
			const remote = new FakeRemote();
			remote.seedRaw(mockFile("a-docs", "docs", remote.rootId, true));
			remote.seedRaw(mockFile("a-child", "a.md", "a-docs"));
			remote.seedRaw(mockFile("z-docs", "docs", remote.rootId, true));
			remote.seedRaw(mockFile("z-child", "b.md", "z-docs"));
			return remote;
		}

		it("deletes nothing on a cursor expiry that finds a second folder", async () => {
			const remote = new FakeRemote();
			const cached = mockFile("z-docs", "docs", remote.rootId, true);
			const child = mockFile("z-child", "b.md", "z-docs");
			for (const file of [cached, child]) remote.seedRaw(file);
			const store = makeStore();
			await seedCheckpoint(store, [cached, child], ["docs", "docs/b.md"]);
			remote.seedRaw(mockFile("a-docs", "docs", remote.rootId, true));

			const fs = new MockRemoteFs(remote, store);
			fs.requestCursorExpiry();
			const delta = await fs.checkpoint.getChangedPaths();

			expect(delta?.deleted).toEqual([]);
			expect(fs.takeWorkingViewContentions()).toEqual([]);
			expect(await fs.stat("docs/b.md")).toMatchObject({ identityKey: "z-child" });
			await fs.close();
		});

		it("takes only the deleted folder's own contents when one of them is deleted", async () => {
			const remote = twoDocsFolders();
			const fs = new MockRemoteFs(remote, makeStore());
			await fs.list();

			remote.stageDelete("docs");
			const delta = await fs.checkpoint.getChangedPaths();
			const survivor = await fs.stat("docs");

			expect(survivor?.isDirectory).toBe(true);
			// Whichever of the two the provider dropped, the other's child is still there.
			const kept = (await fs.list()).map((entry) => entry.path).sort();
			expect(kept.filter((path) => path.startsWith("docs/"))).toHaveLength(1);
			expect(delta?.deleted.filter((path) => kept.includes(path))).toEqual([]);
			await fs.close();
		});

		it("takes only the merged folder's own contents when the one deleted is not the representative", async () => {
			const remote = twoDocsFolders();
			const fs = new MockRemoteFs(remote, makeStore());
			await fs.list();

			remote.stageDeleteById("z-docs");
			const delta = await fs.checkpoint.getChangedPaths();

			expect((await fs.list()).map((entry) => entry.path).sort()).toEqual(["docs", "docs/a.md"]);
			expect(await fs.stat("docs")).toMatchObject({ identityKey: "a-docs" });
			expect(delta?.deleted).toEqual(["docs/b.md"]);
			await fs.close();
		});

		it("reports neither a folder rename nor a deletion when a merged folder leaves on a cursor expiry", async () => {
			const remote = twoDocsFolders();
			const store = makeStore();
			const fs = new MockRemoteFs(remote, store);
			await fs.list();
			await fs.checkpoint.commitCheckpoint();

			remote.stageRenameById("z-docs", "archive");
			fs.requestCursorExpiry();
			const delta = await fs.checkpoint.getChangedPaths();

			// `docs` is still the vault folder a-docs makes: it did not move and was not
			// deleted. What moved is z-docs's own content, reported as its own move.
			expect(delta?.renamed).toEqual([{ oldPath: "docs/b.md", newPath: "archive/b.md", identityKey: "z-child" }]);
			expect(delta?.deleted).toEqual(["docs/b.md"]);
			expect(delta?.modified).toContain("docs");
			await fs.close();
		});

		it("reports no folder rename when a folder joins a shared name on a cursor expiry", async () => {
			const remote = new FakeRemote();
			remote.seedRaw(mockFile("m-docs", "docs", remote.rootId, true));
			remote.seedRaw(mockFile("m-child", "a.md", "m-docs"));
			remote.seedRaw(mockFile("a-other", "other", remote.rootId, true));
			remote.seedRaw(mockFile("a-child", "b.md", "a-other"));
			const fs = new MockRemoteFs(remote, makeStore());
			await fs.list();
			await fs.checkpoint.commitCheckpoint();

			// The joining folder's id sorts first, so it becomes the representative.
			remote.stageRenameById("a-other", "docs");
			fs.requestCursorExpiry();
			const delta = await fs.checkpoint.getChangedPaths();

			expect(delta?.renamed).toEqual([{ oldPath: "other/b.md", newPath: "docs/b.md", identityKey: "a-child" }]);
			expect(delta?.renamed?.some((pair) => pair.isFolder)).toBe(false);
			expect(await fs.stat("docs/a.md")).toMatchObject({ identityKey: "m-child" });
			await fs.close();
		});

		it("reports a folder moved into a shared name as its files' moves, not a folder rename", async () => {
			const remote = new FakeRemote();
			remote.seedRaw(mockFile("a-docs", "docs", remote.rootId, true));
			remote.seedRaw(mockFile("a-child", "a.md", "a-docs"));
			remote.seedRaw(mockFile("z-old", "old", remote.rootId, true));
			remote.seedRaw(mockFile("z-child", "b.md", "z-old"));
			const fs = new MockRemoteFs(remote, makeStore());
			await fs.list();

			remote.stageRename("old", "docs", { isFolder: true });
			const delta = await fs.checkpoint.getChangedPaths();

			// A folder pair would say the vault folder `docs` moved, contents and all.
			expect(delta?.renamed).toEqual([{ oldPath: "old/b.md", newPath: "docs/b.md", identityKey: "z-child" }]);
			expect(fs.takeWorkingViewContentions()).toEqual([]);
			expect(await fs.stat("docs/a.md")).toMatchObject({ identityKey: "a-child" });
			expect(await fs.stat("docs/b.md")).toMatchObject({ identityKey: "z-child" });
			await fs.close();
		});

		it("persists and restores both folders through a checkpoint", async () => {
			const remote = twoDocsFolders();
			const store = makeStore();
			const first = new MockRemoteFs(remote, store);
			await first.list();
			await first.checkpoint.commitCheckpoint();
			await first.close();

			const restored = new MockRemoteFs(remote, store);
			const listed = (await restored.list()).map((entry) => entry.path).sort();

			expect(listed).toEqual(["docs", "docs/a.md", "docs/b.md"]);
			await restored.checkpoint.getChangedPaths();
			expect(await restored.stat("docs/b.md")).toMatchObject({ identityKey: "z-child" });
			await restored.close();
		});
	});

	/**
	 * A delta is not the only thing that decides contentions. A FULL SCAN decides them
	 * over the complete listing, and a scan is entered lazily from whichever path-level
	 * call first needs the cache — `list()`, `stat()`, `listDir()` — none of which can
	 * return an address-level fact. Without a channel of its own, a cycle that acquires
	 * its remote side by scanning reports no contention at all, and the withheld object
	 * stays invisible for as long as the checkpoint stands.
	 */
	describe("the full-scan route's own contention channel", () => {
		/** Two live objects whose derived addresses collide, with no checkpoint to restore. */
		function collidingSiblings() {
			const remote = new FakeRemote();
			remote.seedRaw(mockFile("a-note", "Note.md", remote.rootId));
			remote.seedRaw(mockFile("z-note", "Note.md", remote.rootId));
			return new MockRemoteFs(remote, makeStore());
		}

		it("hands over the contentions a lazily-entered full scan decided", async () => {
			const fs = collidingSiblings();

			// `list()` is a path-level call: it builds the working view as a side effect
			// and returns files, so this is the only way the scan's facts get out.
			await fs.list();

			expect(fs.takeWorkingViewContentions()).toEqual([{
				path: "Note.md",
				admittedId: "a-note",
				withheldId: "z-note",
				displacedPaths: [],
				reason: "lowest_stable_id",
				owesRemediation: true,
			}]);
			await fs.close();
		});

		it("hands them over exactly once", async () => {
			const fs = collidingSiblings();
			await fs.list();

			expect(fs.takeWorkingViewContentions()).toHaveLength(1);
			// A second reader must not see them again: two announcements of one address
			// would owe two repairs for one object.
			expect(fs.takeWorkingViewContentions()).toEqual([]);
			await fs.close();
		});

		it("hands over the cursor-expiry route's contentions, once", async () => {
			const remote = new FakeRemote();
			const keep = mockFile("a-note", "Note.md", remote.rootId);
			remote.seedRaw(keep);
			const store = makeStore();
			await seedCheckpoint(store, [keep], ["Note.md"]);
			remote.seedRaw(mockFile("z-note", "Note.md", remote.rootId));

			const fs = new MockRemoteFs(remote, store);
			fs.requestCursorExpiry();
			await fs.checkpoint.getChangedPaths();

			// A scan reached through cursor expiry settles into the same drain as any
			// other working view, and reports each address exactly once.
			expect(fs.takeWorkingViewContentions()).toHaveLength(1);
			expect(fs.takeWorkingViewContentions()).toEqual([]);
			await fs.close();
		});

		it("has nothing to hand over when the view came from a committed checkpoint", async () => {
			const remote = new FakeRemote();
			const keep = mockFile("a-note", "Note.md", remote.rootId);
			remote.seedRaw(keep);
			const store = makeStore();
			await seedCheckpoint(store, [keep], ["Note.md"]);

			const fs = new MockRemoteFs(remote, store);
			await fs.list();

			expect(fs.takeWorkingViewContentions()).toEqual([]);
			await fs.close();
		});

		it("hands over the contentions a replay inside list() decided", async () => {
			// COLD with a checkpoint standing — the scope-change route — lists rather than
			// asking for a delta, and `list()` replays the cursor on the way. What that
			// replay decided is a fact about this working view like any other.
			const remote = new FakeRemote();
			const keep = mockFile("z-note", "Note.md", remote.rootId);
			remote.seedRaw(keep);
			const store = makeStore();
			await seedCheckpoint(store, [keep], ["Note.md"]);
			remote.stageRaw(mockFile("a-note", "Note.md", remote.rootId));

			const fs = new MockRemoteFs(remote, store);
			await fs.list();

			expect(fs.takeWorkingViewContentions()).toEqual([expect.objectContaining({
				path: "Note.md", admittedId: "a-note", withheldId: "z-note",
			})]);
			await fs.close();
		});

		it("still reports them when the cursor expires over a committed view with nothing in it", async () => {
			// An empty committed view is a view, not an initial sync: every object the
			// scan finds is new, and a contention it decides has to reach the cycle.
			const remote = new FakeRemote();
			const store = makeStore();
			await seedCheckpoint(store, [], []);
			remote.seedRaw(mockFile("a-note", "Note.md", remote.rootId));
			remote.seedRaw(mockFile("z-note", "Note.md", remote.rootId));

			const fs = new MockRemoteFs(remote, store);
			fs.requestCursorExpiry();
			const delta = await fs.checkpoint.getChangedPaths();

			expect(delta?.modified).toEqual(["Note.md"]);
			expect(fs.takeWorkingViewContentions()).toEqual([expect.objectContaining({
				path: "Note.md", admittedId: "a-note", withheldId: "z-note",
			})]);
			await fs.close();
		});

		it("discards them with the working view it belongs to", async () => {
			const fs = collidingSiblings();
			await fs.list();

			// An aborted attempt publishes nothing, so its facts must not survive into
			// the next one — which re-scans and re-derives them anyway.
			await fs.checkpoint.abortWorkingView();

			expect(fs.takeWorkingViewContentions()).toEqual([]);
			await fs.close();
		});
	});

	/**
	 * A working view replays its cursor at most once through the implicit `list()`
	 * replay. Namespace reconciliation builds the view first; a second replay behind it
	 * would move the cursor again and could seat a newly-arrived same-name object that
	 * reconciliation never saw, hiding a claimant while a clean checkpoint commits.
	 */
	describe("the working view's cursor is replayed once through list()", () => {
		it("does not apply a change that arrives after the view's delta was built", async () => {
			const remote = new FakeRemote();
			const keep = mockFile("a-keep", "keep.md", remote.rootId);
			remote.seedRaw(keep);
			const store = makeStore();
			await seedCheckpoint(store, [keep], ["keep.md"]);
			const fs = new MockRemoteFs(remote, store);

			// The view's delta is built (as reconciliation does before listing).
			expect((await fs.checkpoint.getChangedPaths())?.modified).toEqual([]);

			// A same-name sibling arrives AFTER the view was built.
			remote.stageRaw(mockFile("z-new", "New.md", remote.rootId));

			// `list()` must not replay behind the built view: the late change is not seated.
			expect((await fs.list()).map((entry) => entry.path)).toEqual(["keep.md"]);

			// An explicit delta still advances and reports it for the next cycle.
			expect((await fs.checkpoint.getChangedPaths())?.modified).toContain("New.md");
			await fs.close();
		});
	});
});
