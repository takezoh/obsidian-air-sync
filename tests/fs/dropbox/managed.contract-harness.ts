import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { RemoteObject } from "../../../src/backend-api";
import type { DropboxEntry, DropboxListFolderResponse } from "../../../src/fs/dropbox/types";
import { DropboxApiError } from "../../../src/fs/dropbox/types";
import type { DropboxClient } from "../../../src/fs/dropbox/client";
import { DropboxAdapter } from "../../../src/fs/dropbox/adapter";
import { ManagedRemoteFs } from "../../../src/fs/managed/managed-remote-fs";
import { MetadataStore } from "../../../src/store/metadata-store";
import { dropboxContentHash } from "../../../src/utils/hash";
import { runIFileSystemContract } from "../contracts/ifilesystem.contract";
import { runRemoteFamilyCachingContract } from "../contracts/caching-remote-fs.contract";
import type { RemoteFamilyCachingHarness } from "../contracts/caching-remote-fs.contract";
import { bytes, statOrThrow, runRemoteChangeDetectionContract } from "../contracts/remote-change-detection.contract";
import {
	runPriorityObservationContract,
	type PriorityObservationContractHarness,
	type PriorityObservationScenario,
} from "../contracts/priority-observation.contract";

vi.mock("obsidian");

const ROOT_ID = "id:root";
const ROOT_PATH = "/root";
const OUTSIDE_PATH = "/outside";
const STORE = { dbNamePrefix: "air-sync-dropbox-managed-contract", version: 1 };

interface Node {
	entry: DropboxEntry;
	content?: ArrayBuffer;
}

/** A CRUD + delta faithful in-memory Dropbox client for the managed path. */
class FakeDropbox {
	private readonly byPath = new Map<string, Node>();
	private readonly idToPath = new Map<string, string>();
	private readonly events: DropboxEntry[] = [];
	private readonly outside = new Map<string, string[]>();
	private idSeq = 0;
	private failAfterFirstPage = false;

	private id(prefix: string): string {
		return `id:${prefix}${++this.idSeq}`;
	}

	private fileEntry(id: string, path: string): DropboxEntry {
		const name = path.split("/").pop()!;
		return { ".tag": "file", id, name, path_lower: path.toLowerCase(), path_display: path, rev: `rev-${id}`, size: 0, client_modified: "2024-01-01T00:00:00Z", server_modified: "2024-01-01T00:00:00Z", content_hash: `hash-${id}` };
	}

	private folderEntry(id: string, path: string): DropboxEntry {
		const name = path.split("/").pop()!;
		return { ".tag": "folder", id, name, path_lower: path.toLowerCase(), path_display: path };
	}

	private put(entry: DropboxEntry, content?: ArrayBuffer): void {
		this.byPath.set(entry.path_display, { entry, content });
		if (entry.id) this.idToPath.set(entry.id, entry.path_display);
	}

	private removePath(path: string): void {
		const node = this.byPath.get(path);
		if (node?.entry.id) this.idToPath.delete(node.entry.id);
		this.byPath.delete(path);
		this.outside.forEach((ids, key) => {
			if (ids.includes(path)) this.outside.set(key, ids.filter((id) => id !== path));
		});
	}

	private abs(path: string): string {
		return `${ROOT_PATH}/${path}`;
	}

	private toAbs(ref: string): string {
		if (ref === ROOT_ID) return ROOT_PATH;
		if (ref.startsWith(`${ROOT_ID}/`)) return `${ROOT_PATH}/${ref.slice(ROOT_ID.length + 1)}`;
		return ref;
	}

	private outsideAbs(path: string): string {
		return `${OUTSIDE_PATH}/${path}`;
	}

	private lookup(ref: string): Node | undefined {
		if (ref.startsWith(`${ROOT_ID}/`)) {
			return this.byPath.get(`${ROOT_PATH}/${ref.slice(ROOT_ID.length + 1)}`);
		}
		if (ref.startsWith(`${ROOT_PATH}/`) || ref === ROOT_PATH) return this.byPath.get(ref);
		if (ref.startsWith("id:")) {
			const path = this.idToPath.get(ref);
			return path === undefined ? undefined : this.byPath.get(path);
		}
		return this.byPath.get(ref);
	}

	// ── Staging ──

	seedFile(path: string): string {
		const id = this.id("f");
		const entry = this.fileEntry(id, this.abs(path));
		this.put(entry);
		return id;
	}

	seedFolderWithChild(folderPath: string, childName: string): void {
		const folderId = this.id("d");
		this.put(this.folderEntry(folderId, this.abs(folderPath)));
		const childId = this.id("f");
		this.put(this.fileEntry(childId, this.abs(`${folderPath}/${childName}`)));
	}

