import { vi } from "vitest";
import type { OneDriveClient } from "./client";
import type { OneDriveItem, OneDriveDeltaResponse } from "./types";
import { OneDriveFs } from "./index";
import { quickXorHashBase64 } from "../../utils/quickxor";
import { runIFileSystemContract } from "../ifilesystem-contract";

vi.mock("obsidian");

const ROOT_ID = "root";

/** An in-memory driveItem node, keyed by its stable id. */
interface FakeNode {
	id: string;
	name: string;
	parentId: string;
	isFolder: boolean;
	content?: ArrayBuffer;
	size: number;
	mtime: string;
	quickXorHash?: string;
}

/**
 * A CRUD-faithful, in-memory stand-in for {@link OneDriveClient} — an id-addressed
 * driveItem store over which the REAL OneDriveFs runs unchanged. It models the Graph
 * subset the FS calls: id + parentReference.id addressing, quickXorHash (what real
 * personal OneDrive returns — NOT sha1Hash, per ADR 0003 fake fidelity), mtime
 * preserved via a PATCH-equivalent on upload, and a no-op delta (every mutating op
 * already updated the store, so a `list()` replay has nothing to add — delta
 * correctness is the crash-safety contract's job, not this one's).
 */
function makeFakeOneDriveClient(): OneDriveClient {
	const nodes = new Map<string, FakeNode>();
	nodes.set(ROOT_ID, { id: ROOT_ID, name: "root", parentId: "", isFolder: true, size: 0, mtime: "" });
	let idSeq = 0;
	const newId = (): string => `id${++idSeq}`;

	const toItem = (n: FakeNode): OneDriveItem =>
		n.isFolder
			? { id: n.id, name: n.name, parentReference: { id: n.parentId, path: "/drive/root:" }, folder: { childCount: 0 } }
			: {
					id: n.id,
					name: n.name,
					size: n.size,
					parentReference: { id: n.parentId, path: "/drive/root:" },
					file: { hashes: { quickXorHash: n.quickXorHash } },
					fileSystemInfo: { lastModifiedDateTime: n.mtime },
					lastModifiedDateTime: n.mtime,
				};

	const childByName = (parentId: string, name: string): FakeNode | undefined =>
		[...nodes.values()].find((n) => n.parentId === parentId && n.name === name);

	const descendantsOf = (id: string): FakeNode[] => {
		const out: FakeNode[] = [];
		const stack = [id];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			for (const n of nodes.values()) {
				if (n.parentId === cur) { out.push(n); stack.push(n.id); }
			}
		}
		return out;
	};

	const client = {
		getStartCursor: (_rootId: string): Promise<string> => Promise.resolve("c0"),
		// Full enumeration: every node except the root itself.
		fullList: (_rootId: string): Promise<OneDriveItem[]> =>
			Promise.resolve([...nodes.values()].filter((n) => n.id !== ROOT_ID).map(toItem)),
		fetchDelta: (_rootId: string, link: string): Promise<OneDriveDeltaResponse> =>
			Promise.resolve({ value: [], "@odata.deltaLink": `https://g?token=${link}` }),
		getItem: (id: string): Promise<OneDriveItem> => {
			const n = nodes.get(id);
			return n ? Promise.resolve(toItem(n)) : Promise.reject(new Error(`itemNotFound: ${id}`));
		},
		getChildByName: (parentId: string, name: string): Promise<OneDriveItem> => {
			const n = childByName(parentId, name);
			return n ? Promise.resolve(toItem(n)) : Promise.reject(new Error(`itemNotFound: ${name}`));
		},
		upload: (parentId: string, name: string, content: ArrayBuffer, mtime: number): Promise<OneDriveItem> => {
			const existing = childByName(parentId, name);
			const id = existing && !existing.isFolder ? existing.id : newId();
			const node: FakeNode = {
				id,
				name,
				parentId,
				isFolder: false,
				content: content.slice(0),
				size: content.byteLength,
				mtime: new Date(mtime).toISOString(),
				quickXorHash: quickXorHashBase64(content),
			};
			nodes.set(id, node);
			return Promise.resolve(toItem(node));
		},
		createFolder: (parentId: string, name: string): Promise<OneDriveItem> => {
			const existing = childByName(parentId, name);
			if (existing) return Promise.resolve(toItem(existing));
			const node: FakeNode = { id: newId(), name, parentId, isFolder: true, size: 0, mtime: "" };
			nodes.set(node.id, node);
			return Promise.resolve(toItem(node));
		},
		move: (id: string, name: string | undefined, newParentId: string | undefined): Promise<OneDriveItem> => {
			const n = nodes.get(id);
			if (!n) return Promise.reject(new Error(`itemNotFound: ${id}`));
			if (name !== undefined) n.name = name;
			if (newParentId !== undefined) n.parentId = newParentId;
			return Promise.resolve(toItem(n));
		},
		download: (id: string): Promise<ArrayBuffer> => {
			const n = nodes.get(id);
			return n?.content !== undefined
				? Promise.resolve(n.content.slice(0))
				: Promise.reject(new Error(`itemNotFound: ${id}`));
		},
		deleteItem: (id: string): Promise<void> => {
			for (const d of [nodes.get(id), ...descendantsOf(id)]) {
				if (d) nodes.delete(d.id);
			}
			return Promise.resolve();
		},
	};
	return client as unknown as OneDriveClient;
}

// Run the shared IFileSystem contract against the REAL OneDriveFs over the fake
// OneDrive. Remote backends report hash:"" + remoteChecksum from stat(), so
// computesHashOnStat is false. No metadataStore: the CRUD surface is pure in-memory
// cache work; the checkpoint machinery has its own contract.
runIFileSystemContract("OneDriveFs", () => new OneDriveFs(makeFakeOneDriveClient(), ROOT_ID), {
	computesHashOnStat: false,
});
