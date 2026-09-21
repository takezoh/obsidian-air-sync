import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { DestinationAddress, RemoteBackendCapabilities, RemoteObject } from "../../../src/backend-api";
import type { GoogleDriveChange, GoogleDriveFile } from "../../../src/backends/googledrive/types";
import { FOLDER_MIME } from "../../../src/backends/googledrive/types";
import type { GoogleDriveClient } from "../../../src/backends/googledrive/client";
import { GoogleDriveAdapter } from "../../../src/backends/googledrive/adapter";
import { ManagedRemoteFs } from "../../../src/fs/managed/managed-remote-fs";
import { MetadataStore } from "../../../src/store/metadata-store";
import { sha256 } from "../../../src/utils/hash";
import { runIFileSystemContract } from "../contracts/ifilesystem.contract";
import { runRemoteFamilyCachingContract } from "../contracts/caching-remote-fs.contract";
import type {
	CollisionClaimant,
	CollisionRoute,
	RemoteFamilyCachingHarness,
} from "../contracts/caching-remote-fs.contract";
import { bytes, statOrThrow, runRemoteChangeDetectionContract } from "../contracts/remote-change-detection.contract";
import { runBackendConcurrencyContract } from "../contracts/backend-concurrency.contract";
import type { BackendConcurrencyHarness } from "../contracts/backend-concurrency.contract";
import {
	runPriorityObservationContract,
	type PriorityObservationContractHarness,
	type PriorityObservationScenario,
} from "../contracts/priority-observation.contract";

vi.mock("obsidian");

const ROOT = "root";
const OUTSIDE_ID = "outside";
const VANISHED_PARENT_ID = "vanished";
const STORE = { dbNamePrefix: "air-sync-googledrive-managed-contract", version: 1 };
const MODIFIED = "2024-01-01T00:00:00.000Z";

/**
 * A CRUD + delta faithful in-memory Google Drive client for the managed path. It
 * holds the provider facts the legacy harness fakes hold, so the REAL
 * {@link GoogleDriveAdapter} + {@link ManagedRemoteFs} are exercised through the
 * shared contracts.
 */
class FakeGoogleDrive {
	private readonly nodes = new Map<string, GoogleDriveFile>();
	private readonly contents = new Map<string, ArrayBuffer>();
	private readonly events: GoogleDriveChange[] = [];
	private readonly outside = new Map<string, string>();
	private readonly vanished = new Set<string>();
	private idSeq = 0;
	private failAfterFirstPage = false;
	private expireNextDelta = false;
	private afterRead?: (ref: string) => void;
	private readonly versionSeq = new Map<string, number>();
	readonly rootId = ROOT;

	private id(prefix: string): string {
		return `${prefix}${++this.idSeq}`;
	}

	private copy(file: GoogleDriveFile): GoogleDriveFile {
		return { ...file, parents: file.parents ? [...file.parents] : undefined };
	}

	private childIdsOf(pid: string): string[] {
		return [...this.nodes.values()]
			.filter((n) => n.parents?.includes(pid))
			.map((n) => n.id);
	}

	private descendantsOf(id: string): string[] {
		const out: string[] = [];
		const stack = this.childIdsOf(id);
		while (stack.length) {
			const cur = stack.pop()!;
			out.push(cur);
			stack.push(...this.childIdsOf(cur));
		}
		return out;
	}

	private subtree(folderId: string): GoogleDriveFile[] {
		const descendants: GoogleDriveFile[] = [];
		const folderIds = [folderId];
		for (let i = 0; i < folderIds.length; i++) {
			const parentId = folderIds[i]!;
			for (const file of this.nodes.values()) {
				if (!file.parents?.includes(parentId)) continue;
				descendants.push(this.copy(file));
				if (file.mimeType === FOLDER_MIME) folderIds.push(file.id);
			}
		}
		for (const id of this.vanished) {
			const file = this.nodes.get(id);
			if (file) descendants.push(this.copy(file));
		}
		return descendants;
	}