	seedFolderOutsideRoot(folderPath: string): void {
		const paths = [folderPath, `${folderPath}/a.md`, `${folderPath}/sub`, `${folderPath}/sub/b.md`];
		for (const rel of paths) {
			const id = this.id(rel.endsWith(".md") ? "f" : "d");
			const entry = rel.endsWith(".md")
				? this.fileEntry(id, this.outsideAbs(rel))
				: this.folderEntry(id, this.outsideAbs(rel));
			this.put(entry);
		}
		this.outside.set(folderPath, paths.map((rel) => this.outsideAbs(rel)));
	}

	stageMoveIntoRoot(folderPath: string): void {
		const abs = this.outside.get(folderPath);
		if (!abs) throw new Error(`stageMoveIntoRoot: no folder outside root at "${folderPath}"`);
		this.outside.delete(folderPath);
		for (const oldAbs of abs) {
			const node = this.byPath.get(oldAbs);
			if (!node || !node.entry.id) continue;
			const rel = oldAbs.slice(OUTSIDE_PATH.length);
			const newAbs = `${ROOT_PATH}${rel}`;
			this.removePath(oldAbs);
			const moved: DropboxEntry = { ...node.entry, name: newAbs.split("/").pop()!, path_lower: newAbs.toLowerCase(), path_display: newAbs };
			this.put(moved, node.content);
			this.events.push(moved);
		}
	}

	stageRemoteDelete(path: string): void {
		const abs = this.abs(path);
		const node = this.byPath.get(abs);
		if (!node) throw new Error(`stageRemoteDelete: no such file "${path}"`);
		this.removePath(abs);
		this.events.push({ ".tag": "deleted", name: path.split("/").pop()!, path_lower: abs.toLowerCase(), path_display: abs });
	}

	private stageRename(oldPath: string, newPath: string, opts: { isFolder?: boolean } | undefined, deletedFirst: boolean): void {
		const absOld = this.abs(oldPath);
		if (!this.byPath.has(absOld)) throw new Error(`stageRemoteRename: no such path "${oldPath}"`);
		const oldPrefix = `${absOld}/`;
		const moved: DropboxEntry[] = [];
		const deletes: DropboxEntry[] = [];
		for (const [path, node] of [...this.byPath.entries()]) {
			const isSelf = path === absOld;
			if (!isSelf && !(opts?.isFolder && path.startsWith(oldPrefix))) continue;
			this.removePath(path);
			const np = isSelf ? this.abs(newPath) : `${this.abs(newPath)}/${path.substring(oldPrefix.length)}`;
			const movedEntry: DropboxEntry = { ...node.entry, name: np.split("/").pop()!, path_lower: np.toLowerCase(), path_display: np };
			this.put(movedEntry, node.content);
			moved.push(movedEntry);
			deletes.push({ ".tag": "deleted", name: path.split("/").pop()!, path_lower: path.toLowerCase(), path_display: path });
		}
		for (const entry of deletedFirst ? [...deletes, ...moved] : [...moved, ...deletes]) this.events.push(entry);
	}

	stageRemoteRename(oldPath: string, newPath: string, opts?: { isFolder?: boolean }): void {
		this.stageRename(oldPath, newPath, opts, true);
	}

	stageRemoteRenameReversed(oldPath: string, newPath: string, opts?: { isFolder?: boolean }): void {
		this.stageRename(oldPath, newPath, opts, false);
	}

	stageRemoteRecreateWithNewId(path: string): void {
		const abs = this.abs(path);
		if (!this.byPath.has(abs)) throw new Error(`stageRemoteRecreateWithNewId: no such path "${path}"`);
		this.removePath(abs);
		this.events.push({ ".tag": "deleted", name: path.split("/").pop()!, path_lower: abs.toLowerCase(), path_display: abs });
		const created = this.fileEntry(this.id("f"), abs);
		this.put(created);
		this.events.push(created);
	}

	failNextDeltaAfterFirstPage(): void {
		this.failAfterFirstPage = true;
	}

	// ── Provider seams ──

	getMetadata(ref: string): Promise<DropboxEntry> {
		if (ref === ROOT_ID) {
			return Promise.resolve(this.folderEntry(ROOT_ID, ROOT_PATH));
		}
		const node = this.lookup(ref);
		return node
			? Promise.resolve(node.entry)
			: Promise.reject(new DropboxApiError(`path/not_found: ${ref}`, 409, "path/not_found"));
	}

	getLatestCursor(): Promise<string> {
		return Promise.resolve(`c${this.events.length}`);
	}

