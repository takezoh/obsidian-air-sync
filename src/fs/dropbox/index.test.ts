import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, dbxFile, dbxFolder, dbxDeleted, untagged } from "./test-helpers";
import type { DropboxFsInternal } from "./test-helpers";
import type { DropboxEntry } from "./types";
import type { FileRecord, MetadataStore } from "../../store/metadata-store";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

function bytes(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

async function makeFs(rootFolderId = "id:root") {
	const { DropboxFs } = await import("./index");
	const { DropboxClient } = await import("./client");
	const client = new DropboxClient(() => Promise.resolve("AT"));
	return new DropboxFs(client, rootFolderId);
}

const PLAIN_LIST = "/files/list_folder";

/** Mock get_metadata(id:root) → the folder's current path (drives refreshRootPath). */
function metaRes(rootDisplay = "/root") {
	return mockRes(dbxFolder("root", rootDisplay));
}

describe("DropboxFs full scan", () => {
	it("captures the baseline cursor BEFORE listing, and lists the root by its id", async () => {
		const order: string[] = [];
		const spy = (await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			order.push(url);
			if (url.includes("get_metadata")) return Promise.resolve(metaRes());
			if (url.includes("get_latest_cursor")) return Promise.resolve(mockRes({ cursor: "C0" }));
			if (url.endsWith(PLAIN_LIST)) {
				return Promise.resolve(mockRes({ entries: [dbxFile("1", "/root/a.md")], cursor: "C1", has_more: false }));
			}
			return Promise.resolve(mockRes({}));
		});

		const fs = await makeFs();
		const entities = await fs.list();
		expect(entities.map((e) => e.path)).toEqual(["a.md"]);
		expect(fs.cursor).toBe("C0");

		const cursorIdx = order.findIndex((u) => u.includes("get_latest_cursor"));
		const listIdx = order.findIndex((u) => u.endsWith(PLAIN_LIST));
		expect(cursorIdx).toBeGreaterThanOrEqual(0);
		expect(cursorIdx).toBeLessThan(listIdx);
		// list_folder targets the stable id, not the path.
		const listCall = spy.mock.calls.find((c) => String((c[0] as RequestUrlParam).url).endsWith(PLAIN_LIST));
		expect((JSON.parse((listCall![0] as RequestUrlParam).body as string) as { path: string }).path).toBe("id:root");
	});

	it("supports stat / listDir round-trips against the scanned cache", async () => {
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("get_metadata")) return Promise.resolve(metaRes());
			if (url.includes("get_latest_cursor")) return Promise.resolve(mockRes({ cursor: "C0" }));
			if (url.endsWith(PLAIN_LIST)) {
				return Promise.resolve(
					mockRes({
						entries: [dbxFile("1", "/root/a.md"), dbxFolder("2", "/root/dir"), dbxFile("3", "/root/dir/b.md")],
						cursor: "C1",
						has_more: false,
					}),
				);
			}
			return Promise.resolve(mockRes({}));
		});

		const fs = await makeFs();
		await fs.list();

		const file = await fs.stat("dir/b.md");
		expect(file?.isDirectory).toBe(false);
		expect(file?.remoteChecksum).toEqual({ algo: "dropbox", value: "hash3" });

		const kids = await fs.listDir("dir");
		expect(kids.map((k) => k.path)).toEqual(["dir/b.md"]);
	});
});