	private place(file: GoogleDriveFile, content?: ArrayBuffer): void {
		// Advance the provider's monotonic `version` on every server-side change,
		// including metadata-only ones, exactly as Drive does.
		file.version = String((this.versionSeq.get(file.id) ?? 0) + 1);
		this.versionSeq.set(file.id, Number(file.version));
		this.nodes.set(file.id, file);
		if (content) this.contents.set(file.id, content.slice(0));
	}

	private seed(id: string, name: string, parentId: string, mimeType = "text/plain"): void {
		this.place({ id, name, mimeType, parents: [parentId], modifiedTime: MODIFIED });
	}

	// ── Staging (provider facts only) ──

	seedFile(path: string): string {
		const id = this.id("f");
		this.seed(id, path, ROOT);
		return id;
	}

	seedFolderWithChild(folderPath: string, childName: string): void {
		const folderId = this.id("d");
		this.seed(folderId, folderPath, ROOT, FOLDER_MIME);
		this.seed(this.id("f"), childName, folderId);
	}

	seedFolderOutsideRoot(folderPath: string): void {
		const folderId = this.id("d");
		const subId = this.id("d");
		this.seed(folderId, folderPath, OUTSIDE_ID, FOLDER_MIME);
		this.seed(this.id("f"), "a.md", folderId);
		this.seed(subId, "sub", folderId, FOLDER_MIME);
		this.seed(this.id("f"), "b.md", subId);
		this.outside.set(folderPath, folderId);
	}

	stageMoveIntoRoot(folderPath: string): void {
		const folderId = this.outside.get(folderPath);
		if (!folderId) throw new Error(`stageMoveIntoRoot: no folder outside root at "${folderPath}"`);
		this.outside.delete(folderPath);
		const current = this.nodes.get(folderId)!;
		const moved = { ...current, parents: [ROOT] };
		this.place(moved, this.contents.get(folderId));
		this.events.push({ type: "file", fileId: folderId, removed: false, file: moved });
	}

	stageRemoteDelete(path: string): void {
		const file = [...this.nodes.values()].find((n) => n.name === path);
		if (!file) throw new Error(`stageRemoteDelete: no such file "${path}"`);
		this.nodes.delete(file.id);
		this.events.push({ type: "file", fileId: file.id, removed: true });
	}

	stageRemoteRename(oldPath: string, newPath: string, opts?: { isFolder?: boolean }): void {
		const match = opts?.isFolder
			? (n: GoogleDriveFile) => n.name === oldPath && n.mimeType === FOLDER_MIME
			: (n: GoogleDriveFile) => n.name === oldPath;
		const file = [...this.nodes.values()].find(match);
		if (!file) throw new Error(`stageRemoteRename: no such path "${oldPath}"`);
		const renamed = { ...file, name: newPath.split("/").pop()! };
		this.place(renamed, this.contents.get(file.id));
		this.events.push({ type: "file", fileId: file.id, removed: false, file: renamed });
	}

	stageRemoteRecreateWithNewId(path: string): void {
		const file = [...this.nodes.values()].find((n) => n.name === path);
		if (!file) throw new Error(`stageRemoteRecreateWithNewId: no such path "${path}"`);
		this.nodes.delete(file.id);
		this.events.push({ type: "file", fileId: file.id, removed: true });
		const id = this.id("f");
		const created: GoogleDriveFile = { id, name: path, mimeType: "text/plain", parents: [ROOT], modifiedTime: MODIFIED };
		this.place(created);
		this.events.push({ type: "file", fileId: id, removed: false, file: created });
	}

	failNextDeltaAfterFirstPage(): void {
		this.failAfterFirstPage = true;
	}

