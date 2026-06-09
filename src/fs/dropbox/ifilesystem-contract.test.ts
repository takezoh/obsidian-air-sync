import { vi } from "vitest";
import type { DropboxClient } from "./client";
import type { DropboxEntry, DropboxListFolderResponse } from "./types";
import { DropboxFs } from "./index";
import { untagged } from "./test-helpers";
import { sha256 } from "../../utils/hash";
import { runIFileSystemContract } from "../ifilesystem-contract";

vi.mock("obsidian");

const ROOT_ID = "id:root";
const ROOT_PATH = "/root";

/** A single in-memory file/folder node, keyed in the tree by its vault-relative path. */
interface FakeNode {
	id: string;
	isFolder: boolean;
	content?: ArrayBuffer;
	size: number;
	/** ISO `server_modified`/`client_modified`; full-ms so `parseDropboxTime` round-trips. */
	modified: string;
	contentHash: string;
	rev: string;
}

/**
 * A CRUD-faithful, in-memory stand-in for {@link DropboxClient} — a vault-relative
 * path → node tree over which the REAL DropboxFs runs unchanged, plus an id→path
 * index so download/delete address by the stable `id:` (exactly as the cache's
 * `idAt` hands them back). It implements only the seams the FS calls and never
 * touches the network; the delta-only client in crash-safety-contract.test.ts is
 * the read-side ancestor of this.
 *
 * Dropbox addresses every op by `id:<folderid>/<subpath>` ({@link DropboxFs.addr});
 * `relOf` strips that back to the vault-relative key. The delta log is intentionally
 * a no-op (`list_folder/continue` returns nothing): every mutating op already updated
 * the tree, so a subsequent `list()` replay has nothing to add. Delta correctness is
 * the crash-safety contract's job, not this one's.
 */
function makeFakeDropboxClient(): DropboxClient {
	const nodes = new Map<string, FakeNode>(); // vault-relative path → node (root not stored)
	const byId = new Map<string, string>(); // stable id → vault-relative path
	let idSeq = 0;
	const newId = (): string => `id:f${++idSeq}`;

	// "id:root/sub/x" → "sub/x"; "id:root" → "".
	const relOf = (addr: string): string => {
		if (addr === ROOT_ID) return "";
		const prefix = `${ROOT_ID}/`;
		if (addr.startsWith(prefix)) return addr.slice(prefix.length);
		throw new Error(`Unexpected Dropbox address: ${addr}`);
	};
	const absOf = (rel: string): string => (rel ? `${ROOT_PATH}/${rel}` : ROOT_PATH);
	const nameOf = (rel: string): string => rel.split("/").pop()!;
	const descendantsOf = (rel: string): string[] =>
		[...nodes.keys()].filter((p) => p.startsWith(`${rel}/`));

	const toEntry = (rel: string, n: FakeNode): DropboxEntry =>
		n.isFolder
			? { ".tag": "folder", id: n.id, name: nameOf(rel), path_lower: absOf(rel).toLowerCase(), path_display: absOf(rel) }
			: {
					".tag": "file",
					id: n.id,
					name: nameOf(rel),
					path_lower: absOf(rel).toLowerCase(),
					path_display: absOf(rel),
					rev: n.rev,
					size: n.size,
					client_modified: n.modified,
					server_modified: n.modified,
					content_hash: n.contentHash,
				};

	const client = {
		// refreshRootPath / assertRootAlive resolve the vault folder by its stable id.
		getMetadata: (ref: string): Promise<DropboxEntry> => {
			if (ref !== ROOT_ID) return Promise.reject(new Error(`get_metadata not_found: ${ref}`));
			return Promise.resolve({ ".tag": "folder", id: ROOT_ID, name: "root", path_lower: ROOT_PATH, path_display: ROOT_PATH });
		},
		getLatestCursor: (_path: string, _recursive: boolean): Promise<string> => Promise.resolve("c1"),
		listFolderAll: (_path: string, _recursive: boolean): Promise<DropboxEntry[]> =>
			Promise.resolve([...nodes.entries()].map(([rel, n]) => toEntry(rel, n))),
		listFolderContinue: (cursor: string): Promise<DropboxListFolderResponse> =>
			Promise.resolve({ entries: [], cursor, has_more: false }),
		upload: async (addr: string, content: ArrayBuffer, mtime: number): Promise<DropboxEntry> => {
			const rel = relOf(addr);
			const existing = nodes.get(rel);
			const id = existing && !existing.isFolder ? existing.id : newId();
			const node: FakeNode = {
				id,
				isFolder: false,
				content: content.slice(0),
				size: content.byteLength,
				modified: new Date(mtime).toISOString(),
				contentHash: await sha256(content),
				rev: `rev${id}`,
			};
			nodes.set(rel, node);
			byId.set(id, rel);
			return toEntry(rel, node);
		},
		createFolder: (addr: string): Promise<DropboxEntry> => {
			const rel = relOf(addr);
			const node: FakeNode = { id: newId(), isFolder: true, size: 0, modified: "", contentHash: "", rev: "" };
			nodes.set(rel, node);
			byId.set(node.id, rel);
			return Promise.resolve(toEntry(rel, node));
		},
		move: (fromAddr: string, toAddr: string): Promise<DropboxEntry> => {
			const fromRel = relOf(fromAddr);
			const toRel = relOf(toAddr);
			if (!nodes.has(fromRel)) return Promise.reject(new Error(`move from_lookup/not_found: ${fromRel}`));
			const captured = [fromRel, ...descendantsOf(fromRel)].map((p) => [p, nodes.get(p)!] as const);
			for (const [p] of captured) nodes.delete(p);
			for (const [p, n] of captured) {
				const dst = `${toRel}${p.slice(fromRel.length)}`;
				nodes.set(dst, n);
				byId.set(n.id, dst);
			}
			// `move_v2` returns BARE metadata with no `.tag` discriminator — mirror
			// DropboxClient.move's `return res.metadata` (unlike upload/createFolder,
			// which the real client DOES re-stamp). DropboxFs.rename re-stamps `.tag`
			// from the known prior type, so returning it untagged here keeps that stamp
			// load-bearing instead of letting the fake mask its removal.
			const moved = nodes.get(toRel)!;
			return Promise.resolve(untagged(toEntry(toRel, moved)) as DropboxEntry);
		},
		download: (fileId: string): Promise<ArrayBuffer> => {
			const rel = byId.get(fileId);
			const node = rel !== undefined ? nodes.get(rel) : undefined;
			return node?.content !== undefined
				? Promise.resolve(node.content.slice(0))
				: Promise.reject(new Error(`download path/not_found: ${fileId}`));
		},
		deletePath: (fileId: string): Promise<void> => {
			const rel = byId.get(fileId);
			if (rel === undefined) return Promise.resolve(); // idempotent (already gone)
			for (const p of [rel, ...descendantsOf(rel)]) {
				const node = nodes.get(p);
				if (node) byId.delete(node.id);
				nodes.delete(p);
			}
			return Promise.resolve();
		},
	};
	return client as unknown as DropboxClient;
}

// Run the shared IFileSystem contract against the REAL DropboxFs over the fake
// Dropbox. Remote backends report hash:"" + remoteChecksum from stat(), so
// computesHashOnStat is false. No metadataStore: the CRUD surface is pure in-memory
// cache work; the checkpoint machinery has its own contract.
runIFileSystemContract("DropboxFs", () => new DropboxFs(makeFakeDropboxClient(), ROOT_ID), {
	computesHashOnStat: false,
});
