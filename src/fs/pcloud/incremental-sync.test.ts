import { describe, it, expect } from "vitest";
import { PCloudMetadataCache, flattenPCloudListing } from "./metadata-cache";
import { applyPCloudDiff, type PCloudSyncContext } from "./incremental-sync";
import type { PCloudClient } from "./client";
import type { PCloudDiffEntry } from "./types";
import { pcFile, pcFolder } from "./test-helpers";

function makeCache(): PCloudMetadataCache {
	const cache = new PCloudMetadataCache("0");
	cache.buildFromFiles(
		flattenPCloudListing(
			pcFolder(0, "/", 0, [pcFile(1, "a.md", 0), pcFolder(2, "sub", 0, [pcFile(3, "b.md", 2)])]),
		),
	);
	return cache;
}

/** A fake client whose listDiff returns one batch, then drains to empty. */
function diffClient(diffid: number, entries: PCloudDiffEntry[]): PCloudClient {
	let called = false;
	return {
		listDiff: () => {
			const out = called ? { result: 0, diffid, entries: [] } : { result: 0, diffid, entries };
			called = true;
			return Promise.resolve(out);
		},
	} as unknown as PCloudClient;
}

function ctxFor(cache: PCloudMetadataCache, client: PCloudClient): PCloudSyncContext {
	return { cache, client };
}

describe("applyPCloudDiff", () => {
	it("requests a full scan on a reset event", async () => {
		const cache = makeCache();
		const client = diffClient(200, [{ diffid: 200, event: "reset" }]);
		const result = await applyPCloudDiff(ctxFor(cache, client), "100");
		expect(result.needsFullScan).toBe(true);
	});

	it("applies a createfile under a known folder", async () => {
		const cache = makeCache();
		const client = diffClient(200, [{ diffid: 200, event: "createfile", metadata: pcFile(4, "c.md", 2) }]);
		const result = await applyPCloudDiff(ctxFor(cache, client), "100");
		expect(result.needsFullScan).toBe(false);
		if (result.needsFullScan) return;
		expect(result.newToken).toBe("200");
		expect([...result.changedPaths]).toContain("sub/c.md");
		expect(cache.hasFile("sub/c.md")).toBe(true);
	});

	it("removes a deleted file by reverse-resolving its id", async () => {
		const cache = makeCache();
		const client = diffClient(201, [{ diffid: 201, event: "deletefile", metadata: pcFile(1, "a.md", 0) }]);
		const result = await applyPCloudDiff(ctxFor(cache, client), "100");
		if (result.needsFullScan) throw new Error("unexpected full scan");
		expect([...result.changedPaths]).toContain("a.md");
		expect(cache.hasFile("a.md")).toBe(false);
	});

	it("detects a folder rename and reports it (with child path rewrite)", async () => {
		const cache = makeCache();
		const client = diffClient(202, [{ diffid: 202, event: "modifyfolder", metadata: pcFolder(2, "renamed", 0) }]);
		const result = await applyPCloudDiff(ctxFor(cache, client), "100");
		if (result.needsFullScan) throw new Error("unexpected full scan");
		expect(result.renamedPaths).toContainEqual({ oldPath: "sub", newPath: "renamed", isFolder: true });
		expect(cache.hasFile("renamed/b.md")).toBe(true);
	});

	it("ignores events that don't resolve under the synced subtree", async () => {
		const cache = makeCache();
		const client = diffClient(203, [
			{ diffid: 203, event: "createfile", metadata: pcFile(99, "elsewhere.md", 999) },
			{ diffid: 203, event: "deletefile", metadata: pcFile(88, "gone.md", 999) },
		]);
		const result = await applyPCloudDiff(ctxFor(cache, client), "100");
		if (result.needsFullScan) throw new Error("unexpected full scan");
		expect(result.changedPaths.size).toBe(0);
		expect(cache.size).toBe(3);
	});

	it("ignores share/userinfo events", async () => {
		const cache = makeCache();
		const client = diffClient(204, [{ diffid: 204, event: "modifyuserinfo" }]);
		const result = await applyPCloudDiff(ctxFor(cache, client), "100");
		if (result.needsFullScan) throw new Error("unexpected full scan");
		expect(result.changedPaths.size).toBe(0);
	});
});
