import "fake-indexeddb/auto";
import { vi } from "vitest";
import type { GoogleDriveClient } from "../../../src/fs/googledrive/client";
import type { GoogleDriveFile, GoogleDriveChange } from "../../../src/fs/googledrive/types";
import { FOLDER_MIME } from "../../../src/fs/googledrive/types";
import { MetadataStore } from "../../../src/store/metadata-store";
import { GoogleDriveFs } from "../../../src/fs/googledrive";
import { runCachingRemoteFsContract } from "../contracts/caching-remote-fs.contract";
import type { CachingRemoteFsHarness } from "../contracts/caching-remote-fs.contract";

vi.mock("obsidian");

/** A parent id the bound root never reaches — the fake's "somewhere else in the Drive". */
const OUTSIDE_ID = "outside";

const MODIFIED_TIME = "2024-01-01T00:00:00.000Z";

/** One baseline item: `name` is its path segment, `parentId` places it in the tree. */
function gdFile(id: string, name: string, parentId: string): GoogleDriveFile {
	return { id, name, mimeType: "text/plain", parents: [parentId], modifiedTime: MODIFIED_TIME };
}

function gdFolder(id: string, name: string, parentId: string): GoogleDriveFile {
	return { id, name, mimeType: FOLDER_MIME, parents: [parentId], modifiedTime: MODIFIED_TIME };
}

// Run the shared base crash-safety contract against the REAL GoogleDriveFs (not the
// mock backend), via a minimal GoogleDriveClient stub over an in-memory remote — a baseline
// of Google Drive files plus an append-only changes.list log. This proves the A1 lift kept
// Google Drive's ADR 0001 path-1 behaviour intact through the new seams, and answers
// "the contract is only ever run by the mock". The same shared lifecycle covers
// restart and same-process abort/reload.
function makeGoogleDriveHarness(): CachingRemoteFsHarness<GoogleDriveFile> {
	const baseline = new Map<string, GoogleDriveFile>();
	const events: GoogleDriveChange[] = [];
	/** Folder path → id, for folders seeded outside the bound root. */
	const outsideFolders = new Map<string, string>();
	let idSeq = 0;
	let failAfterFirstPage = false;
	const head = () => `c${events.length}`;

	/**
	 * The real `listAllFiles(folderId)` walks that folder's subtree and returns its
	 * DESCENDANTS (not the folder itself), parents before children. Honouring the
	 * argument is what makes the fake faithful in both directions: a root listing
	 * excludes anything parented outside the root, and the incremental re-listing of
	 * an entered folder sees that folder's subtree rather than the whole Drive.
	 */
	const listSubtree = (folderId: string): GoogleDriveFile[] => {
		const descendants: GoogleDriveFile[] = [];
		const folderIds = [folderId];
		for (let i = 0; i < folderIds.length; i++) {
			const parentId = folderIds[i]!;
			for (const file of baseline.values()) {
				if (!file.parents?.includes(parentId)) continue;
				descendants.push(file);
				if (file.mimeType === FOLDER_MIME) folderIds.push(file.id);
			}
		}
		return descendants;
	};

	const client = {
		listAllFiles: (folderId: string) => Promise.resolve(listSubtree(folderId)),
		getFile: (id: string) => Promise.resolve({
			id, name: "root", mimeType: FOLDER_MIME, parents: [],
			modifiedTime: "2024-01-01T00:00:00.000Z",
		}),
		getChangesStartToken: () => Promise.resolve(head()),
		listChanges: (from: string, pageToken?: string) => {
			if (pageToken === "contract-second-page") {
				failAfterFirstPage = false;
				return Promise.reject(new Error("injected later page failure"));
			}
			const idx = from.startsWith("c") ? Number(from.slice(1)) : 0;
			if (failAfterFirstPage) {
				return Promise.resolve({
					changes: events.slice(idx, idx + 1),
					nextPageToken: "contract-second-page",
				});
			}
			return Promise.resolve({ changes: events.slice(idx), newStartPageToken: head() });
		},
	} as unknown as GoogleDriveClient;

	return {
		makeStore: (id) => new MetadataStore<GoogleDriveFile>(id, { dbNamePrefix: "air-sync-googledrive-contract", version: 1 }),
		makeFs: (store) => new GoogleDriveFs(client, "root", undefined, store),
		seedFile: (path) => {
			const id = `f${++idSeq}`;
			baseline.set(id, gdFile(id, path, "root"));
		},
		seedFolderWithChild: (folderPath, childName) => {
			const folderId = `d${++idSeq}`;
			const childId = `f${++idSeq}`;
			baseline.set(folderId, gdFolder(folderId, folderPath, "root"));
			baseline.set(childId, gdFile(childId, childName, folderId));
		},
		// The subtree exists in the Drive but hangs off a parent the bound root never
		// reaches, so the scoped listing above cannot see it and changes.list — driven
		// only by `events` — reports nothing about it.
		seedFolderOutsideRoot: (folderPath) => {
			const folderId = `d${++idSeq}`;
			const subId = `d${++idSeq}`;
			const aId = `f${++idSeq}`;
			const bId = `f${++idSeq}`;
			baseline.set(folderId, gdFolder(folderId, folderPath, OUTSIDE_ID));
			baseline.set(aId, gdFile(aId, "a.md", folderId));
			baseline.set(subId, gdFolder(subId, "sub", folderId));
			baseline.set(bId, gdFile(bId, "b.md", subId));
			outsideFolders.set(folderPath, folderId);
		},
		// live-probe-googledrive: an account-wide changes.list drain reports EXACTLY ONE
		// change for a folder moved into the root — the folder itself, re-parented. Its
		// descendants keep their own parents, so Drive emits nothing for them.
		stageMoveIntoRoot: (folderPath) => {
			const folderId = outsideFolders.get(folderPath);
			if (!folderId) throw new Error(`stageMoveIntoRoot: no folder seeded outside the root at "${folderPath}"`);
			outsideFolders.delete(folderPath);
			const moved: GoogleDriveFile = { ...baseline.get(folderId)!, parents: ["root"] };
			baseline.set(folderId, moved);
			events.push({ type: "file", fileId: folderId, removed: false, file: moved });
		},
		stageRemoteDelete: (path) => {
			const entry = [...baseline.values()].find((f) => f.name === path);
			if (!entry) throw new Error(`stageRemoteDelete: no such file "${path}"`);
			baseline.delete(entry.id);
			events.push({ type: "file", fileId: entry.id, removed: true });
		},
		failNextDeltaAfterFirstPage: () => { failAfterFirstPage = true; },
		// Google Drive is id-addressed: a rename is a SINGLE change carrying the file's new
		// name. A folder's children keep their parent id (their paths are derived), so they
		// are NOT re-emitted — the cache reparents them from the one folder change.
		stageRemoteRename: (oldPath, newPath, opts) => {
			const match = opts?.isFolder
				? (f: GoogleDriveFile) => f.name === oldPath && f.mimeType === FOLDER_MIME
				: (f: GoogleDriveFile) => f.name === oldPath;
			const entry = [...baseline.values()].find(match);
			if (!entry) throw new Error(`stageRemoteRename: no such path "${oldPath}"`);
			const renamed: GoogleDriveFile = { ...entry, name: newPath };
			baseline.set(entry.id, renamed);
			events.push({ type: "file", fileId: entry.id, removed: false, file: renamed });
		},
	};
}

export function registerGoogleDriveCachingContract(): void {
	runCachingRemoteFsContract("GoogleDriveFs", makeGoogleDriveHarness);
}
