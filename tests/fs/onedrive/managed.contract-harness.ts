import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { RemoteObject } from "../../../src/backend-api";
import type { OneDriveItem, OneDriveDeltaResponse } from "../../../src/fs/onedrive/types";
import { GraphApiError } from "../../../src/fs/onedrive/types";
import type { OneDriveClient } from "../../../src/fs/onedrive/client";
import { OneDriveAdapter } from "../../../src/fs/onedrive/adapter";
import { ManagedRemoteFs } from "../../../src/fs/managed/managed-remote-fs";
import { MetadataStore } from "../../../src/store/metadata-store";
import { quickXorHashBase64 } from "../../../src/utils/quickxor";
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

const ROOT = "root";
const OUTSIDE_ID = "outside";
const STORE = { dbNamePrefix: "air-sync-onedrive-managed-contract", version: 1 };
const MODIFIED = "2024-01-01T00:00:00Z";

interface Node {
	id: string;
	name: string;
	parentId: string;
	isFolder: boolean;
	content?: ArrayBuffer;
	size: number;
	mtime: string;
	quickXorHash?: string;
	cTag?: string;
}

/** A CRUD + delta faithful in-memory OneDrive client for the managed path. */
class FakeOneDrive {
	private readonly nodes = new Map<string, Node>();
	private readonly events: OneDriveItem[] = [];
	private readonly outside = new Map<string, string[]>();
	private readonly outsideIds = new Set<string>();
	private idSeq = 0;
	private failAfterFirstPage = false;
	readonly rootId = ROOT;

	constructor() {
		this.nodes.set(ROOT, { id: ROOT, name: "root", parentId: "", isFolder: true, size: 0, mtime: "" });
	}

	private id(prefix: string): string {
		return `${prefix}${++this.idSeq}`;
	}

	private itemOf(node: Node): OneDriveItem {
		return node.isFolder
			? { id: node.id, name: node.name, parentReference: { id: node.parentId, path: "/drive/root:" }, folder: { childCount: 0 } }
			: {
					id: node.id,
					name: node.name,
					size: node.size,
					parentReference: { id: node.parentId, path: "/drive/root:" },
					file: { hashes: { quickXorHash: node.quickXorHash } },
					fileSystemInfo: { lastModifiedDateTime: node.mtime },
					lastModifiedDateTime: node.mtime,
					cTag: node.cTag,
					eTag: node.cTag,
				};
	}

	private childByName(parentId: string, name: string): Node | undefined {
		return [...this.nodes.values()].find((n) => n.parentId === parentId && n.name === name);
	}