describe("DropboxFs.write", () => {
	it("creates the parent folder and returns a checksum-bearing entity", async () => {
		// create_folder_v2 / upload return UNTAGGED metadata (as the real API does);
		// the cache must still recognize the new folder as a directory.
		const spy = (await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("create_folder_v2")) return Promise.resolve(mockRes({ metadata: untagged(dbxFolder("sub", "/root/sub")) }));
			if (url.includes("/files/upload")) return Promise.resolve(mockRes(untagged(dbxFile("x", "/root/sub/x.md"))));
			return Promise.resolve(mockRes({}));
		});

		const fs = await makeFs();
		(fs as unknown as DropboxFsInternal).initialized = true;

		const entity = await fs.write("sub/x.md", bytes("hi"), 1_700_000_000_000);
		expect(entity.path).toBe("sub/x.md");
		expect(entity.remoteChecksum).toEqual({ algo: "dropbox", value: "hashx" });
		expect(entity.hash).not.toBe(""); // sha256 of content is computed on write

		expect(spy.mock.calls.some((c) => String((c[0] as RequestUrlParam).url).includes("create_folder_v2"))).toBe(true);
		// The new folder must be cached as a directory (regression: untagged create_folder
		// was treated as a file, breaking a second write into the same folder).
		expect((await fs.stat("sub"))?.isDirectory).toBe(true);
		expect(await fs.stat("sub/x.md")).not.toBeNull();
	});

	it("allows a second write into a freshly created folder (no 'is a file' regression)", async () => {
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("create_folder_v2")) return Promise.resolve(mockRes({ metadata: untagged(dbxFolder("dir", "/root/dir")) }));
			if (url.includes("/files/upload")) return Promise.resolve(mockRes(untagged(dbxFile("f", "/root/dir/second.md"))));
			return Promise.resolve(mockRes({}));
		});

		const fs = await makeFs();
		(fs as unknown as DropboxFsInternal).initialized = true;

		await fs.write("dir/first.md", bytes("a"), 0);
		// Second file into the same folder must not throw 'Cannot create directory "dir": "dir" is a file'.
		await expect(fs.write("dir/second.md", bytes("b"), 0)).resolves.toMatchObject({ path: "dir/second.md" });
	});

	it("refuses to write the reserved backend metadata path", async () => {
		const fs = await makeFs();
		(fs as unknown as DropboxFsInternal).initialized = true;
		await expect(fs.write(".airsync/metadata.json", bytes("x"), 0)).rejects.toThrow("reserved");
	});
});

describe("DropboxFs.rename", () => {
	it("keeps a moved folder classified as a folder even when move_v2 returns it untagged", async () => {
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			// move_v2 returns metadata WITHOUT a `.tag` (as the real API may); the cache
			// must still treat the destination as a directory via the known prior type.
			if (url.includes("move_v2")) return Promise.resolve(mockRes({ metadata: untagged(dbxFolder("d", "/root/papers")) }));
			if (url.includes("create_folder_v2")) return Promise.resolve(mockRes({ metadata: untagged(dbxFolder("d", "/root/docs")) }));
			if (url.includes("/files/upload")) return Promise.resolve(mockRes(untagged(dbxFile("c", "/root/papers/child.md"))));
			return Promise.resolve(mockRes({}));
		});

		const fs = await makeFs();
		(fs as unknown as DropboxFsInternal).initialized = true;
		// Seed a folder "docs" in the cache (as a full scan would).
		await fs.mkdir("docs");

		await fs.rename("docs", "papers");
		expect((await fs.stat("papers"))?.isDirectory).toBe(true);
		// A write into the renamed folder must not throw 'papers is a file'.
		await expect(fs.write("papers/child.md", bytes("x"), 0)).resolves.toMatchObject({ path: "papers/child.md" });
	});
});

