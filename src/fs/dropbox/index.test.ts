import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, dbxFile, dbxFolder, untagged } from "./test-helpers";
import type { DropboxFsInternal } from "./test-helpers";
import type { DropboxEntry } from "./types";
import "fake-indexeddb/auto";
import { METADATA_CACHE_VERSION, MetadataStore } from "../../store/metadata-store";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

function bytes(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer;
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
		expect(fs.changesPageToken).toBe("C0");

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
		expect(entity.pathAuthority).toBe("requested_echo");
		expect(entity.identityKey).toBe("id:x");
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

// These exercise the guard's CAS MECHANISM by injecting a cache re-key during the
// phase-2 network op. In production the re-key is unreachable (ADR 0001, T7: deltas
// run only in the detect phase; the only execute-phase producer would be a parallel
// Group-A write on a disjoint path) — the guard is retained as defense-in-depth.
describe("DropboxFs stale-cache guards (CAS mechanism)", () => {
	type CacheView = {
		setEntry(path: string, entry: DropboxEntry): void;
		getFile(path: string): DropboxEntry | undefined;
		hasFile(path: string): boolean;
	};

	async function makeFsWithWarn() {
		const { DropboxFs } = await import("./index");
		const { DropboxClient } = await import("./client");
		const warn = vi.fn();
		const logger = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as unknown as import("../../logging/logger").Logger;
		const client = new DropboxClient(() => Promise.resolve("AT"));
		const fs = new DropboxFs(client, "id:root", logger);
		(fs as unknown as DropboxFsInternal).initialized = true;
		const cache = (fs as unknown as { cache: CacheView }).cache;
		return { fs, cache, warn };
	}

	it("write: does not clobber a concurrent re-key that created the same NEW path during upload", async () => {
		const { fs, cache, warn } = await makeFsWithWarn();
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("/files/upload")) {
				// Phase 2 (upload) runs outside the mutex — inject a re-key landing a
				// DIFFERENT entry at the same path to exercise the guard's CAS.
				cache.setEntry("new.md", dbxFile("delta", "/root/new.md"));
				return Promise.resolve(mockRes(untagged(dbxFile("uploaded", "/root/new.md"))));
			}
			return Promise.resolve(mockRes({}));
		});

		await fs.write("new.md", bytes("hi"), 0);

		expect(cache.getFile("new.md")?.id).toBe("id:delta");
		expect(warn).toHaveBeenCalledWith("Skipping stale cache update for write", { path: "new.md" });
	});

	it("delete: keeps a concurrent replacement that landed a DIFFERENT id at the path during the network delete", async () => {
		const { fs, cache, warn } = await makeFsWithWarn();
		// Cached file/folder entries always carry a stable id (only `deleted` tombstones
		// lack one, and those are never cached), so the stale-guard keys on that id.
		cache.setEntry("x.md", dbxFile("orig", "/root/x.md"));

		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("delete_v2")) {
				// Phase 2 (delete) runs outside the mutex — inject a re-key that replaces
				// the entry at this path with a DIFFERENT file (new id).
				cache.setEntry("x.md", dbxFile("delta", "/root/x.md"));
				return Promise.resolve(mockRes({}));
			}
			return Promise.resolve(mockRes({}));
		});

		await fs.delete("x.md");

		// The replacement survives — the stale delete did not removeTree the wrong entry
		// (the path now resolves to id:delta, not the id:orig we deleted remotely).
		expect(cache.hasFile("x.md")).toBe(true);
		expect(cache.getFile("x.md")?.id).toBe("id:delta");
		expect(warn).toHaveBeenCalledWith("Skipping stale cache update for delete", { path: "x.md" });
	});

	it("rename: does not overwrite a concurrent entry that landed at newPath during the move", async () => {
		const { fs, cache, warn } = await makeFsWithWarn();
		cache.setEntry("old.md", dbxFile("src", "/root/old.md"));

		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("move_v2")) {
				// Phase 2 (move) runs outside the mutex — inject a re-key landing a
				// DIFFERENT entry at the destination before our phase-3 cache update.
				cache.setEntry("new.md", dbxFile("delta", "/root/new.md"));
				return Promise.resolve(mockRes({ metadata: untagged(dbxFile("src", "/root/new.md")) }));
			}
			return Promise.resolve(mockRes({}));
		});

		await fs.rename("old.md", "new.md");

		// The concurrent entry survives and the source is left intact (the whole cache
		// update is skipped); the move's in-memory cursor advanced, so the next cycle
		// re-detects our rename rather than this overwriting the delta's change.
		expect(cache.getFile("new.md")?.id).toBe("id:delta");
		expect(cache.hasFile("old.md")).toBe(true);
		expect(warn).toHaveBeenCalledWith("Skipping stale cache update for rename", { path: "new.md" });
	});
});