	stageCollision(claimants: readonly CollisionClaimant[], route: CollisionRoute): void {
		if (route === "expired") this.expireNextDelta = true;
		for (const claimant of claimants) {
			const parents = claimant.orphaned
				? [VANISHED_PARENT_ID]
				: [...(claimant.alsoParentedBy ?? []), claimant.parentId ?? ROOT];
			const file: GoogleDriveFile = {
				id: claimant.id,
				name: claimant.name,
				mimeType: claimant.isFolder ? FOLDER_MIME : "text/plain",
				parents,
				modifiedTime: MODIFIED,
			};
			this.place(file);
			if (claimant.orphaned) this.vanished.add(claimant.id);
			if (route === "delta") this.events.push({ type: "file", fileId: claimant.id, removed: false, file });
		}
	}

	// ── Provider seams ──

	getChangesStartToken(): Promise<string> {
		return Promise.resolve(`c${this.events.length}`);
	}

	listChanges(from: string, pageToken?: string): Promise<{ changes: GoogleDriveChange[]; nextPageToken?: string; newStartPageToken?: string }> {
		if (this.expireNextDelta) {
			this.expireNextDelta = false;
			return Promise.reject(Object.assign(new Error("Gone"), { status: 410 }));
		}
		if (pageToken === "contract-second-page") {
			this.failAfterFirstPage = false;
			return Promise.reject(new Error("injected later page failure"));
		}
		const idx = from.startsWith("c") ? Number(from.slice(1)) : 0;
		if (this.failAfterFirstPage) {
			return Promise.resolve({ changes: this.events.slice(idx, idx + 1), nextPageToken: "contract-second-page" });
		}
		return Promise.resolve({ changes: this.events.slice(idx), newStartPageToken: `c${this.events.length}` });
	}

	listAllFiles(folderId: string): Promise<GoogleDriveFile[]> {
		return Promise.resolve(this.subtree(folderId));
	}

	getFile(fileId: string): Promise<GoogleDriveFile> {
		if (fileId === ROOT) {
			return Promise.resolve({ id: ROOT, name: "", mimeType: FOLDER_MIME, parents: [], trashed: false });
		}
		const file = this.nodes.get(fileId);
		if (!file) return Promise.reject(Object.assign(new Error(`File not found: ${fileId}`), { status: 404 }));
		// Capture the pre-change file, then let a concurrent write land immediately
		// after this observation.
		const stale = this.copy(file);
		const afterRead = this.afterRead;
		this.afterRead = undefined;
		afterRead?.(fileId);
		return Promise.resolve(stale);
	}

	listChildrenByName(parentId: string, name: string): Promise<GoogleDriveFile[]> {
		return Promise.resolve([...this.nodes.values()]
			.filter((n) => n.parents?.includes(parentId) && n.name === name)
			.map((n) => this.copy(n)));
	}

	createFolder(name: string, parentId: string): Promise<GoogleDriveFile> {
		const file: GoogleDriveFile = { id: this.id("d"), name, mimeType: FOLDER_MIME, parents: [parentId], modifiedTime: MODIFIED };
		this.place(file);
		return Promise.resolve(this.copy(file));
	}

	async uploadFile(name: string, parentId: string, content: ArrayBuffer, mimeType: string, existingFileId?: string, mtime?: number): Promise<GoogleDriveFile> {
		const id = existingFileId ?? this.id("f");
		const file: GoogleDriveFile = {
			id,
			name,
			mimeType,
			parents: [parentId],
			size: String(content.byteLength),
			modifiedTime: new Date(mtime ?? 0).toISOString(),
			md5Checksum: await sha256(content),
		};
		this.place(file, content);
		return this.copy(file);
	}

	updateFileMetadata(fileId: string, metadata: { name?: string }, addParents?: string, removeParents?: string): Promise<GoogleDriveFile> {
		const current = this.nodes.get(fileId);
		if (!current) return Promise.reject(Object.assign(new Error(`File not found: ${fileId}`), { status: 404 }));
		const file = { ...current, parents: current.parents ? [...current.parents] : undefined };
		if (metadata.name !== undefined) file.name = metadata.name;
		if (removeParents) file.parents = (file.parents ?? []).filter((p) => p !== removeParents);
		if (addParents) file.parents = [...(file.parents ?? []), addParents];
		this.place(file, this.contents.get(fileId));
		return Promise.resolve(this.copy(file));
	}

