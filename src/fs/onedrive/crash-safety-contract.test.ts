import "fake-indexeddb/auto";
import { vi } from "vitest";
import type { OneDriveClient } from "./client";
import type { OneDriveItem, OneDriveDeltaResponse } from "./types";
import { MetadataStore } from "../../store/metadata-store";
import { OneDriveFs } from "./index";
import { odFile, odFolder, odDeleted } from "./test-helpers";
import { runCachingRemoteFsContract } from "../caching/remote-fs-contract";
import type { CachingRemoteFsHarness } from "../caching/remote-fs-contract";

vi.mock("obsidian");

const ROOT_ID = "root";

/**
 * Run the shared base crash-safety contract (ADR 0001) against the REAL OneDriveFs
 * over a minimal in-memory OneDriveClient — a baseline of items (full enumeration)
 * plus a monotonic, append-only delta log keyed by a numeric cursor token. A stale
 * cursor is honoured by serving the events after it; the terminal page carries a new
 * deltaLink token. This proves OneDrive's ADR 0001 path-1 behaviour through the
 * OneDrive seams (getStartCursor / fullList / fetchDelta). Path 2 (state C) is the
 * orchestrator's job (see the contract's scope note).
 */
function makeOneDriveHarness(): CachingRemoteFsHarness<OneDriveItem> {
	const baseline = new Map<string, { id: string; item: OneDriveItem }>(); // path → item
	const events: OneDriveItem[] = []; // delta items (deletes / upserts), append-only
	let idSeq = 0;
	const cursorAt = (n: number): string => `c${n}`;

	const client = {
		getStartCursor: (): Promise<string> => Promise.resolve(cursorAt(events.length)),
		getItem: (_id: string): Promise<OneDriveItem> =>
			Promise.resolve({ id: ROOT_ID, name: "root", folder: { childCount: 0 } }),
		fullList: (): Promise<OneDriveItem[]> => Promise.resolve([...baseline.values()].map((e) => e.item)),
		fetchDelta: (_rootId: string, link: string): Promise<OneDriveDeltaResponse> => {
			const from = link.startsWith("c") ? Number(link.slice(1)) : 0;
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
		stageRemoteDelete: (path) => {
			const entry = baseline.get(path);
			if (!entry) throw new Error(`stageRemoteDelete: no such file "${path}"`);
			baseline.delete(path);
			events.push(odDeleted(entry.id));
		},
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

runCachingRemoteFsContract("OneDriveFs", makeOneDriveHarness);