describe("DropboxFs.rename", () => {
	type CacheView = {
		setEntry(path: string, entry: DropboxEntry): void;
		getFile(path: string): DropboxEntry | undefined;
	};

	async function caseRenameFs() {
		const fs = await makeFs();
		(fs as unknown as DropboxFsInternal).initialized = true;
		const cache = (fs as unknown as { cache: CacheView }).cache;
		cache.setEntry("Case.md", dbxFile("case", "/root/Case.md"));
		return { fs, cache };
	}

	function notFound() {
		return mockRes({ error_summary: "path/not_found/", error: { ".tag": "path" } }, { status: 409 });
	}

	it("performs a case-only rename through a deterministic intermediate path", async () => {
		const { fs } = await caseRenameFs();
		const moves: Array<{ from_path: string; to_path: string }> = [];
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const request = opts as RequestUrlParam;
			if (request.url.includes("get_metadata")) return Promise.resolve(notFound());
			if (request.url.includes("move_v2")) {
				const body = JSON.parse(request.body as string) as { from_path: string; to_path: string };
				moves.push(body);
				const path = moves.length === 1 ? "/root/.airsync-case-rename" : "/root/case.md";
				return Promise.resolve(mockRes({ metadata: untagged(dbxFile("case", path)) }));
			}
			return Promise.resolve(mockRes({}));
		});

		await fs.rename("Case.md", "case.md");

		expect(moves).toHaveLength(2);
		expect(moves[0]!.from_path).toBe("id:root/Case.md");
		expect(moves[0]!.to_path).toMatch(/^id:root\/\.airsync-case-rename-[0-9a-f]{8}$/);
		expect(moves[1]).toMatchObject({ from_path: moves[0]!.to_path, to_path: "id:root/case.md" });
		expect((await fs.stat("case.md"))?.identityKey).toBe("id:case");
	});

	it("persists case-only rename intent before the first remote move", async () => {
		const events: string[] = [];
		const store = {
			getMeta: () => Promise.resolve(undefined),
			setMeta: () => { events.push("persist"); return Promise.resolve(); },
			deleteMeta: () => Promise.resolve(),
		} as unknown as MetadataStore<DropboxEntry>;
		const { DropboxFs } = await import("./index");
		const { DropboxClient } = await import("./client");
		const fs = new DropboxFs(
			new DropboxClient(() => Promise.resolve("AT")), "id:root", undefined, store,
		);
		(fs as unknown as DropboxFsInternal).initialized = true;
		(fs as unknown as { cache: CacheView }).cache.setEntry(
			"Case.md", dbxFile("case", "/root/Case.md"),
		);
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const request = opts as RequestUrlParam;
			if (request.url.includes("get_metadata")) return Promise.resolve(notFound());
			if (request.url.includes("move_v2")) {
				events.push("move");
				return Promise.resolve(mockRes({ metadata: untagged(dbxFile("case", "/root/case.md")) }));
			}
			return Promise.resolve(mockRes({}));
		});

		await fs.rename("Case.md", "case.md");

		expect(events).toEqual(["persist", "move", "move"]);
	});

	it("resumes the second leg when the deterministic intermediate already holds the source id", async () => {
		const { fs } = await caseRenameFs();
		const moves: Array<{ from_path: string; to_path: string }> = [];
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const request = opts as RequestUrlParam;
			if (request.url.includes("get_metadata")) {
				return Promise.resolve(mockRes(dbxFile("case", "/root/.airsync-case-rename-existing")));
			}
			if (request.url.includes("move_v2")) {
				moves.push(JSON.parse(request.body as string) as { from_path: string; to_path: string });
				return Promise.resolve(mockRes({ metadata: untagged(dbxFile("case", "/root/case.md")) }));
			}
			return Promise.resolve(mockRes({}));
		});

		await fs.rename("Case.md", "case.md");

		expect(moves).toHaveLength(1);
		expect(moves[0]!.from_path).toMatch(/^id:root\/\.airsync-case-rename-[0-9a-f]{8}$/);
		expect(moves[0]!.to_path).toBe("id:root/case.md");
	});

	it("fails before moving when the deterministic intermediate is occupied by another id", async () => {
		const { fs } = await caseRenameFs();
		const move = vi.fn();
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const request = opts as RequestUrlParam;
			if (request.url.includes("get_metadata")) {
				return Promise.resolve(mockRes(dbxFile("foreign", "/root/.airsync-case-rename-occupied")));
			}
			if (request.url.includes("move_v2")) move();
			return Promise.resolve(mockRes({}));
		});

		await expect(fs.rename("Case.md", "case.md")).rejects.toThrow("temporary path is occupied");
		expect(move).not.toHaveBeenCalled();
	});

	it("rolls the first leg back when the final move fails", async () => {
		const { fs, cache } = await caseRenameFs();
		const moves: Array<{ from_path: string; to_path: string }> = [];
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const request = opts as RequestUrlParam;
			if (request.url.includes("get_metadata")) return Promise.resolve(notFound());
			if (request.url.includes("move_v2")) {
				moves.push(JSON.parse(request.body as string) as { from_path: string; to_path: string });
				if (moves.length === 2) {
					return Promise.resolve(mockRes(
						{ error_summary: "to/conflict/file/", error: { ".tag": "to" } },
						{ status: 409 },
					));
				}
				return Promise.resolve(mockRes({ metadata: untagged(dbxFile("case", "/root/Case.md")) }));
			}
			return Promise.resolve(mockRes({}));
		});

		await expect(fs.rename("Case.md", "case.md")).rejects.toThrow("Dropbox API move failed");

		expect(moves).toHaveLength(3);
		expect(moves[2]).toMatchObject({ from_path: moves[0]!.to_path, to_path: "id:root/Case.md" });
		expect(cache.getFile("Case.md")?.id).toBe("id:case");
		expect(cache.getFile("case.md")).toBeUndefined();
	});

	it("recovers a persisted case-only rename from its temporary path after restart", async () => {
		const store = new MetadataStore<DropboxEntry>(crypto.randomUUID(), {
			dbNamePrefix: "air-sync-dropbox-case-rename", version: METADATA_CACHE_VERSION,
		});
		await store.setMeta("dropboxCaseRenamePending", JSON.stringify({
			oldPath: "Case.md",
			newPath: "case.md",
			tempPath: ".airsync-case-rename-35544a52",
			expectedId: "id:case",
		}));
		let moved = false;
		const moves: Array<{ from_path: string; to_path: string }> = [];
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const request = opts as RequestUrlParam;
			if (request.url.includes("get_metadata")) {
				const path = (JSON.parse(request.body as string) as { path: string }).path;
				if (path === "id:root") return Promise.resolve(metaRes());
				if (path.endsWith("/.airsync-case-rename-35544a52") && !moved) {
					return Promise.resolve(mockRes(dbxFile("case", "/root/.airsync-case-rename-35544a52")));
				}
				if (path.endsWith("/case.md") && moved) {
					return Promise.resolve(mockRes(dbxFile("case", "/root/case.md")));
				}
				return Promise.resolve(notFound());
			}
			if (request.url.includes("move_v2")) {
				moves.push(JSON.parse(request.body as string) as { from_path: string; to_path: string });
				moved = true;
				return Promise.resolve(mockRes({ metadata: untagged(dbxFile("case", "/root/case.md")) }));
			}
			if (request.url.includes("get_latest_cursor")) return Promise.resolve(mockRes({ cursor: "C0" }));
			if (request.url.endsWith(PLAIN_LIST)) {
				const entries = moved ? [dbxFile("case", "/root/case.md")] : [];
				return Promise.resolve(mockRes({ entries, cursor: "C1", has_more: false }));
			}
			return Promise.resolve(mockRes({}));
		});
		const { DropboxFs } = await import("./index");
		const { DropboxClient } = await import("./client");
		const fs = new DropboxFs(
			new DropboxClient(() => Promise.resolve("AT")), "id:root", undefined, store,
		);

		expect((await fs.list()).map((item) => item.path)).toEqual(["case.md"]);
		expect(moves).toHaveLength(1);
		expect(moves[0]).toMatchObject({
			from_path: "id:root/.airsync-case-rename-35544a52",
			to_path: "id:root/case.md",
		});
		expect(await store.getMeta("dropboxCaseRenamePending")).toBeUndefined();
		await store.close();
	});

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
		const folder = await fs.mkdir("docs");
		expect(folder).toMatchObject({
			path: "docs",
			pathAuthority: "requested_echo",
			identityKey: "id:d",
		});

		await fs.rename("docs", "papers");
		expect((await fs.stat("papers"))?.isDirectory).toBe(true);
		// A write into the renamed folder must not throw 'papers is a file'.
		await expect(fs.write("papers/child.md", bytes("x"), 0)).resolves.toMatchObject({ path: "papers/child.md" });
	});
});

// The checkpoint/commit-last crash-safety (ADR 0001) is owned by CachingRemoteFs and
// pinned against the real DropboxFs by the shared base contract in
// crash-safety-contract.test.ts (cursor co-located with the cache in IDB), so it is no
// longer re-tested here with a hand-rolled store.

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
		// The committed cursor is co-located with the cache in the store's meta
		// (CURSOR_META_KEY), so its presence is what makes loadFromCache replay.
		const fakeStore = {
			open: () => Promise.resolve(),
			getMeta: () => Promise.resolve(undefined),
			loadAll: () => Promise.resolve({
				files: [{ path: "a.md", file: dbxFile("1", "/root/a.md") }],
				meta: new Map<string, string>([["changesStartPageToken", "C1"]]),
			}),
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
