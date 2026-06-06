import { describe, it, expect } from "vitest";
import { PCloudMetadataCache } from "./metadata-cache";
import {
	applyPCloudDiff,
	classifyChangedPaths,
	computeFullScanDelta,
	type PCloudSyncContext,
} from "./incremental-sync";
import type { PCloudClient } from "./client";
import type { PCloudDiffEntry } from "./types";
import { pcFile, pcFolder } from "./test-helpers";

function makeCache(): PCloudMetadataCache {
	const cache = new PCloudMetadataCache("0");
	cache.buildFromListFolder(
		pcFolder(0, "/", 0, [pcFile(1, "a.md", 0), pcFolder(2, "sub", 0, [pcFile(3, "b.md", 2)])]),
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
		expect(result.newDiffId).toBe("200");
		expect([...result.changedPaths]).toContain("sub/c.md");
		expect(cache.hasEntry("sub/c.md")).toBe(true);
	});

	it("removes a deleted file by reverse-resolving its id", async () => {
		const cache = makeCache();
		const client = diffClient(201, [{ diffid: 201, event: "deletefile", metadata: pcFile(1, "a.md", 0) }]);
		const result = await applyPCloudDiff(ctxFor(cache, client), "100");
		if (result.needsFullScan) throw new Error("unexpected full scan");
		expect([...result.changedPaths]).toContain("a.md");
		expect(cache.hasEntry("a.md")).toBe(false);
	});

	it("detects a folder rename and reports it (with child path rewrite)", async () => {
		const cache = makeCache();
		const client = diffClient(202, [{ diffid: 202, event: "modifyfolder", metadata: pcFolder(2, "renamed", 0) }]);
		const result = await applyPCloudDiff(ctxFor(cache, client), "100");
		if (result.needsFullScan) throw new Error("unexpected full scan");
		expect(result.renamedPaths).toContainEqual({ oldPath: "sub", newPath: "renamed", isFolder: true });
		expect(cache.hasEntry("renamed/b.md")).toBe(true);
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

describe("classifyChangedPaths", () => {
	it("splits changed paths into modified (cached) vs deleted (gone)", () => {
		const cache = makeCache();
		const changed = new Set(["a.md", "ghost.md"]);
		const delta = classifyChangedPaths(cache, changed, []);
		expect(delta.modified).toContain("a.md");
		expect(delta.deleted).toContain("ghost.md");
	});
});

describe("computeFullScanDelta", () => {
	it("returns null on the very first scan (no prior snapshot)", () => {
		const cache = makeCache();
		expect(computeFullScanDelta(new Map(), cache)).toBeNull();
	});

	it("detects additions, renames, and deletions against an old snapshot", () => {
		const cache = makeCache();
		// Old snapshot: a.md was at "old.md"; f3 (sub/b.md) is gone; f1 stays as a.md.
		const old = new Map<string, string>([
			["f1", "old.md"],
			["d2", "sub"],
			["f3", "sub/b.md"],
			["f9", "removed.md"],
		]);
		const delta = computeFullScanDelta(old, cache)!;
		expect(delta.renamed).toContainEqual({ oldPath: "old.md", newPath: "a.md", isFolder: undefined });
		expect(delta.deleted).toContain("removed.md");
	});
});
