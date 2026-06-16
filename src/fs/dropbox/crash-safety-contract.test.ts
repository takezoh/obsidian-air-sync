import "fake-indexeddb/auto";
import { vi } from "vitest";
import type { DropboxClient } from "./client";
import type { DropboxEntry, DropboxListFolderResponse } from "./types";
import { MetadataStore } from "../../store/metadata-store";
import { DropboxFs } from "./index";
import { dbxFile, dbxFolder, dbxDeleted } from "./test-helpers";
import { runCachingRemoteFsContract } from "../caching/remote-fs-contract";
import type { CachingRemoteFsHarness } from "../caching/remote-fs-contract";

vi.mock("obsidian");

const ROOT_ID = "id:root";
const ROOT_PATH = "/root";

/**
 * Run the shared base crash-safety contract (ADR 0001) against the REAL DropboxFs over
 * a minimal in-memory DropboxClient — a baseline of file entries plus an append-only
 * `list_folder/continue` delta log. This proves the D1 rebase kept Dropbox's ADR 0001
 * path-1 behaviour intact *through the Dropbox seams* (getStartCursor / fullList /
 * fetchChanges + the refreshRootPath re-anchor). Path 2 (state C) is the orchestrator's
 * job and stays pinned by orchestrator.test.ts (see the contract's scope note).
 */
function makeDropboxHarness(): CachingRemoteFsHarness<DropboxEntry> {
	const baseline = new Map<string, DropboxEntry>(); // absolute path → entry
	const events: DropboxEntry[] = []; // delta entries (deletes / upserts), append-only
	let idSeq = 0;
	const cursorAt = (n: number): string => `c${n}`;

	const client = {
		// refreshRootPath / assertRootAlive resolve the vault folder's current path by id.
		getMetadata: (_ref: string): Promise<DropboxEntry> =>
			Promise.resolve({ ".tag": "folder", id: ROOT_ID, name: "root", path_lower: ROOT_PATH, path_display: ROOT_PATH }),
		getLatestCursor: (): Promise<string> => Promise.resolve(cursorAt(events.length)),
		listFolderAll: (): Promise<DropboxEntry[]> => Promise.resolve([...baseline.values()]),
		listFolderContinue: (cursor: string): Promise<DropboxListFolderResponse> => {
			const from = cursor.startsWith("c") ? Number(cursor.slice(1)) : 0;
			return Promise.resolve({ entries: events.slice(from), cursor: cursorAt(events.length), has_more: false });
		},
	} as unknown as DropboxClient;

	const abs = (path: string): string => `${ROOT_PATH}/${path}`;

	return {
		makeStore: (id) => new MetadataStore<DropboxEntry>(id, { dbNamePrefix: "air-sync-dropbox-contract", version: 1 }),
		makeFs: (store) => new DropboxFs(client, ROOT_ID, undefined, store),
		seedFile: (path) => {
			baseline.set(abs(path), dbxFile(`f${++idSeq}`, abs(path)));
		},
		seedFolderWithChild: (folderPath, childName) => {
			baseline.set(abs(folderPath), dbxFolder(`d${++idSeq}`, abs(folderPath)));
			const childPath = `${folderPath}/${childName}`;
			baseline.set(abs(childPath), dbxFile(`f${++idSeq}`, abs(childPath)));
		},
		stageRemoteDelete: (path) => {
			if (!baseline.delete(abs(path))) throw new Error(`stageRemoteDelete: no such file "${path}"`);
			events.push(dbxDeleted(abs(path)));
		},
		// Dropbox is path-addressed: a move re-keys the entry (and every descendant) to a
		// new absolute path, reported as deleted(old)+file/folder(new) sharing the id. We
		// list the DELETES FIRST — the adversarial ordering ADR 0006 makes safe.
		stageRemoteRename: (oldPath, newPath, opts) => {
			const absOld = abs(oldPath);
			if (!baseline.has(absOld)) throw new Error(`stageRemoteRename: no such path "${oldPath}"`);
			const oldPrefix = absOld + "/";
			const moved: DropboxEntry[] = [];
			const deletes: DropboxEntry[] = [];
			for (const [p, e] of [...baseline.entries()]) {
				const isSelf = p === absOld;
				if (!isSelf && !(opts?.isFolder && p.startsWith(oldPrefix))) continue;
				baseline.delete(p);
				const np = isSelf ? abs(newPath) : abs(newPath) + "/" + p.substring(oldPrefix.length);
				const movedEntry: DropboxEntry = { ...e, name: np.split("/").pop()!, path_lower: np.toLowerCase(), path_display: np };
				baseline.set(np, movedEntry);
				moved.push(movedEntry);
				deletes.push(dbxDeleted(p));
			}
			for (const d of deletes) events.push(d); // deletes first (adversarial)
			for (const m of moved) events.push(m);
		},
	};
}

runCachingRemoteFsContract("DropboxFs", makeDropboxHarness);