	deleteFile(fileId: string): Promise<void> {
		for (const id of [fileId, ...this.descendantsOf(fileId)]) {
			this.nodes.delete(id);
			this.contents.delete(id);
		}
		return Promise.resolve();
	}

	downloadFile(fileId: string): Promise<ArrayBuffer> {
		const content = this.contents.get(fileId);
		return content !== undefined
			? Promise.resolve(content.slice(0))
			: Promise.reject(Object.assign(new Error(`No content for ${fileId}`), { status: 404 }));
	}

	// ── Test-only introspection ──

	/** Simulate a concurrent server change: advance the file's version in place. */
	touchVersion(id: string): void {
		const file = this.nodes.get(id);
		if (file) this.place({ ...file }, this.contents.get(id));
	}

	/** Simulate a provider that reports no version evidence. */
	clearVersion(id: string): void {
		const file = this.nodes.get(id);
		if (file) {
			this.versionSeq.delete(id);
			this.nodes.set(id, { ...file, version: undefined });
		}
	}

	/** Simulate a concurrent remote write that advances the file's version. */
	concurrentWrite(id: string, content: string): void {
		const file = this.nodes.get(id);
		if (file) this.place({ ...file }, bytes(content));
	}

	afterNextRead(ref: string, action: () => void): void {
		this.afterRead = (observed) => {
			if (observed === ref) action();
		};
	}

	contentOf(id: string): string | null {
		const content = this.contents.get(id);
		return content === undefined ? null : new TextDecoder().decode(content);
	}

	nameOf(id: string): string | null {
		return this.nodes.get(id)?.name ?? null;
	}

	rawVersion(id: string): string | undefined {
		return this.nodes.get(id)?.version;
	}

	replaceWithNewId(path: string): string {
		const old = [...this.nodes.values()].find((n) => n.name === path);
		if (old) this.nodes.delete(old.id);
		const id = this.id("f");
		this.place({ id, name: path, mimeType: "text/plain", parents: [ROOT], modifiedTime: MODIFIED, size: "3", md5Checksum: "replacement" });
		return id;
	}
}

function clientOf(fake: FakeGoogleDrive): GoogleDriveClient {
	return fake as unknown as GoogleDriveClient;
}

function makeFs(
	fake: FakeGoogleDrive,
	vaultId: string,
	metadataStore: MetadataStore<RemoteObject> = new MetadataStore<RemoteObject>(vaultId, STORE),
): ManagedRemoteFs {
	return new ManagedRemoteFs({
		adapter: new GoogleDriveAdapter(clientOf(fake), ROOT),
		name: "googledrive",
		rootFolderId: ROOT,
		vaultId,
		store: STORE,
		metadataStore,
	});
}

function makeCachingHarness(): RemoteFamilyCachingHarness<RemoteObject> {
	const client = new FakeGoogleDrive();
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
		collision: { kind: "stages", stage: (claimants, route) => client.stageCollision(claimants, route) },
		movedObjectIdentity: {
			determinate: true,
			reason: "normalizeGoogleDriveObject sets id from the Drive file id for files and folders alike.",
		},
		renameOrderings: {
			encoding: "single-entry",
			reason: "Google Drive is id-addressed; changes.list reports a rename as one id-keyed change.",
		},
	};
}

export function registerGoogleDriveManagedIFileSystemContract(): void {
	runIFileSystemContract(
		"ManagedRemoteFs<googledrive>",
		() => makeFs(new FakeGoogleDrive(), "managed-fs"),
		{ computesHashOnStat: false, stableIdentity: true },
	);
}

export function registerGoogleDriveManagedCachingContract(): void {
	runRemoteFamilyCachingContract("ManagedRemoteFs<googledrive>", makeCachingHarness);
}