	private descendantsOf(id: string): Node[] {
		const out: Node[] = [];
		const stack = [id];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			for (const n of this.nodes.values()) {
				if (n.parentId === cur) {
					out.push(n);
					stack.push(n.id);
				}
			}
		}
		return out;
	}

	private seed(id: string, name: string, parentId: string, folder = false): Node {
		const node: Node = folder
			? { id, name, parentId, isFolder: true, size: 0, mtime: "" }
			: { id, name, parentId, isFolder: false, size: 0, mtime: MODIFIED, quickXorHash: `qxh-${id}`, cTag: `c-${id}` };
		this.nodes.set(id, node);
		return node;
	}

	// ── Staging ──

	seedFile(path: string): string {
		const id = this.id("f");
		this.seed(id, path, ROOT);
		return id;
	}

	seedFolderWithChild(folderPath: string, childName: string): void {
		const folderId = this.id("d");
		this.seed(folderId, folderPath, ROOT, true);
		this.seed(this.id("f"), childName, folderId);
	}

	seedFolderOutsideRoot(folderPath: string): void {
		const folderId = this.id("d");
		const subId = this.id("d");
		this.seed(folderId, folderPath, OUTSIDE_ID, true);
		this.seed(this.id("f"), "a.md", folderId);
		this.seed(subId, "sub", folderId, true);
		this.seed(this.id("f"), "b.md", subId);
		const ids = [folderId, ...this.descendantsOf(folderId).map((n) => n.id)];
		this.outside.set(folderPath, ids);
		for (const id of ids) this.outsideIds.add(id);
	}

	stageMoveIntoRoot(folderPath: string): void {
		const ids = this.outside.get(folderPath);
		if (!ids) throw new Error(`stageMoveIntoRoot: no folder outside root at "${folderPath}"`);
		this.outside.delete(folderPath);
		for (const id of ids) this.outsideIds.delete(id);
		const folder = this.nodes.get(ids[0]!)!;
		folder.parentId = ROOT;
		for (const id of ids) {
			const node = this.nodes.get(id)!;
			this.events.push(this.itemOf(node));
		}
	}

	stageRemoteDelete(path: string): void {
		const node = [...this.nodes.values()].find((n) => n.name === path);
		if (!node) throw new Error(`stageRemoteDelete: no such file "${path}"`);
		this.nodes.delete(node.id);
		this.events.push({ id: node.id, name: "", deleted: { state: "deleted" } });
	}

	stageRemoteRename(oldPath: string, newPath: string, opts?: { isFolder?: boolean }): void {
		const match = opts?.isFolder
			? (n: Node) => n.name === oldPath && n.isFolder
			: (n: Node) => n.name === oldPath;
		const node = [...this.nodes.values()].find(match);
		if (!node) throw new Error(`stageRemoteRename: no such path "${oldPath}"`);
		node.name = newPath.split("/").pop()!;
		this.events.push(this.itemOf(node));
	}

	stageRemoteRecreateWithNewId(path: string): void {
		const node = [...this.nodes.values()].find((n) => n.name === path);
		if (!node) throw new Error(`stageRemoteRecreateWithNewId: no such path "${path}"`);
		this.nodes.delete(node.id);
		this.events.push({ id: node.id, name: "", deleted: { state: "deleted" } });
		const created = this.seed(this.id("f"), path, ROOT);
		this.events.push(this.itemOf(created));
	}

	failNextDeltaAfterFirstPage(): void {
		this.failAfterFirstPage = true;
	}

	// ── Provider seams ──

	getStartCursor(_rootId: string): Promise<string> {
		return Promise.resolve(`c${this.events.length}`);
	}

	fullList(_rootId: string): Promise<OneDriveItem[]> {
		return Promise.resolve([...this.nodes.values()].filter((n) => n.id !== ROOT && !this.outsideIds.has(n.id)).map((n) => this.itemOf(n)));
	}

	fetchDelta(_rootId: string, link: string): Promise<OneDriveDeltaResponse> {
		if (link === "contract-second-page") {
			this.failAfterFirstPage = false;
			return Promise.reject(new Error("injected later page failure"));
		}
		const from = link.startsWith("c") ? Number(link.slice(1)) : 0;
		if (this.failAfterFirstPage) {
			return Promise.resolve({ value: this.events.slice(from, from + 1), "@odata.nextLink": "contract-second-page" });
		}
		return Promise.resolve({ value: this.events.slice(from), "@odata.deltaLink": `https://g/delta?token=c${this.events.length}` });
	}

	getItem(id: string): Promise<OneDriveItem> {
		const node = this.nodes.get(id);
		return node ? Promise.resolve(this.itemOf(node)) : Promise.reject(new GraphApiError(`itemNotFound: ${id}`, 404, "itemNotFound"));
	}

	getChildByName(parentId: string, name: string): Promise<OneDriveItem> {
		const node = this.childByName(parentId, name);
		return node ? Promise.resolve(this.itemOf(node)) : Promise.reject(new GraphApiError(`itemNotFound: ${name}`, 404, "itemNotFound"));
	}

	upload(parentId: string, name: string, content: ArrayBuffer, mtime: number): Promise<OneDriveItem> {
		const existing = this.childByName(parentId, name);
		const id = existing && !existing.isFolder ? existing.id : this.id("f");
		const node: Node = {
			id,
			name,
			parentId,
			isFolder: false,
			content: content.slice(0),
			size: content.byteLength,
			mtime: new Date(mtime).toISOString(),
			quickXorHash: quickXorHashBase64(content),
			cTag: `c-${id}-${content.byteLength}`,
		};
		this.nodes.set(id, node);
		return Promise.resolve(this.itemOf(node));
	}

	createFolder(parentId: string, name: string): Promise<OneDriveItem> {
		const existing = this.childByName(parentId, name);
		if (existing) return Promise.resolve(this.itemOf(existing));
		const node = this.seed(this.id("d"), name, parentId, true);
		return Promise.resolve(this.itemOf(node));
	}

	move(id: string, name: string | undefined, newParentId: string | undefined): Promise<OneDriveItem> {
		const node = this.nodes.get(id);
		if (!node) return Promise.reject(new Error(`itemNotFound: ${id}`));
		if (name !== undefined) node.name = name;
		if (newParentId !== undefined) node.parentId = newParentId;
		return Promise.resolve(this.itemOf(node));
	}

	deleteItem(id: string): Promise<void> {
		for (const node of [this.nodes.get(id), ...this.descendantsOf(id)]) {
			if (node) this.nodes.delete(node.id);
		}
		return Promise.resolve();
	}

	download(id: string): Promise<ArrayBuffer> {
		const node = this.nodes.get(id);
		return node?.content !== undefined
			? Promise.resolve(node.content.slice(0))
			: Promise.reject(new Error(`itemNotFound: ${id}`));
	}

	// ── Test-only ──

	getVersionTag(id: string): string | undefined {
		return this.nodes.get(id)?.cTag;
	}

	dropVersionTag(id: string): void {
		const node = this.nodes.get(id);
		if (node) node.cTag = undefined;
	}

	replaceWithNewId(path: string): string {
		const old = [...this.nodes.values()].find((n) => n.name === path);
		if (old) this.nodes.delete(old.id);
		const node = this.seed(this.id("f"), path, ROOT);
		node.quickXorHash = "replacement";
		node.size = 3;
		return node.id;
	}
}