	listFolderAll(): Promise<DropboxEntry[]> {
		return Promise.resolve([...this.byPath.values()]
			.filter((n) => n.entry.path_display.startsWith(`${ROOT_PATH}/`))
			.map((n) => n.entry));
	}

	listFolderContinue(cursor: string): Promise<DropboxListFolderResponse> {
		if (cursor === "contract-second-page") {
			this.failAfterFirstPage = false;
			return Promise.reject(new Error("injected later page failure"));
		}
		const from = cursor.startsWith("c") ? Number(cursor.slice(1)) : 0;
		if (this.failAfterFirstPage) {
			return Promise.resolve({ entries: this.events.slice(from, from + 1), cursor: "contract-second-page", has_more: true });
		}
		return Promise.resolve({ entries: this.events.slice(from), cursor: `c${this.events.length}`, has_more: false });
	}

	async upload(target: string, content: ArrayBuffer, mtime: number): Promise<DropboxEntry> {
		const absPath = this.toAbs(target);
		const existing = this.byPath.get(absPath);
		const id = existing?.entry.id ?? this.id("f");
		const contentHash = await dropboxContentHash(content);
		const entry: DropboxEntry = {
			".tag": "file",
			id,
			name: absPath.split("/").pop()!,
			path_lower: absPath.toLowerCase(),
			path_display: absPath,
			rev: `rev-${id}-${content.byteLength}-${contentHash.slice(0, 6)}`,
			size: content.byteLength,
			client_modified: new Date(mtime).toISOString(),
			server_modified: new Date(mtime).toISOString(),
			content_hash: contentHash,
		};
		this.put(entry, content.slice(0));
		return entry;
	}

	createFolder(target: string): Promise<DropboxEntry> {
		const absPath = this.toAbs(target);
		const existing = this.byPath.get(absPath);
		if (existing) return Promise.resolve(existing.entry);
		const entry = this.folderEntry(this.id("d"), absPath);
		this.put(entry);
		return Promise.resolve(entry);
	}

	move(fromRef: string, toRef: string): Promise<DropboxEntry> {
		const fromAbs = this.toAbs(fromRef);
		const toAbs = this.toAbs(toRef);
		const node = this.byPath.get(fromAbs);
		if (!node) return Promise.reject(new DropboxApiError(`path/not_found: ${fromAbs}`, 409, "path/not_found"));
		this.removePath(fromAbs);
		const moved: DropboxEntry = { ...node.entry, name: toAbs.split("/").pop()!, path_lower: toAbs.toLowerCase(), path_display: toAbs };
		this.put(moved, node.content);
		return Promise.resolve(moved);
	}

	deletePath(absOrId: string): Promise<void> {
		const node = this.lookup(absOrId);
		if (!node) return Promise.resolve();
		this.removePath(node.entry.path_display);
		return Promise.resolve();
	}

	download(absOrId: string): Promise<ArrayBuffer> {
		const node = this.lookup(absOrId);
		return node?.content !== undefined
			? Promise.resolve(node.content.slice(0))
			: Promise.reject(new Error(`not_found: ${absOrId}`));
	}

	// ── Test-only ──

	getRev(id: string): string | undefined {
		const path = this.idToPath.get(id);
		return path === undefined ? undefined : this.byPath.get(path)?.entry.rev;
	}

	dropRev(id: string): void {
		const path = this.idToPath.get(id);
		const node = path === undefined ? undefined : this.byPath.get(path);
		if (node) node.entry.rev = undefined;
	}

	replaceWithNewId(path: string): string {
		const abs = this.abs(path);
		this.removePath(abs);
		const id = this.id("f");
		const entry = this.fileEntry(id, abs);
		entry.size = 3;
		entry.content_hash = "replacement";
		this.put(entry);
		return id;
	}
}

function clientOf(fake: FakeDropbox): DropboxClient {
	return fake as unknown as DropboxClient;
}

function makeFs(
	fake: FakeDropbox,
	vaultId: string,
	metadataStore: MetadataStore<RemoteObject> = new MetadataStore<RemoteObject>(vaultId, STORE),
): ManagedRemoteFs {
	return new ManagedRemoteFs({
		adapter: new DropboxAdapter(clientOf(fake), ROOT_ID),
		name: "dropbox",
		rootFolderId: ROOT_ID,
		vaultId,
		store: STORE,
		metadataStore,
		addressing: "provider_path",
	});
}