describe("DropboxFs checkpoint persistence (commit-last)", () => {
	// A shared IndexedDB-like store that survives a simulated crash (two FS instances
	// against the same backing rows).
	function sharedStore(seed: Record<string, DropboxEntry>) {
		const rows = new Map<string, FileRecord<DropboxEntry>>();
		for (const [path, file] of Object.entries(seed)) {
			rows.set(path, { path, file, isFolder: file[".tag"] === "folder" });
		}
		const store = {
			open: () => Promise.resolve(),
			loadAll: () => Promise.resolve({ files: [...rows.values()], meta: new Map<string, string>() }),
			saveAll: (files: FileRecord<DropboxEntry>[]) => {
				rows.clear();
				for (const r of files) rows.set(r.path, r);
				return Promise.resolve();
			},
			putFiles: (recs: FileRecord<DropboxEntry>[]) => {
				for (const r of recs) rows.set(r.path, r);
				return Promise.resolve();
			},
			deleteFiles: (paths: string[]) => {
				for (const p of paths) rows.delete(p);
				return Promise.resolve();
			},
			close: () => Promise.resolve(),
		} as unknown as MetadataStore<DropboxEntry>;
		return { store, rows };
	}

	function deltaDeletesA() {
		return (opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("get_metadata")) return Promise.resolve(metaRes("/root"));
			if (url.includes("list_folder/continue")) {
				return Promise.resolve(mockRes({ entries: [dbxDeleted("/root/a.md")], cursor: "C1", has_more: false }));
			}
			return Promise.resolve(mockRes({}));
		};
	}

	it("survives a crash mid-cycle: an un-committed cache stays at the committed cursor so the deletion replays", async () => {
		// Regression: a remote deletion was persisted to IndexedDB the moment the delta
		// was applied (eager), decoupled from the cursor (which commits only on success).
		// A crash before commit then loaded a cache that had already dropped the file, and
		// the replay from the committed cursor early-returned on the absent path — the
		// deletion was lost (local copy never removed).
		const { store, rows } = sharedStore({ "a.md": dbxFile("1", "/root/a.md") });
		(await spyRequestUrl()).mockImplementation(deltaDeletesA());
		const { DropboxFs } = await import("./index");
		const { DropboxClient } = await import("./client");

		// Cycle N (committed cursor C0): the remote deletes a.md. The delta surfaces it,
		// but the cycle "crashes" before commitCheckpoint runs.
		const fs1 = new DropboxFs(new DropboxClient(() => Promise.resolve("AT")), "id:root", undefined, store);
		fs1.cursor = "C0";
		expect((await fs1.getChangedPaths())?.deleted).toContain("a.md");
		// Crash: commitCheckpoint NOT called → the store must still hold a.md.
		expect(rows.has("a.md")).toBe(true);

		// Cycle N+1 after restart: a fresh FS rebuilt from the committed cursor C0 must
		// re-detect the deletion via replay.
		const fs2 = new DropboxFs(new DropboxClient(() => Promise.resolve("AT")), "id:root", undefined, store);
		fs2.cursor = "C0";
		expect((await fs2.getChangedPaths())?.deleted).toContain("a.md");
	});

	it("commitCheckpoint flushes the delta to the store only after a clean cycle", async () => {
		const { store, rows } = sharedStore({ "a.md": dbxFile("1", "/root/a.md") });
		(await spyRequestUrl()).mockImplementation(deltaDeletesA());
		const { DropboxFs } = await import("./index");
		const { DropboxClient } = await import("./client");
		const fs = new DropboxFs(new DropboxClient(() => Promise.resolve("AT")), "id:root", undefined, store);
		fs.cursor = "C0";

		await fs.getChangedPaths();
		expect(rows.has("a.md")).toBe(true); // not yet committed

		await fs.commitCheckpoint();
		expect(rows.has("a.md")).toBe(false); // committed → store now matches the cache
	});
});