function clientOf(fake: FakeOneDrive): OneDriveClient {
	return fake as unknown as OneDriveClient;
}

function makeFs(
	fake: FakeOneDrive,
	vaultId: string,
	metadataStore: MetadataStore<RemoteObject> = new MetadataStore<RemoteObject>(vaultId, STORE),
): ManagedRemoteFs {
	return new ManagedRemoteFs({
		adapter: new OneDriveAdapter(clientOf(fake), ROOT),
		name: "onedrive",
		rootFolderId: ROOT,
		vaultId,
		store: STORE,
		metadataStore,
		addressing: "parent_id",
	});
}

function makeCachingHarness(): RemoteFamilyCachingHarness<RemoteObject> {
	const client = new FakeOneDrive();
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
			reason: "unmeasured whether Graph accepts two same-named children under one folder",
			unknown: "unknown-onedrive-duplicate-names",
		},
		movedObjectIdentity: {
			determinate: true,
			reason: "normalizeOneDriveObject sets id from the driveItem id for files and folders alike.",
		},
		renameOrderings: {
			encoding: "single-entry",
			reason: "OneDrive is id-addressed; /delta reports a rename as one id-keyed item.",
		},
	};
}

export function registerOneDriveManagedIFileSystemContract(): void {
	runIFileSystemContract(
		"ManagedRemoteFs<onedrive>",
		() => makeFs(new FakeOneDrive(), "managed-fs"),
		{ computesHashOnStat: false, stableIdentity: true },
	);
}

export function registerOneDriveManagedCachingContract(): void {
	runRemoteFamilyCachingContract("ManagedRemoteFs<onedrive>", makeCachingHarness);
}

export function registerOneDriveManagedChangeDetectionContract(): void {
	runRemoteChangeDetectionContract(
		"ManagedRemoteFs<onedrive>",
		async () => {
			await Promise.resolve();
			const fs = makeFs(new FakeOneDrive(), "managed-change");
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

interface OneDrivePriorityHarness extends PriorityObservationContractHarness {
	assertIdentityReadRoute(): void;
}

async function makePriorityHarness(scenario: PriorityObservationScenario): Promise<OneDrivePriorityHarness> {
	const client = new FakeOneDrive();
	const content = bytes("priority");
	const created = await client.upload(ROOT, "note.md", content, Date.now());
	const fs = makeFs(client, "managed-priority");
	const download = vi.spyOn(client, "download");
	if (scenario === "unverifiable") client.dropVersionTag(created.id);
	let replacementKey = "replacement";
	if (scenario === "missing") void client.deleteItem(created.id);
	if (scenario === "replacement") replacementKey = client.replaceWithNewId("note.md");
	if (scenario === "changed-during-read") {
		download.mockImplementation((id: string) => {
			client.dropVersionTag(id);
			return Promise.resolve(content.slice(0));
		});
	}
	return {
		fs,
		request: { path: "note.md", identityKey: created.id },
		expectedToken: `onedrive:${client.getVersionTag(created.id)!}`,
		expectedContent: content.slice(0),
		replacementIdentityKey: replacementKey,
		assertIdentityReadRoute: () => {
			expect(download).toHaveBeenCalledWith(created.id);
		},
	};
}

export function registerOneDriveManagedPriorityObservationContract(): void {
	runPriorityObservationContract("ManagedRemoteFs<onedrive>", makePriorityHarness);

	describe("ManagedRemoteFs<onedrive> detached priority observation", () => {
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
