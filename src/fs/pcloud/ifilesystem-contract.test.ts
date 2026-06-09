import { vi } from "vitest";
import type { PCloudClient } from "./client";
import type { PCloudEntry } from "./types";
import { PCloudFs } from "./index";
import { pcFile, pcFolder } from "./test-helpers";
import { runIFileSystemContract } from "../ifilesystem-contract";

vi.mock("obsidian");

const ROOT_FOLDER_ID = 0;

/**
 * A cheap CONTENT-deterministic digest standing in for pCloud's opaque 64-bit
 * per-content hash: same bytes → same value, different bytes → (almost always)
 * different. Faithfulness matters because pCloud's `hash` is the only content-change
 * signal (stat reports hash:""), so a fake that left it stale across an overwrite
 * would mask a change-detection regression.
 */
function pcloudContentHash(content: ArrayBuffer): number {
	return new Uint8Array(content).reduce((h, b) => (Math.imul(h, 31) + b) | 0, content.byteLength) >>> 0;
}

interface FileNode {
	fileid: number;
	name: string;
	parent: number;
	content: ArrayBuffer;
	size: number;
	/** ISO `modified`; full-ms so `parsePCloudTime` (Date.parse) round-trips exactly. */
	modified: string;
	hash: number;
}
interface FolderNode {
	folderid: number;
	name: string;
	parent: number;
}

/**
 * A CRUD-faithful, in-memory stand-in for {@link PCloudClient} — files and folders
 * keyed by their numeric pCloud id, over which the REAL PCloudFs runs unchanged. It
 * implements only the seams the FS calls and never touches the network; the
 * delta-only client in remote-change-detection.test.ts is the read-side ancestor of
 * this.
 *
 * pCloud is id-addressed: write/mkdir/rename target a parent folderid + name; the FS
 * resolves a cache id (`f<fileid>`/`d<folderid>`) and the seams strip the type prefix
 * to the bare numeric id for download/delete (see {@link PCloudFs.downloadFile}/
 * {@link PCloudFs.deleteRemote}). The `diff` feed is a no-op (`listDiff` returns
 * nothing): every mutating op already updated the tree, so a subsequent `list()`
 * replay has nothing to add. Delta correctness is the crash-safety contract's job.
 */
function makeFakePCloudClient(): PCloudClient {
	const files = new Map<number, FileNode>(); // fileid → node
	const folders = new Map<number, FolderNode>(); // folderid → node
	let idSeq = 0; // one counter for both id spaces, so no f<n>/d<n> can collide

	// Reuse the shared entry builders (test-helpers) so the fake can't drift from the
	// PCloudEntry shape the rest of the suite uses; the node carries the dynamic fields.
	const fileEntry = (n: FileNode): PCloudEntry =>
		pcFile(n.fileid, n.name, n.parent, { size: n.size, modified: n.modified, hash: n.hash });
	const folderEntry = (n: FolderNode): PCloudEntry => pcFolder(n.folderid, n.name, n.parent);

	/** Folder ids of `target` plus every folder transitively under it. */
	const folderSubtree = (target: number): Set<number> => {
		const ids = new Set<number>([target]);
		for (let changed = true; changed; ) {
			changed = false;
			for (const f of folders.values()) {
				if (ids.has(f.parent) && !ids.has(f.folderid)) {
					ids.add(f.folderid);
					changed = true;
				}
			}
		}
		return ids;
	};

	const buildContents = (parent: number): PCloudEntry[] => [
		...[...folders.values()]
			.filter((f) => f.parent === parent)
			.map((f) => ({ ...folderEntry(f), contents: buildContents(f.folderid) })),
		...[...files.values()].filter((f) => f.parent === parent).map(fileEntry),
	];

	const client = {
		// fullList(): a recursive listfolder of the root → root with nested `contents`.
		listFolder: (_folderId: string, _recursive?: boolean): Promise<PCloudEntry> =>
			Promise.resolve({
				id: `d${ROOT_FOLDER_ID}`,
				name: "/",
				isfolder: true,
				folderid: ROOT_FOLDER_ID,
				contents: buildContents(ROOT_FOLDER_ID),
			}),
		getDiffBaseline: (): Promise<string> => Promise.resolve("0"),
		listDiff: (_diffId: string): Promise<{ result: number; diffid: number; entries: [] }> =>
			Promise.resolve({ result: 0, diffid: 0, entries: [] }),
		uploadFile: (folderId: string, name: string, content: ArrayBuffer, mtime: number): Promise<PCloudEntry> => {
			const parent = Number(folderId);
			let node = [...files.values()].find((f) => f.parent === parent && f.name === name);
			if (node) {
				node.content = content.slice(0);
				node.size = content.byteLength;
				node.modified = new Date(mtime).toISOString();
				node.hash = pcloudContentHash(content); // overwrite → new content → new hash (like real pCloud)
			} else {
				node = {
					fileid: ++idSeq,
					name,
					parent,
					content: content.slice(0),
					size: content.byteLength,
					modified: new Date(mtime).toISOString(),
					hash: pcloudContentHash(content),
				};
				files.set(node.fileid, node);
			}
			return Promise.resolve(fileEntry(node));
		},
		createFolderIfNotExists: (parentFolderId: string, name: string): Promise<PCloudEntry> => {
			const parent = Number(parentFolderId);
			let node = [...folders.values()].find((f) => f.parent === parent && f.name === name);
			if (!node) {
				node = { folderid: ++idSeq, name, parent };
				folders.set(node.folderid, node);
			}
			return Promise.resolve(folderEntry(node));
		},
		downloadFile: (fileId: string): Promise<ArrayBuffer> => {
			const node = files.get(Number(fileId));
			return node ? Promise.resolve(node.content.slice(0)) : Promise.reject(new Error(`download not found: ${fileId}`));
		},
		deleteFile: (fileId: string): Promise<void> => {
			files.delete(Number(fileId));
			return Promise.resolve();
		},
		deleteFolderRecursive: (folderId: string): Promise<void> => {
			const doomed = folderSubtree(Number(folderId));
			for (const fid of doomed) folders.delete(fid);
			for (const [id, f] of files) if (doomed.has(f.parent)) files.delete(id);
			return Promise.resolve();
		},
		renameFile: (fileId: string, toName?: string, toFolderId?: string): Promise<PCloudEntry> => {
			const node = files.get(Number(fileId));
			if (!node) return Promise.reject(new Error(`renameFile not found: ${fileId}`));
			if (toName !== undefined) node.name = toName;
			if (toFolderId !== undefined) node.parent = Number(toFolderId);
			return Promise.resolve(fileEntry(node));
		},
		renameFolder: (folderId: string, toName?: string, toFolderId?: string): Promise<PCloudEntry> => {
			const node = folders.get(Number(folderId));
			if (!node) return Promise.reject(new Error(`renameFolder not found: ${folderId}`));
			if (toName !== undefined) node.name = toName;
			if (toFolderId !== undefined) node.parent = Number(toFolderId);
			return Promise.resolve(folderEntry(node));
		},
	};
	return client as unknown as PCloudClient;
}

// Run the shared IFileSystem contract against the REAL PCloudFs over the fake pCloud.
// Remote backends report hash:"" + remoteChecksum from stat(), so computesHashOnStat
// is false. No metadataStore: the CRUD surface is pure in-memory cache work; the
// checkpoint machinery has its own contract.
runIFileSystemContract("PCloudFs", () => new PCloudFs(makeFakePCloudClient(), String(ROOT_FOLDER_ID)), {
	computesHashOnStat: false,
});
