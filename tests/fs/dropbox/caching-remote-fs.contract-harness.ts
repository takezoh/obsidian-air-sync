import "fake-indexeddb/auto";
import { vi } from "vitest";
import type { DropboxClient } from "../../../src/fs/dropbox/client";
import type { DropboxEntry, DropboxListFolderResponse } from "../../../src/fs/dropbox/types";
import { MetadataStore } from "../../../src/store/metadata-store";
import { DropboxFs } from "../../../src/fs/dropbox";
import { dbxFile, dbxFolder, dbxDeleted } from "../../../src/fs/dropbox/test-helpers";
import { runRemoteFamilyCachingContract } from "../contracts/caching-remote-fs.contract";
import type { RemoteFamilyCachingHarness } from "../contracts/caching-remote-fs.contract";

vi.mock("obsidian");

const ROOT_ID = "id:root";
const ROOT_PATH = "/root";
/** A path the bound root never contains — the fake's "elsewhere in the Dropbox". */
const OUTSIDE_PATH = "/outside";

/**
 * Run the shared base crash-safety contract (ADR 0001) against the REAL DropboxFs over
 * a minimal in-memory DropboxClient — a baseline of file entries plus an append-only
 * `list_folder/continue` delta log. This proves the D1 rebase kept Dropbox's ADR 0001
 * behavior intact through the Dropbox seams (getStartCursor / fullList / fetchChanges
 * plus the refreshRootPath re-anchor), including same-process abort/reload.
 */