describe("DropboxFs id-based addressing", () => {
	async function scannedFs(rootDisplay = "/root", entries = [dbxFile("1", "/root/a.md")]) {
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("get_metadata")) return Promise.resolve(metaRes(rootDisplay));
			if (url.includes("get_latest_cursor")) return Promise.resolve(mockRes({ cursor: "C0" }));
			if (url.endsWith(PLAIN_LIST)) return Promise.resolve(mockRes({ entries, cursor: "C1", has_more: false }));
			return Promise.resolve(mockRes({}));
		});
		const fs = await makeFs();
		await fs.list(); // trigger fullScan → populate cache
		return fs;
	}

	it("re-anchors relativize from the id when replaying a cached cursor (no absolute-path keys)", async () => {
		// Regression: loadFromCache restores relative keys but not the relativize
		// anchor; list() reaches applyDelta without its own refreshRootPath, so a
		// cold cursor-replay must re-anchor first or delta entries key to their full
		// absolute path ("Apps/.../new.md") instead of "new.md".
		const fakeStore = {
			open: () => Promise.resolve(),
			loadAll: () => Promise.resolve({ files: [{ path: "a.md", file: dbxFile("1", "/root/a.md") }] }),
			saveAll: () => Promise.resolve(),
			close: () => Promise.resolve(),
		} as unknown as MetadataStore<DropboxEntry>;
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("get_metadata")) return Promise.resolve(metaRes("/root"));
			if (url.includes("list_folder/continue")) {
				return Promise.resolve(mockRes({ entries: [dbxFile("2", "/root/new.md")], cursor: "C2", has_more: false }));
			}
			return Promise.resolve(mockRes({}));
		});
		const { DropboxFs } = await import("./index");
		const { DropboxClient } = await import("./client");
		const fs = new DropboxFs(new DropboxClient(() => Promise.resolve("AT")), "id:root", undefined, fakeStore);
		fs.cursor = "C1"; // prior checkpoint → replay (loadFromCache) path

		const entities = await fs.list();

		// Both the cached and the delta entry are keyed RELATIVE → the anchor was set.
		expect(entities.map((e) => e.path).sort()).toEqual(["a.md", "new.md"]);
	});

	it("read() downloads by the file's stable id, not its path", async () => {
		const fs = await scannedFs();
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes(undefined, { arrayBuffer: bytes("data") }));
		await fs.read("a.md");
		const call = spy.mock.calls.find((c) => String((c[0] as RequestUrlParam).url).includes("/files/download"))!;
		const arg = JSON.parse(String((call[0] as RequestUrlParam).headers?.["Dropbox-API-Arg"])) as { path: string };
		expect(arg.path).toBe("id:1"); // id addressing, not "/root/a.md"
	});

	it("delete() deletes by the stable id", async () => {
		const fs = await scannedFs();
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ metadata: dbxFile("1", "/root/a.md") }));
		await fs.delete("a.md");
		const call = spy.mock.calls.find((c) => String((c[0] as RequestUrlParam).url).includes("delete_v2"))!;
		const body = JSON.parse((call[0] as RequestUrlParam).body as string) as { path: string };
		expect(body.path).toBe("id:1");
	});

	it("tracks a remote move/rename of the vault folder: relativize + writes follow the new path", async () => {
		// First scan at /root, then the folder is moved to /Archive/Renamed remotely.
		const fs = await scannedFs();
		expect((await fs.stat("a.md"))).not.toBeNull();

		const calls: RequestUrlParam[] = [];
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const p = typeof opts === "string" ? ({ url: opts } as RequestUrlParam) : opts;
			calls.push(p);
			const url = p.url;
			// Folder now lives at /Archive/Renamed (resolved from the stable id).
			if (url.includes("get_metadata")) return Promise.resolve(metaRes("/Archive/Renamed"));
			// Delta delivers a new file under the NEW absolute path.
			if (url.includes("list_folder/continue")) {
				return Promise.resolve(mockRes({ entries: [dbxFile("2", "/Archive/Renamed/new.md")], cursor: "C2", has_more: false }));
			}
			if (url.includes("/files/upload")) return Promise.resolve(mockRes(untagged(dbxFile("3", "/Archive/Renamed/push.md"))));
			return Promise.resolve(mockRes({}));
		});

		// getChangedPaths refreshes the root path from the id, then applies the delta.
		const delta = await fs.getChangedPaths();
		expect(delta?.modified).toContain("new.md"); // relativized against the NEW root path

		// A push addresses the file by the vault's stable id (id-relative), so it hits
		// the right folder no matter where it moved — no dependence on the new path.
		await fs.write("push.md", bytes("x"), 0);
		const uploadCall = calls.find((c) => c.url.includes("/files/upload"))!;
		const arg = JSON.parse(String(uploadCall.headers?.["Dropbox-API-Arg"])) as { path: string };
		expect(arg.path).toBe("id:root/push.md");
	});
});
