import "fake-indexeddb/auto";
import { vi } from "vitest";
import type { PCloudClient } from "./client";
import type { PCloudEntry, PCloudDiffEntry, PCloudDiffResponse } from "./types";
import { MetadataStore } from "../../store/metadata-store";
import { PCloudFs } from "./index";
import { pcFile } from "./test-helpers";
import { runCachingRemoteFsContract } from "../caching/remote-fs-contract";
import type { CachingRemoteFsHarness } from "../caching/remote-fs-contract";

vi.mock("obsidian");

const ROOT_FOLDER_ID = "0";

/**
 * Run the shared base crash-safety contract (ADR 0001) against the REAL PCloudFs over
 * a minimal in-memory PCloudClient — a baseline tree (returned by a recursive
 * `listfolder`) plus an append-only account-wide `diff` event log. This proves the D2
 * rebase kept pCloud's ADR 0001 path-1 behaviour intact *through the pCloud seams*
 * (getDiffBaseline / recursive listFolder / listDiff). Path 2 (state C) is the
 * orchestrator's job and stays pinned by orchestrator.test.ts (see the contract's
 * scope note).
 */
function makePCloudHarness(): CachingRemoteFsHarness<PCloudEntry> {
	const baseline = new Map<string, PCloudEntry>(); // vault-relative path → top-level entry
	const events: PCloudDiffEntry[] = []; // account-wide diff log, append-only (diffid ascends)
	let fileSeq = 0;

	const client = {
		// fullList(): a recursive listfolder of the root → the root entry with its
		// children nested under `contents` (flattenPCloudListing walks them).
		listFolder: (_folderId: string, _recursive?: boolean): Promise<PCloudEntry> =>
			Promise.resolve({
				id: `d${ROOT_FOLDER_ID}`,
				name: "/",
				isfolder: true,
				folderid: Number(ROOT_FOLDER_ID),
				contents: [...baseline.values()],
			}),
		// getStartCursor(): the latest diffid, captured BEFORE listing.
		getDiffBaseline: (): Promise<string> => Promise.resolve(String(events.length)),
		// fetchChanges(): account-wide diff events strictly after the cursor.
		listDiff: (diffId: string): Promise<PCloudDiffResponse> => {
			const from = Number(diffId);
			return Promise.resolve({ result: 0, diffid: events.length, entries: events.filter((e) => e.diffid > from) });
		},
	} as unknown as PCloudClient;

	return {
		makeStore: (id) => new MetadataStore<PCloudEntry>(id, { dbNamePrefix: "air-sync-pcloud-contract", version: 1 }),
		makeFs: (store) => new PCloudFs(client, ROOT_FOLDER_ID, undefined, store),
		seedFile: (path) => {
			baseline.set(path, pcFile(++fileSeq, path.split("/").pop()!, Number(ROOT_FOLDER_ID)));
		},
		stageRemoteDelete: (path) => {
			const entry = baseline.get(path);
			if (!entry) throw new Error(`stageRemoteDelete: no such file "${path}"`);
			baseline.delete(path);
			events.push({
				diffid: events.length + 1,
				event: "deletefile",
				metadata: { id: entry.id, name: entry.name, isfolder: false },
			});
		},
	};
}

runCachingRemoteFsContract("PCloudFs", makePCloudHarness);
