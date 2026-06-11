import { describe, it, expect } from "vitest";
import { OneDriveMetadataCache } from "./metadata-cache";
import { odFile, odFolder } from "./test-helpers";

const ROOT = "root";

function makeCache() {
	return new OneDriveMetadataCache(ROOT);
}

describe("OneDriveMetadataCache.buildFromFiles (id-chain resolution)", () => {
	it("resolves paths from parentReference ids, with the root as the chain anchor", () => {
		const cache = makeCache();
		cache.buildFromFiles([
			odFolder("d1", "dir", ROOT),
			odFile("f1", "a.md", ROOT),
			odFile("f2", "b.md", "d1"),
		]);
		expect(cache.size).toBe(3);
		expect(cache.isFolder("dir")).toBe(true);
		expect(cache.hasFile("a.md")).toBe(true);
		expect(cache.hasFile("dir/b.md")).toBe(true);
		expect([...cache.getChildren("")!]).toEqual(expect.arrayContaining(["a.md", "dir"]));
		expect([...cache.getChildren("dir")!]).toEqual(["dir/b.md"]);
	});

	it("projects quickxor checksum + oneDriveId for files and a bare directory for folders", () => {
		const cache = makeCache();
		cache.buildFromFiles([odFile("f1", "a.md", ROOT, { size: 5, file: { hashes: { quickXorHash: "H=" } } })]);
		const file = cache.toEntity("a.md", cache.getFile("a.md")!);
		expect(file).toMatchObject({ isDirectory: false, size: 5, hash: "", remoteChecksum: { algo: "quickxor", value: "H=" } });
		expect(file.backendMeta).toMatchObject({ oneDriveId: "f1" });

		cache.buildFromFiles([odFolder("d1", "dir", ROOT)]);
		expect(cache.toEntity("dir", cache.getFile("dir")!)).toMatchObject({ isDirectory: true, size: 0, mtime: 0, hash: "" });
	});
});

describe("OneDriveMetadataCache tree mutation", () => {
	it("removeTree drops an entry and all descendants (by id)", () => {
		const cache = makeCache();
		cache.buildFromFiles([odFolder("d1", "dir", ROOT), odFile("f1", "b.md", "d1")]);
		cache.removeTree("dir");
		expect(cache.hasFile("dir")).toBe(false);
		expect(cache.hasFile("dir/b.md")).toBe(false);
		expect(cache.getPathById("f1")).toBeUndefined();
	});

	it("applyFileChangeDetectMove rewrites child paths on a folder rename via the same id", () => {
		const cache = makeCache();
		cache.buildFromFiles([odFolder("d1", "dir", ROOT), odFile("f1", "b.md", "d1")]);
		// The folder is renamed remotely: same id, new name.
		const result = cache.applyFileChangeDetectMove(odFolder("d1", "papers", ROOT));
		expect(result).toMatchObject({ oldPath: "dir", newPath: "papers", wasFolder: true });
		expect(cache.hasFile("papers")).toBe(true);
		expect(cache.hasFile("papers/b.md")).toBe(true);
		expect(cache.hasFile("dir/b.md")).toBe(false);
		expect(cache.getPathById("f1")).toBe("papers/b.md");
	});
});
