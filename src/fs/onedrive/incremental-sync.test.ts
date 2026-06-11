import { describe, it, expect, vi } from "vitest";
import { OneDriveMetadataCache } from "./metadata-cache";
import { applyOneDriveDelta } from "./incremental-sync";
import type { OneDriveClient } from "./client";
import type { OneDriveDeltaResponse } from "./types";
import { GraphApiError } from "./types";
import { odFile, odFolder, odDeleted, deltaPage } from "./test-helpers";

vi.mock("obsidian");

const ROOT = "root";

/** Split changedPaths into modified (still cached) vs deleted (gone) — mirrors CachingRemoteFs. */
function classify(cache: OneDriveMetadataCache, changedPaths: Set<string>) {
	const modified: string[] = [];
	const deleted: string[] = [];
	for (const path of changedPaths) (cache.hasFile(path) ? modified : deleted).push(path);
	return { modified, deleted };
}

/** A OneDriveClient stub whose `fetchDelta` replays staged pages. */
function fakeClient(pages: OneDriveDeltaResponse[]): OneDriveClient {
	let i = 0;
	return {
		fetchDelta: () => {
			const page = pages[i++];
			if (!page) throw new Error("no more pages");
			return Promise.resolve(page);
		},
	} as unknown as OneDriveClient;
}

function seededCache() {
	const cache = new OneDriveMetadataCache(ROOT);
	cache.buildFromFiles([
		odFile("f1", "a.md", ROOT),
		odFolder("d1", "dir", ROOT),
		odFile("f2", "b.md", "d1"),
	]);
	return cache;
}

function ctx(cache: OneDriveMetadataCache, client: OneDriveClient) {
	return { cache, client, rootId: ROOT };
}

describe("applyOneDriveDelta", () => {
	it("upserts items, removes deleted subtrees, and returns the new cursor token", async () => {
		const cache = seededCache();
		const client = fakeClient([deltaPage([odFile("f3", "c.md", ROOT), odDeleted("d1")], "tok2")]);
		const result = await applyOneDriveDelta(ctx(cache, client), "tok1");
		if (result.needsFullScan) throw new Error("unexpected resync");

		expect(result.newToken).toBe("tok2");
		expect(cache.hasFile("c.md")).toBe(true);
		expect(cache.hasFile("dir")).toBe(false);
		expect(cache.hasFile("dir/b.md")).toBe(false);

		const delta = classify(cache, result.changedPaths);
		expect(delta.modified).toContain("c.md");
		expect(delta.deleted).toEqual(expect.arrayContaining(["dir", "dir/b.md"]));
	});

	it("drains @odata.nextLink across pages before the terminal deltaLink", async () => {
		const cache = seededCache();
		const client = fakeClient([
			{ value: [odFile("f3", "c.md", ROOT)], "@odata.nextLink": "https://graph/next" },
			deltaPage([odFile("f4", "d.md", ROOT)], "tok9"),
		]);
		const result = await applyOneDriveDelta(ctx(cache, client), "tok1");
		if (result.needsFullScan) throw new Error("unexpected resync");
		expect(result.newToken).toBe("tok9");
		expect(cache.hasFile("c.md")).toBe(true);
		expect(cache.hasFile("d.md")).toBe(true);
	});

	it("coalesces a same-id rename into a renamedPair", async () => {
		const cache = seededCache();
		const client = fakeClient([deltaPage([odFile("f1", "renamed.md", ROOT)], "tok2")]);
		const result = await applyOneDriveDelta(ctx(cache, client), "tok1");
		if (result.needsFullScan) throw new Error("unexpected resync");

		expect(cache.hasFile("renamed.md")).toBe(true);
		expect(cache.hasFile("a.md")).toBe(false);
		expect(cache.getPathById("f1")).toBe("renamed.md");
		expect(result.renamedPaths).toEqual([{ oldPath: "a.md", newPath: "renamed.md", isFolder: undefined }]);
	});

	it("rewrites child paths when a folder is renamed via the same id", async () => {
		const cache = seededCache();
		const client = fakeClient([deltaPage([odFolder("d1", "papers", ROOT)], "tok2")]);
		const result = await applyOneDriveDelta(ctx(cache, client), "tok1");
		if (result.needsFullScan) throw new Error("unexpected resync");

		expect(cache.hasFile("papers")).toBe(true);
		expect(cache.hasFile("papers/b.md")).toBe(true);
		expect(cache.hasFile("dir/b.md")).toBe(false);
		expect(result.renamedPaths).toEqual([{ oldPath: "dir", newPath: "papers", isFolder: true }]);
	});

	it("signals needsFullScan on a 410 resync (cursor expired)", async () => {
		const cache = seededCache();
		const client = {
			fetchDelta: () => { throw new GraphApiError("gone", 410, "resyncRequired"); },
		} as unknown as OneDriveClient;
		const result = await applyOneDriveDelta(ctx(cache, client), "tok1");
		expect(result.needsFullScan).toBe(true);
	});

	it("reports a tracked item moved outside the root as deleted", async () => {
		const cache = seededCache();
		// id f1 (a.md) moves under an UNKNOWN parent → parent no longer resolves → deleted.
		const client = fakeClient([deltaPage([odFile("f1", "a.md", "unknown-parent")], "tok2")]);
		const result = await applyOneDriveDelta(ctx(cache, client), "tok1");
		if (result.needsFullScan) throw new Error("unexpected resync");

		expect(cache.hasFile("a.md")).toBe(false);
		const delta = classify(cache, result.changedPaths);
		expect(delta.deleted).toContain("a.md");
	});

	it("skips the root item appearing in the delta stream", async () => {
		const cache = seededCache();
		const client = fakeClient([deltaPage([odFolder(ROOT, "root", "grandparent")], "tok2")]);
		const result = await applyOneDriveDelta(ctx(cache, client), "tok1");
		if (result.needsFullScan) throw new Error("unexpected resync");
		expect(result.changedPaths.size).toBe(0);
		expect(cache.size).toBe(3); // unchanged
	});
});
