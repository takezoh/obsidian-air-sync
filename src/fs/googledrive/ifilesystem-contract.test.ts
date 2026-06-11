import { vi } from "vitest";
import type { DriveClient } from "./client";
import type { DriveFile } from "./types";
import { FOLDER_MIME } from "./types";
import { GoogleDriveFs } from "./index";
import { sha256 } from "../../utils/hash";
import { runIFileSystemContract } from "../ifilesystem-contract";

vi.mock("obsidian");

/** An Error carrying an HTTP `status`, matching what DriveClient throws. */
function httpError(status: number, message: string): Error {
	return Object.assign(new Error(message), { status });
}

/**
 * A CRUD-faithful, in-memory stand-in for {@link DriveClient} — an id↔path tree
 * (every node carries `name` + `parents`, exactly as the metadata cache resolves
 * paths) over which GoogleDriveFs runs unchanged. It implements the seams the FS
 * actually calls and never touches the network; the read-only crash-safety stub
 * in crash-safety-contract.test.ts is the delta-only ancestor of this.
 *
 * The delta log is intentionally empty: every mutating op already updates the
 * in-memory cache (write/mkdir/rename via setFile, delete via removeTree), so a
 * subsequent `list()` replay has nothing to add. Delta correctness is the
 * crash-safety contract's job, not this one's.
 */
function makeFakeDriveClient(): DriveClient {
	const ROOT = "root";
	const nodes = new Map<string, { file: DriveFile; content?: ArrayBuffer }>();
	let idSeq = 0;
	const newId = (): string => `id${++idSeq}`;
	const copy = (f: DriveFile): DriveFile => ({
		...f,
		parents: f.parents ? [...f.parents] : undefined,
	});
	const childIdsOf = (pid: string): string[] =>
		[...nodes.values()]
			.filter((n) => n.file.parents?.includes(pid))
			.map((n) => n.file.id);
	const descendantsOf = (id: string): string[] => {
		const out: string[] = [];
		const stack = childIdsOf(id);
		while (stack.length) {
			const cur = stack.pop()!;
			out.push(cur);
			stack.push(...childIdsOf(cur));
		}
		return out;
	};

	const client = {
		getChangesStartToken: (): Promise<string> => Promise.resolve("c1"),
		listChanges: (
			_startToken: string,
			_pageToken?: string,
		): Promise<{ changes: never[]; newStartPageToken: string }> =>
			Promise.resolve({ changes: [], newStartPageToken: "c1" }),
		listAllFiles: (_rootId: string): Promise<DriveFile[]> =>
			Promise.resolve([...nodes.values()].map((n) => copy(n.file))),
		getFile: (fileId: string): Promise<DriveFile> => {
			if (fileId === ROOT) {
				return Promise.resolve({
					id: ROOT,
					name: "",
					mimeType: FOLDER_MIME,
					parents: [],
					trashed: false,
				});
			}
			const node = nodes.get(fileId);
			return node
				? Promise.resolve(copy(node.file))
				: Promise.reject(httpError(404, `File not found: ${fileId}`));
		},
		findChildByName: (
			parentId: string,
			name: string,
			mimeType?: string,
		): Promise<DriveFile | null> => {
			const found = [...nodes.values()].find(
				(n) =>
					n.file.parents?.includes(parentId) &&
					n.file.name === name &&
					(mimeType === undefined || n.file.mimeType === mimeType),
			);
			return Promise.resolve(found ? copy(found.file) : null);
		},
		createFolder: (name: string, parentId: string): Promise<DriveFile> => {
			const file: DriveFile = {
				id: newId(),
				name,
				mimeType: FOLDER_MIME,
				parents: [parentId],
			};
			nodes.set(file.id, { file });
			return Promise.resolve(copy(file));
		},
		uploadFile: async (
			name: string,
			parentId: string,
			content: ArrayBuffer,
			mimeType: string,
			existingFileId?: string,
			mtime?: number,
		): Promise<DriveFile> => {
			const id = existingFileId ?? newId();
			const file: DriveFile = {
				id,
				name,
				mimeType,
				parents: [parentId],
				size: String(content.byteLength),
				modifiedTime: new Date(mtime ?? 0).toISOString(),
				md5Checksum: await sha256(content),
			};
			nodes.set(id, { file, content: content.slice(0) });
			return copy(file);
		},
		updateFileMetadata: (
			fileId: string,
			metadata: { name?: string },
			addParents?: string,
			removeParents?: string,
		): Promise<DriveFile> => {
			const node = nodes.get(fileId);
			if (!node) {
				return Promise.reject(httpError(404, `File not found: ${fileId}`));
			}
			if (metadata.name !== undefined) node.file.name = metadata.name;
			if (removeParents) {
				node.file.parents = (node.file.parents ?? []).filter(
					(p) => p !== removeParents,
				);
			}
			if (addParents) {
				node.file.parents = [...(node.file.parents ?? []), addParents];
			}
			// This fake leaves modifiedTime untouched on a rename/move. The REAL Drive
			// does NOT — files.update bumps modifiedTime to "now" (verified by the
			// opt-in e2e, ADR 0003). The contract therefore pins mtime-through-rename
			// only for local-storage backends (computesHashOnStat); for remotes (this
			// fake included) it just requires a finite timestamp, so this divergence is
			// unchecked here, not a contradiction.
			return Promise.resolve(copy(node.file));
		},
		deleteFile: (fileId: string, _permanent?: boolean): Promise<void> => {
			for (const id of [fileId, ...descendantsOf(fileId)]) nodes.delete(id);
			return Promise.resolve();
		},
		downloadFile: (fileId: string): Promise<ArrayBuffer> => {
			const node = nodes.get(fileId);
			return node?.content !== undefined
				? Promise.resolve(node.content.slice(0))
				: Promise.reject(httpError(404, `File not found: ${fileId}`));
		},
	};
	return client as unknown as DriveClient;
}

// Run the shared IFileSystem contract against the REAL GoogleDriveFs over the
// fake Drive. Remote backends report hash:"" + remoteChecksum from stat(), so
// computesHashOnStat is false. No metadataStore: the CRUD surface is pure
// in-memory cache work; the checkpoint machinery has its own contract.
runIFileSystemContract(
	"GoogleDriveFs",
	() => new GoogleDriveFs(makeFakeDriveClient(), "root"),
	{ computesHashOnStat: false },
);