function makeDropboxHarness(): RemoteFamilyCachingHarness<DropboxEntry> {
	const baseline = new Map<string, DropboxEntry>(); // absolute path → entry
	const events: DropboxEntry[] = []; // delta entries (deletes / upserts), append-only
	/** Folder path → its subtree, held outside the bound root until it is moved in. */
	const outside = new Map<string, { rel: string; entry: DropboxEntry }[]>();
	let idSeq = 0;
	let failAfterFirstPage = false;
	const cursorAt = (n: number): string => `c${n}`;

	const client = {
		// refreshRootPath / assertRootAlive resolve the vault folder's current path by id.
		getMetadata: (_ref: string): Promise<DropboxEntry> =>
			Promise.resolve({ ".tag": "folder", id: ROOT_ID, name: "root", path_lower: ROOT_PATH, path_display: ROOT_PATH }),
		getLatestCursor: (): Promise<string> => Promise.resolve(cursorAt(events.length)),
		listFolderAll: (): Promise<DropboxEntry[]> => Promise.resolve([...baseline.values()]),
		listFolderContinue: (cursor: string): Promise<DropboxListFolderResponse> => {
			if (cursor === "contract-second-page") {
				failAfterFirstPage = false;
				return Promise.reject(new Error("injected later page failure"));
			}
			const from = cursor.startsWith("c") ? Number(cursor.slice(1)) : 0;
			if (failAfterFirstPage) {
				return Promise.resolve({
					entries: events.slice(from, from + 1),
					cursor: "contract-second-page",
					has_more: true,
				});
			}
			return Promise.resolve({ entries: events.slice(from), cursor: cursorAt(events.length), has_more: false });
		},
	} as unknown as DropboxClient;

	const abs = (path: string): string => `${ROOT_PATH}/${path}`;
	const outsideAbs = (path: string): string => `${OUTSIDE_PATH}/${path}`;

	/**
	 * Dropbox is path-addressed: a move re-keys the entry (and every descendant) to a
	 * new absolute path, reported as deleted(old)+file/folder(new) sharing the id.
	 * `list_folder/continue` does NOT guarantee which half of a pair lands first, so
	 * both windowings are faithful and the harness can emit either (ADR 0006).
	 */
	const stageRename = (
		oldPath: string,
		newPath: string,
		opts: { isFolder?: boolean } | undefined,
		deletedFirst: boolean,
	): void => {
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
		const [first, second] = deletedFirst ? [deletes, moved] : [moved, deletes];
		for (const e of first) events.push(e);
		for (const e of second) events.push(e);
	};

	return {
		// Dropbox's namespace IS the address space: `extractId` is
		// `entry.id ?? entry.path_lower` (`dropbox/metadata-cache.ts:51`) and every
		// cache path comes from relativizing `path_display`, so one path can only ever
		// be held by one entry and two live ids cannot compose the same address through
		// this family's own enumeration. The folder-replacement contract that would
		// settle whether Dropbox's eviction behaviour is correct is unresolved in both
		// directions in this repository's own documents, so the gap carries it rather
		// than a fabricated fixture.
		collision: {
			kind: "cannot",
			reason: "path-keyed namespace: extractId is entry.id ?? entry.path_lower, so one path has one entry",
			unknown: "unknown-dropbox-folder-replacement-contract",
		},
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
		// Held at absolute paths outside the bound root, so `listFolderAll` (a bound-root
		// enumeration) never returns it and the delta reports nothing until the move.
		seedFolderOutsideRoot: (folderPath) => {
			const rels = [folderPath, `${folderPath}/a.md`, `${folderPath}/sub`, `${folderPath}/sub/b.md`];
			outside.set(folderPath, rels.map((rel) => ({
				rel,
				entry: rel.endsWith(".md")
					? dbxFile(`f${++idSeq}`, outsideAbs(rel))
					: dbxFolder(`d${++idSeq}`, outsideAbs(rel)),
			})));
		},
		// live-probe-dropbox: one `list_folder/continue` window carries the folder AND
		// every pre-existing descendant as adds, in the observed order F, F/a.md, F/sub,
		// F/sub/b.md. There is no `deleted` tombstone — the old paths were never inside
		// the bound root, so the recursive path delta had never reported them.
		stageMoveIntoRoot: (folderPath) => {
			const seeded = outside.get(folderPath);
			if (!seeded) throw new Error(`stageMoveIntoRoot: no folder seeded outside the root at "${folderPath}"`);
			outside.delete(folderPath);
			for (const { rel, entry } of seeded) {
				const np = abs(rel);
				const moved: DropboxEntry = { ...entry, path_lower: np.toLowerCase(), path_display: np };
				baseline.set(np, moved);
				events.push(moved);
			}
		},
		stageRemoteDelete: (path) => {
			if (!baseline.delete(abs(path))) throw new Error(`stageRemoteDelete: no such file "${path}"`);
			events.push(dbxDeleted(abs(path)));
		},
		failNextDeltaAfterFirstPage: () => { failAfterFirstPage = true; },
		// The default lists the DELETES FIRST — the adversarial ordering ADR 0006 makes
		// safe, and the one that previously degraded a folder rename to a file-by-file
		// delete+pull.
		stageRemoteRename: (oldPath, newPath, opts) => stageRename(oldPath, newPath, opts, true),
		// The path is emptied by a tombstone and immediately reclaimed by a file with a
		// DIFFERENT `id:` — a real Dropbox history (ids are never reused) and exactly the
		// path-keyed `upsertedPaths` reclaim shape ADR 0006 guards: the tombstone and the
		// upsert name the same path, so the upsert is authoritative and the tombstone is
		// skipped. Tombstone first, matching this harness's adversarial default.
		stageRemoteRecreateWithNewId: (path) => {
			const absPath = abs(path);
			if (!baseline.delete(absPath)) throw new Error(`stageRemoteRecreateWithNewId: no such path "${path}"`);
			events.push(dbxDeleted(absPath));
			const created = dbxFile(`f${++idSeq}`, absPath);
			baseline.set(absPath, created);
			events.push(created);
		},
		movedObjectIdentity: {
			determinate: true,
			reason:
				"dropboxEntryToEntity sets identityKey: entry.id with NO fallback (never " +
				"extractId's path_lower address), and every entry this contract moves carries " +
				"one. An id-less entry cannot reach a pair on this route at all: " +
				"incremental-sync.ts applyUpsertEntry resolves the moved-from path only when " +
				"`entry.id` is present, so an id-less upsert surfaces as delete+add. The " +
				"absent-identity shape is reachable only on the full-scan route — a case-only " +
				"rename whose path_lower surrogate key survives — and is witnessed there by " +
				"src/fs/caching/remote-fs.contract.test.ts, which asserts the pair carries no " +
				"identity and that this differs from cache.idAt's path_lower.",
		},
		renameOrderings: {
			encoding: "orderable-pair",
			reason:
				"Dropbox is path-addressed: list_folder/continue reports a move as " +
				"deleted(old) + file/folder(new) sharing a stable id, and does NOT guarantee " +
				"the add precedes the delete — so both windowings are faithful and both are " +
				"staged here (ADR 0006).",
			stageReversed: (oldPath, newPath, opts) => stageRename(oldPath, newPath, opts, false),
		},
	};
}

export function registerDropboxCachingContract(): void {
	runRemoteFamilyCachingContract("DropboxFs", makeDropboxHarness);
}