const GOOGLEDRIVE_CONCURRENCY_CAPABILITIES: RemoteBackendCapabilities = {
	exclusiveCreate: false,
	conditionalContentUpdate: "none",
	conditionalMetadataMutation: false,
	versionBoundRead: "reobserve",
};

function makeConcurrencyHarness(): BackendConcurrencyHarness {
	const client = new FakeGoogleDrive();
	const adapter = new GoogleDriveAdapter(clientOf(client), ROOT);
	const observedToken = async (id: string): Promise<string> => (await adapter.getById(id))?.versionToken ?? "";
	return {
		adapter,
		async seed(path, content) {
			const file = await client.uploadFile(path, ROOT, bytes(content), "text/plain", undefined, Date.now());
			return { id: file.id, versionToken: await observedToken(file.id) };
		},
		async seedFolder(path) {
			const folder = await client.createFolder(path, ROOT);
			return { id: folder.id, versionToken: await observedToken(folder.id) };
		},
		write(id, content) {
			client.concurrentWrite(id, content);
			return Promise.resolve();
		},
		writeAfterNextObservation(id, content) {
			client.afterNextRead(id, () => client.concurrentWrite(id, content));
		},
		writeMetadataAfterNextObservation(id) {
			client.afterNextRead(id, () => client.touchVersion(id));
		},
		contentOf(id) {
			return Promise.resolve(client.contentOf(id));
		},
		nameOf(id) {
			return client.nameOf(id);
		},
		removeEvidence(id) {
			client.clearVersion(id);
		},
		removeVersionEvidenceKeepContent() {},
		destination(name): DestinationAddress {
			return { addressing: "parent_id", parentId: ROOT, name };
		},
		directoryVersionEvidence: true,
		providerDirectoryToken: (id) => {
			const version = client.rawVersion(id);
			return version ? `googledrive:v:${version}` : undefined;
		},
	};
}

export function registerGoogleDriveManagedConcurrencyContract(): void {
	runBackendConcurrencyContract("googledrive adapter", GOOGLEDRIVE_CONCURRENCY_CAPABILITIES, makeConcurrencyHarness);
}

export function registerGoogleDriveManagedChangeDetectionContract(): void {
	runRemoteChangeDetectionContract(
		"ManagedRemoteFs<googledrive>",
		async () => {
			await Promise.resolve();
			const fs = makeFs(new FakeGoogleDrive(), "managed-change");
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

interface GooglePriorityHarness extends PriorityObservationContractHarness {
	assertIdentityReadRoute(): void;
}

async function makePriorityHarness(scenario: PriorityObservationScenario): Promise<GooglePriorityHarness> {
	const client = new FakeGoogleDrive();
	const content = bytes("priority");
	const created = await client.uploadFile("note.md", ROOT, content, "text/plain", undefined, Date.now());
	const fs = makeFs(client, "managed-priority");
	const download = vi.spyOn(client, "downloadFile");
	if (scenario === "unverifiable") client.clearVersion(created.id);
	let replacementKey = "replacement";
	if (scenario === "missing") void client.deleteFile(created.id);
	if (scenario === "replacement") replacementKey = client.replaceWithNewId("note.md");
	if (scenario === "changed-during-read") {
		download.mockImplementation((id: string) => {
			client.touchVersion(id);
			return Promise.resolve(content.slice(0));
		});
	}
	const expectedToken = `googledrive:v:${created.version!}`;
	return {
		fs,
		request: { path: "note.md", identityKey: created.id },
		expectedToken,
		expectedContent: content.slice(0),
		replacementIdentityKey: replacementKey,
		assertIdentityReadRoute: () => {
			expect(download).toHaveBeenCalledWith(created.id);
		},
	};
}

export function registerGoogleDriveManagedPriorityObservationContract(): void {
	runPriorityObservationContract("ManagedRemoteFs<googledrive>", makePriorityHarness);

	describe("ManagedRemoteFs<googledrive> detached priority observation", () => {
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
