import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, pcFile, pcFolder } from "./test-helpers";
import type { PCloudEntry } from "./types";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

interface Routes {
	root: PCloudEntry;
	upload?: PCloudEntry;
}

/** Route pCloud API calls by URL; `routes.root` is the listfolder tree. */
async function makeFs(routes: Routes) {
	const calls: string[] = [];
	(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
		const url = typeof opts === "string" ? opts : opts.url;
		calls.push(url);
		if (url.includes("/diff?")) return Promise.resolve(mockRes({ result: 0, diffid: 100, entries: [] }));
		if (url.includes("/listfolder")) return Promise.resolve(mockRes({ result: 0, metadata: routes.root }));
		if (url.includes("/createfolderifnotexists")) {
			return Promise.resolve(mockRes({ result: 0, metadata: pcFolder(2, "sub", 0) }));
		}
		if (url.includes("/uploadfile")) {
			return Promise.resolve(mockRes({ result: 0, metadata: [routes.upload], fileids: [] }));
		}
		return Promise.resolve(mockRes({ result: 0 }));
	});

	const { PCloudFs } = await import("./index");
	const { PCloudClient } = await import("./client");
	const client = new PCloudClient(() => "tok", () => "api.pcloud.com");
	return { fs: new PCloudFs(client, "0"), calls };
}

describe("PCloudFs full scan", () => {
	it("captures a diff baseline before listing, then lists the tree", async () => {
		const { fs, calls } = await makeFs({
			root: pcFolder(0, "/", 0, [pcFile(1, "a.md", 0), pcFolder(2, "sub", 0, [pcFile(3, "b.md", 2)])]),
		});
		const entities = await fs.list();
		const paths = entities.map((e) => e.path).sort();
		expect(paths).toEqual(["a.md", "sub", "sub/b.md"]);
		// baseline diff?last=0 happens before listfolder
		const diffIdx = calls.findIndex((u) => u.includes("last=0"));
		const listIdx = calls.findIndex((u) => u.includes("/listfolder"));
		expect(diffIdx).toBeGreaterThanOrEqual(0);
		expect(diffIdx).toBeLessThan(listIdx);
	});

	it("returns null from getChangedPaths on the initial scan (no delta yet)", async () => {
		const { fs } = await makeFs({ root: pcFolder(0, "/", 0, []) });
		expect(await fs.getChangedPaths()).toBeNull();
	});
});

describe("PCloudFs write", () => {
	it("uploads, caches, and reports the uploaded file via stat", async () => {
		const { fs } = await makeFs({
			root: pcFolder(0, "/", 0, []),
			upload: pcFile(7, "note.md", 0, { hash: 777, size: 5 }),
		});
		const content = new TextEncoder().encode("hello").buffer as ArrayBuffer;
		const written = await fs.write("note.md", content, Date.now());
		expect(written.hash).not.toBe(""); // local sha256 is computed
		expect(written.remoteChecksum).toEqual({ algo: "opaque", value: "777" });

		const stat = await fs.stat("note.md");
		expect(stat?.remoteChecksum).toEqual({ algo: "opaque", value: "777" });
		expect(stat?.backendMeta).toEqual({ pcloudId: "f7" });
	});

	it("creates parent folders for a nested path before uploading", async () => {
		const { fs, calls } = await makeFs({
			root: pcFolder(0, "/", 0, []),
			upload: pcFile(7, "n.md", 2, { hash: 1 }),
		});
		const content = new ArrayBuffer(1);
		await fs.write("sub/n.md", content, Date.now());
		expect(calls.some((u) => u.includes("/createfolderifnotexists"))).toBe(true);
	});

	it("refuses to write the reserved metadata path", async () => {
		const { fs } = await makeFs({ root: pcFolder(0, "/", 0, []) });
		await expect(fs.write(".airsync/metadata.json", new ArrayBuffer(1), 0)).rejects.toThrow("reserved backend path");
	});
});
