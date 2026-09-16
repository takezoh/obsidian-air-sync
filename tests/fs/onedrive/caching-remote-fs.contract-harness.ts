import "fake-indexeddb/auto";
import { vi } from "vitest";
import type { OneDriveClient } from "../../../src/fs/onedrive/client";
import type { OneDriveItem, OneDriveDeltaResponse } from "../../../src/fs/onedrive/types";
import { MetadataStore } from "../../../src/store/metadata-store";
import { OneDriveFs } from "../../../src/fs/onedrive";
import { odFile, odFolder, odDeleted } from "../../../src/fs/onedrive/test-helpers";
import { runCachingRemoteFsContract } from "../contracts/caching-remote-fs.contract";
import type { CachingRemoteFsHarness } from "../contracts/caching-remote-fs.contract";

vi.mock("obsidian");

const ROOT_ID = "root";
/** A parent id the bound root never reaches — the fake's "somewhere else in the drive". */
const OUTSIDE_ID = "outside";

/**
 * Run the shared base crash-safety contract (ADR 0001) against the REAL OneDriveFs
 * over a minimal in-memory OneDriveClient — a baseline of items (full enumeration)
 * plus a monotonic, append-only delta log keyed by a numeric cursor token. A stale
 * cursor is honoured by serving the events after it; the terminal page carries a new
 * deltaLink token. This proves OneDrive's ADR 0001 path-1 behaviour through the
 * OneDrive seams (getStartCursor / fullList / fetchDelta), including same-process
 * abort/reload.
 */
function makeOneDriveHarness(): CachingRemoteFsHarness<OneDriveItem> {
	const baseline = new Map<string, { id: string; item: OneDriveItem }>(); // path → item
	const events: OneDriveItem[] = []; // delta items (deletes / upserts), append-only
	/** Folder path → its subtree, held outside the bound root until it is moved in. */
	const outside = new Map<string, { path: string; item: OneDriveItem }[]>();
	let idSeq = 0;
	let failAfterFirstPage = false;
	const cursorAt = (n: number): string => `c${n}`;

	const client = {
		getStartCursor: (): Promise<string> => Promise.resolve(cursorAt(events.length)),
		getItem: (_id: string): Promise<OneDriveItem> =>
			Promise.resolve({ id: ROOT_ID, name: "root", folder: { childCount: 0 } }),
		fullList: (): Promise<OneDriveItem[]> => Promise.resolve([...baseline.values()].map((e) => e.item)),
		fetchDelta: (_rootId: string, link: string): Promise<OneDriveDeltaResponse> => {
			if (link === "contract-second-page") {
				failAfterFirstPage = false;
				return Promise.reject(new Error("injected later page failure"));
			}
			const from = link.startsWith("c") ? Number(link.slice(1)) : 0;
			if (failAfterFirstPage) {
				return Promise.resolve({
					value: events.slice(from, from + 1),
					"@odata.nextLink": "contract-second-page",
				});
			}
			return Promise.resolve({
				value: events.slice(from),
				"@odata.deltaLink": `https://g/delta?token=${cursorAt(events.length)}`,
			});
		},
	} as unknown as OneDriveClient;

	return {
		makeStore: (id) => new MetadataStore<OneDriveItem>(id, { dbNamePrefix: "air-sync-onedrive-contract", version: 1 }),
		makeFs: (store) => new OneDriveFs(client, ROOT_ID, undefined, store),
		seedFile: (path) => {
			const id = `f${++idSeq}`;
			baseline.set(path, { id, item: odFile(id, path.split("/").pop()!, ROOT_ID) });
		},
		seedFolderWithChild: (folderPath, childName) => {
			const folderId = `d${++idSeq}`;
			const childId = `f${++idSeq}`;
			baseline.set(folderPath, { id: folderId, item: odFolder(folderId, folderPath, ROOT_ID) });
			baseline.set(`${folderPath}/${childName}`, { id: childId, item: odFile(childId, childName, folderId) });
		},
		// Parented outside the bound root, so `fullList` (a bound-root enumeration) never
		// returns it and the folder-scoped delta reports nothing until the move.
		seedFolderOutsideRoot: (folderPath) => {
			const folderId = `d${++idSeq}`;
			const subId = `d${++idSeq}`;
			outside.set(folderPath, [
				{ path: folderPath, item: odFolder(folderId, folderPath, OUTSIDE_ID) },
				{ path: `${folderPath}/a.md`, item: odFile(`f${++idSeq}`, "a.md", folderId) },
				{ path: `${folderPath}/sub`, item: odFolder(subId, "sub", folderId) },
				{ path: `${folderPath}/sub/b.md`, item: odFile(`f${++idSeq}`, "b.md", subId) },
			]);
		},
		// live-probe-onedrive: Graph's folder-scoped delta reports a folder entering the
		// scope TOGETHER WITH every pre-existing descendant, as new items, in the observed
		// order F, F/a.md, F/sub, F/sub/b.md. Only the folder changes parent; the
		// descendants keep their own parent ids and are re-emitted unchanged.
		stageMoveIntoRoot: (folderPath) => {
			const seeded = outside.get(folderPath);
			if (!seeded) throw new Error(`stageMoveIntoRoot: no folder seeded outside the root at "${folderPath}"`);
			outside.delete(folderPath);
			// Only the folder (the first seeded entry) changes parent.
			const moved = seeded.map(({ path, item }, i) =>
				i === 0 ? { path, item: odFolder(item.id, folderPath, ROOT_ID) } : { path, item });
			for (const { path, item } of moved) {
				baseline.set(path, { id: item.id, item });
				events.push(item);
			}
		},
		stageRemoteDelete: (path) => {
			const entry = baseline.get(path);
			if (!entry) throw new Error(`stageRemoteDelete: no such file "${path}"`);
			baseline.delete(path);
			events.push(odDeleted(entry.id));
		},
		failNextDeltaAfterFirstPage: () => { failAfterFirstPage = true; },
		// OneDrive is id-addressed: a rename re-emits the item with its new name (the
		// parentReference id is unchanged). A folder's children keep their parent id, so
		// only the folder item is re-emitted — the cache reparents the subtree.
		stageRemoteRename: (oldPath, newPath, opts) => {
			const entry = baseline.get(oldPath);
			if (!entry) throw new Error(`stageRemoteRename: no such path "${oldPath}"`);
			const oldPrefix = oldPath + "/";
			for (const [p, e] of [...baseline.entries()]) {
				const isSelf = p === oldPath;
				if (!isSelf && !(opts?.isFolder && p.startsWith(oldPrefix))) continue;
				baseline.delete(p);
				baseline.set(isSelf ? newPath : newPath + "/" + p.substring(oldPrefix.length), e);
			}
			events.push({ ...entry.item, name: newPath.split("/").pop()! });
		},
	};
}

export function registerOneDriveCachingContract(): void {
	runCachingRemoteFsContract("OneDriveFs", makeOneDriveHarness);
}