function makeCachingHarness(): RemoteFamilyCachingHarness<RemoteObject> {
	const client = new FakeDropbox();
	return {
		makeStore: (id) => new MetadataStore<RemoteObject>(id, STORE),
		makeFs: (store) => makeFs(client, "managed", store),
		seedFile: (path) => client.seedFile(path),
		seedFolderWithChild: (folderPath, childName) => client.seedFolderWithChild(folderPath, childName),
		seedFolderOutsideRoot: (folderPath) => client.seedFolderOutsideRoot(folderPath),
		stageMoveIntoRoot: (folderPath) => client.stageMoveIntoRoot(folderPath),
		stageRemoteDelete: (path) => client.stageRemoteDelete(path),
		stageRemoteRename: (oldPath, newPath, opts) => client.stageRemoteRename(oldPath, newPath, opts),
		stageRemoteRecreateWithNewId: (path) => client.stageRemoteRecreateWithNewId(path),
		failNextDeltaAfterFirstPage: () => client.failNextDeltaAfterFirstPage(),
		collision: {
			kind: "cannot",
			reason: "path-keyed namespace: one path can hold only one entry",
			unknown: "unknown-dropbox-folder-replacement-contract",
		},
		movedObjectIdentity: {
			determinate: true,
			reason: "normalizeDropboxObject sets id from the entry id with no path fallback.",
		},
		renameOrderings: {
			encoding: "orderable-pair",
			reason: "Dropbox reports a move as deleted(old)+file(new) sharing a stable id, in either windowing.",
			stageReversed: (oldPath, newPath, opts) => client.stageRemoteRenameReversed(oldPath, newPath, opts),
		},
	};
}

export function registerDropboxManagedIFileSystemContract(): void {
	runIFileSystemContract(
		"ManagedRemoteFs<dropbox>",
		() => makeFs(new FakeDropbox(), "managed-fs"),
		{ computesHashOnStat: false, stableIdentity: true, preservesWrittenMtime: true },
	);
}

export function registerDropboxManagedCachingContract(): void {
	runRemoteFamilyCachingContract("ManagedRemoteFs<dropbox>", makeCachingHarness);
}

export function registerDropboxManagedChangeDetectionContract(): void {
	runRemoteChangeDetectionContract(
		"ManagedRemoteFs<dropbox>",
		async () => {
			await Promise.resolve();
			const fs = makeFs(new FakeDropbox(), "managed-change");
			const path = "note.md";
			return {
				observeWritten: async () => {
					await fs.write(path, bytes("version one"), Date.now());
					return statOrThrow(fs, path);
				},
				observeUnchanged: async () => statOrThrow(fs, path),
				observeAfterEdit: async () => {
					await fs.write(path, bytes("version two!"), Date.now());
					return statOrThrow(fs, path);
				},
				observeTouchedSameContent: async () => {
					await fs.write(path, bytes("version one"), Date.now() + 1000);
					return statOrThrow(fs, path);
				},
			};
		},
		{ checksumBased: true },
	);
}

interface DropboxPriorityHarness extends PriorityObservationContractHarness {
	assertIdentityReadRoute(): void;
}

async function makePriorityHarness(scenario: PriorityObservationScenario): Promise<DropboxPriorityHarness> {
	const client = new FakeDropbox();
	const content = bytes("priority");
	const createdEntry = await client.upload(`${ROOT_PATH}/note.md`, content, Date.now());
	const createdId = createdEntry.id!;
	const fs = makeFs(client, "managed-priority");
	const download = vi.spyOn(client, "download");
	if (scenario === "unverifiable") client.dropRev(createdId);
	let replacementKey = "replacement";
	if (scenario === "missing") void client.deletePath(createdId);
	if (scenario === "replacement") replacementKey = client.replaceWithNewId("note.md");
	if (scenario === "changed-during-read") {
		download.mockImplementation((ref: string) => {
			client.dropRev(createdId);
			return Promise.resolve(content.slice(0));
		});
	}
	return {
		fs,
		request: { path: "note.md", identityKey: createdId },
		expectedToken: `dropbox:${client.getRev(createdId)!}`,
		expectedContent: content.slice(0),
		replacementIdentityKey: replacementKey,
		assertIdentityReadRoute: () => {
			expect(download).toHaveBeenCalledWith(createdId);
		},
	};
}

export function registerDropboxManagedPriorityObservationContract(): void {
	runPriorityObservationContract("ManagedRemoteFs<dropbox>", makePriorityHarness);

	describe("ManagedRemoteFs<dropbox> detached priority observation", () => {
		it("reads the admitted identity through the adapter", async () => {
			const harness = await makePriorityHarness("current");
			try {
				const observed = await harness.fs.priority.observe(harness.request);
				expect(observed.kind).toBe("current");
				await harness.fs.priority.read(observed as never);
				harness.assertIdentityReadRoute();
			} finally {
				await harness.fs.close?.();
			}
		});
	});
}
