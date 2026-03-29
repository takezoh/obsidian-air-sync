import { describe, it, expect, beforeEach } from "vitest";
import { collectChanges, enrichHashesForRenames } from "./change-detector";
import type { ChangeDetectorDeps } from "./change-detector";
import { LocalChangeTracker } from "./local-tracker";
import { createMockFs, createMockStateStore, addFile } from "../__mocks__/sync-test-helpers";
import type { FileEntity } from "../fs/types";
import type { MixedEntity, SyncRecord } from "./types";
import { md5 } from "../utils/md5";
import { sha256 } from "../utils/hash";

function makeRecord(path: string, overrides: Partial<SyncRecord> = {}): SyncRecord {
	return {
		path,
		hash: "abc",
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 10,
		remoteSize: 10,
		syncedAt: 900,
		...overrides,
	};
}

describe("collectChanges — temperature selection", () => {
	let localFs: ReturnType<typeof createMockFs>;
	let remoteFs: ReturnType<typeof createMockFs>;
	let stateStore: ReturnType<typeof createMockStateStore>;
	let localTracker: LocalChangeTracker;

	function makeDeps(): ChangeDetectorDeps {
		return { localFs, remoteFs, stateStore, localTracker };
	}

	beforeEach(() => {
		localFs = createMockFs("local");
		remoteFs = createMockFs("remote");
		stateStore = createMockStateStore();
		localTracker = new LocalChangeTracker();
	});

	/** Add a file to mock FS with backendMeta (e.g. contentChecksum) */
	function addFileWithMeta(
		fs: ReturnType<typeof createMockFs>,
		path: string,
		text: string,
		mtime: number,
		backendMeta: Record<string, unknown>,
	): FileEntity {
		const entity = addFile(fs, path, text, mtime);
		entity.backendMeta = backendMeta;
		return entity;
	}

	describe("cold path", () => {
		it("returns cold when stateStore is empty", async () => {
			addFile(localFs, "a.md", "hello", 1000);
			addFile(remoteFs, "a.md", "hello", 1000);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("cold");
		});

		it("includes all local and remote files", async () => {
			addFile(localFs, "a.md", "local", 1000);
			addFile(remoteFs, "b.md", "remote", 1000);

			const result = await collectChanges(makeDeps());

			const paths = result.entries.map((e) => e.path).sort();
			expect(paths).toEqual(["a.md", "b.md"]);
		});

		it("skips directories", async () => {
			addFile(localFs, "notes/a.md", "hello", 1000);
			// notes/ directory is auto-created by addFile

			const result = await collectChanges(makeDeps());

			for (const entry of result.entries) {
				expect(entry.local?.isDirectory ?? false).toBe(false);
				expect(entry.remote?.isDirectory ?? false).toBe(false);
			}
		});

		it("returns empty entries when both sides are empty", async () => {
			const result = await collectChanges(makeDeps());
			expect(result.temperature).toBe("cold");
			expect(result.entries).toHaveLength(0);
		});

		it("enriches hashes with SHA-256 when local MD5 matches remote contentChecksum", async () => {
			const content = "identical content";
			const contentBuf = new TextEncoder().encode(content);
			const expectedMd5 = md5(contentBuf.buffer);
			const expectedSha256 = await sha256(contentBuf.buffer);

			addFile(localFs, "a.md", content, 1000);
			addFileWithMeta(remoteFs, "a.md", content, 2000, {
				contentChecksum: expectedMd5,
			});

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry?.local?.hash).toBe(expectedSha256);
			expect(entry?.remote?.hash).toBe(expectedSha256);
		});

		it("does not enrich hashes when MD5 differs", async () => {
			addFile(localFs, "a.md", "local version", 1000);
			addFileWithMeta(remoteFs, "a.md", "remote version", 2000, {
				contentChecksum: "differentmd5hash",
			});
			// Force same size so enrichment is attempted
			const localEntity = localFs.files.get("a.md")!.entity;
			const remoteEntity = remoteFs.files.get("a.md")!.entity;
			remoteEntity.size = localEntity.size;

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry?.local?.hash).toBe("");
			expect(entry?.remote?.hash).toBe("");
		});

		it("skips enrichment when sizes differ", async () => {
			const content = "same content";
			const expectedMd5 = md5(new TextEncoder().encode(content).buffer);

			addFile(localFs, "a.md", content, 1000);
			addFileWithMeta(remoteFs, "a.md", "different length content here", 2000, {
				contentChecksum: expectedMd5,
			});

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry?.local?.hash).toBe("");
			expect(entry?.remote?.hash).toBe("");
		});

		it("skips enrichment when remote has no contentChecksum", async () => {
			addFile(localFs, "a.md", "content", 1000);
			addFile(remoteFs, "a.md", "content", 2000);

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry?.local?.hash).toBe("");
			expect(entry?.remote?.hash).toBe("");
		});
	});

	describe("warm path", () => {
		it("returns warm when records exist and tracker is not initialized", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "hello", 1000);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
		});

		it("returns warm when tracker is initialized but no dirty paths", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "hello", 1000);
			// Acknowledge to initialize but clear all dirty paths
			localTracker.acknowledge([]);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
		});

		it("detects locally modified files", async () => {
			await stateStore.put(makeRecord("a.md", { localMtime: 500, localSize: 5 }));
			addFile(localFs, "a.md", "modified content", 2000);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry).toBeDefined();
			expect(entry?.local).toBeDefined();
		});

		it("detects locally deleted files", async () => {
			await stateStore.put(makeRecord("deleted.md"));
			// deleted.md is not in localFs

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "deleted.md");
			expect(entry).toBeDefined();
			expect(entry?.local).toBeUndefined();
		});

		it("excludes unchanged files from warm results", async () => {
			await stateStore.put(makeRecord("unchanged.md", { localMtime: 1000, localSize: 10 }));
			addFile(localFs, "unchanged.md", "0123456789", 1000);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			// unchanged.md should not be in warm results
			const entry = result.entries.find((e) => e.path === "unchanged.md");
			expect(entry).toBeUndefined();
		});

		it("detects new local files with no sync record", async () => {
			await stateStore.put(makeRecord("existing.md"));
			addFile(localFs, "existing.md", "content", 1000);
			addFile(localFs, "new-local.md", "brand new", 2000);
			// new-local.md has no sync record

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			const entry = result.entries.find((e) => e.path === "new-local.md");
			expect(entry).toBeDefined();
			expect(entry?.local).toBeDefined();
			expect(entry?.prevSync).toBeUndefined();
		});

		it("includes remote changed paths from getChangedPaths", async () => {
			await stateStore.put(makeRecord("remote-changed.md"));
			addFile(remoteFs, "remote-changed.md", "remote new content", 2000);

			// Attach getChangedPaths to remoteFs
			(remoteFs as unknown as { getChangedPaths: () => Promise<{ modified: string[]; deleted: string[] }> })
				.getChangedPaths = () => Promise.resolve({ modified: ["remote-changed.md"], deleted: [] });

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "remote-changed.md");
			expect(entry).toBeDefined();
			expect(entry?.remote).toBeDefined();
		});
	});

	describe("hot path", () => {
		it("returns hot when tracker is initialized and has dirty paths", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "modified", 2000);
			localTracker.markDirty("a.md");
			localTracker.acknowledge([]); // mark initialized without clearing dirty
			// re-mark after acknowledge
			localTracker.markDirty("a.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
		});

		it("only fetches stat for dirty paths", async () => {
			await stateStore.put(makeRecord("dirty.md", { localMtime: 500 }));
			await stateStore.put(makeRecord("clean.md"));
			addFile(localFs, "dirty.md", "changed", 2000);
			addFile(localFs, "clean.md", "unchanged", 1000);
			localTracker.acknowledge([]); // initialize
			localTracker.markDirty("dirty.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			const paths = result.entries.map((e) => e.path);
			expect(paths).toContain("dirty.md");
			expect(paths).not.toContain("clean.md");
		});

		it("includes remote changed paths in hot mode", async () => {
			await stateStore.put(makeRecord("local-dirty.md", { localMtime: 500 }));
			await stateStore.put(makeRecord("remote-only.md"));
			addFile(localFs, "local-dirty.md", "changed", 2000);
			addFile(remoteFs, "remote-only.md", "remote changed", 2000);

			(remoteFs as unknown as { getChangedPaths: () => Promise<{ modified: string[]; deleted: string[] }> })
				.getChangedPaths = () => Promise.resolve({ modified: ["remote-only.md"], deleted: [] });

			localTracker.acknowledge([]);
			localTracker.markDirty("local-dirty.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			const paths = result.entries.map((e) => e.path);
			expect(paths).toContain("local-dirty.md");
			expect(paths).toContain("remote-only.md");
		});

		it("includes remote deleted paths from getChangedPaths in hot mode", async () => {
			await stateStore.put(makeRecord("local-dirty.md", { localMtime: 500 }));
			await stateStore.put(makeRecord("remote-deleted.md"));
			addFile(localFs, "local-dirty.md", "changed", 2000);
			// remote-deleted.md is absent from remoteFs (deleted)

			(remoteFs as unknown as { getChangedPaths: () => Promise<{ modified: string[]; deleted: string[] }> })
				.getChangedPaths = () => Promise.resolve({ modified: [], deleted: ["remote-deleted.md"] });

			localTracker.acknowledge([]);
			localTracker.markDirty("local-dirty.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			const paths = result.entries.map((e) => e.path);
			expect(paths).toContain("remote-deleted.md");
			const deleted = result.entries.find((e) => e.path === "remote-deleted.md");
			expect(deleted?.remote).toBeUndefined();
		});

		it("includes locally deleted file that still exists on remote", async () => {
			await stateStore.put(makeRecord("deleted.md"));
			addFile(remoteFs, "deleted.md", "content", 1000);
			// deleted.md is not in localFs (locally deleted)
			localTracker.acknowledge([]);
			localTracker.markDirty("deleted.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			const entry = result.entries.find((e) => e.path === "deleted.md");
			expect(entry).toBeDefined();
			expect(entry?.local).toBeUndefined();
			expect(entry?.remote).toBeDefined();
			expect(entry?.prevSync).toBeDefined();
		});

		it("returns empty entries when no dirty paths and no remote changes", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "content", 1000);
			localTracker.acknowledge([]); // initialize
			localTracker.markDirty("orphan.md"); // dirty path that doesn't exist anywhere

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			// orphan.md has no local, no remote, no prevSync → filtered out
			const entry = result.entries.find((e) => e.path === "orphan.md");
			expect(entry).toBeUndefined();
		});
	});

	describe("getChangedPaths absent or returning null", () => {
		it("warm mode falls back gracefully when getChangedPaths is absent", async () => {
			await stateStore.put(makeRecord("a.md", { localMtime: 500 }));
			addFile(localFs, "a.md", "modified", 2000);
			delete (remoteFs as unknown as Record<string, unknown>).getChangedPaths;

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
		});

		it("warm mode handles getChangedPaths returning null", async () => {
			await stateStore.put(makeRecord("a.md", { localMtime: 500 }));
			addFile(localFs, "a.md", "modified", 2000);

			(remoteFs as unknown as { getChangedPaths: () => Promise<null> })
				.getChangedPaths = () => Promise.resolve(null);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry).toBeDefined();
		});
	});

	describe("rename pairs across temperature modes", () => {
		it("hot mode: enrichHashesForRenames fills hash via stat() for rename destination", async () => {
			await stateStore.put(makeRecord("old.md", { hash: "sha256abc", localMtime: 1000, localSize: 7 }));
			addFile(localFs, "new.md", "content", 1000);
			addFile(remoteFs, "old.md", "content", 1000);

			// Initialize tracker, then simulate rename
			localTracker.acknowledge([]);
			localTracker.markRenamed("new.md", "old.md");

			// Mock stat() returns hash (real LocalFs.stat computes SHA-256)
			const origStat = localFs.stat.bind(localFs);
			localFs.stat = async (path: string) => {
				const entity = await origStat(path);
				if (entity && path === "new.md") {
					return { ...entity, hash: await sha256(await localFs.read(path)) };
				}
				return entity;
			};

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			const entry = result.entries.find((e) => e.path === "new.md");
			expect(entry).toBeDefined();
			expect(entry?.local?.hash).not.toBe("");
		});

		it("hot mode: both old and new paths are included in entries", async () => {
			await stateStore.put(makeRecord("old.md", { hash: "sha256abc", localMtime: 1000, localSize: 7 }));
			addFile(localFs, "new.md", "content", 1000);
			addFile(remoteFs, "old.md", "content", 1000);

			localTracker.acknowledge([]);
			localTracker.markRenamed("new.md", "old.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			const paths = result.entries.map((e) => e.path);
			// markRenamed marks both paths dirty → both in stat() results
			expect(paths).toContain("new.md");
			expect(paths).toContain("old.md");
		});

		it("hot mode: remote rename pairs are included in ChangeSet", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "content", 1000);

			(remoteFs as unknown as { getChangedPaths: () => Promise<{ modified: string[]; deleted: string[]; renamed: { oldPath: string; newPath: string }[] }> })
				.getChangedPaths = () => Promise.resolve({
					modified: ["b.md"], deleted: ["a.md"],
					renamed: [{ oldPath: "a.md", newPath: "b.md" }],
				});

			localTracker.acknowledge([]);
			localTracker.markDirty("a.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			expect(result.remoteRenamePairs).toEqual([{ oldPath: "a.md", newPath: "b.md" }]);
		});

		it("warm mode: rename pair paths are included in changedPaths", async () => {
			// old.md has a sync record (known file)
			await stateStore.put(makeRecord("old.md", { localMtime: 1000, localSize: 7 }));
			// new.md exists locally (renamed from old.md), old.md gone locally
			addFile(localFs, "new.md", "content", 1000);
			addFile(remoteFs, "old.md", "content", 1000);

			// Tracker has rename pair but is NOT initialized (warm mode)
			localTracker.markRenamed("new.md", "old.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			const paths = result.entries.map((e) => e.path);
			// L149-153: rename pair paths explicitly injected into changedPaths
			expect(paths).toContain("new.md");
			expect(paths).toContain("old.md");
		});

		it("warm mode: remote rename pairs are included in ChangeSet", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "content", 1000);

			(remoteFs as unknown as { getChangedPaths: () => Promise<{ modified: string[]; deleted: string[]; renamed: { oldPath: string; newPath: string }[] }> })
				.getChangedPaths = () => Promise.resolve({
					modified: ["b.md"], deleted: ["a.md"],
					renamed: [{ oldPath: "a.md", newPath: "b.md" }],
				});

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			expect(result.remoteRenamePairs).toEqual([{ oldPath: "a.md", newPath: "b.md" }]);
		});

		it("cold mode: remoteRenamePairs is empty", async () => {
			addFile(localFs, "a.md", "content", 1000);
			addFile(remoteFs, "a.md", "content", 1000);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("cold");
			expect(result.remoteRenamePairs).toEqual([]);
		});
	});

	describe("enrichHashesForRenames", () => {
		it("enriches hash while preserving mtime and size from list()", async () => {
			await stateStore.put(makeRecord("old.md", { hash: "sha256abc", localMtime: 1000, localSize: 7 }));
			const listEntity = addFile(localFs, "new.md", "content", 1000);
			addFile(remoteFs, "old.md", "content", 1000);
			localTracker.markRenamed("new.md", "old.md");

			// Override stat() to return a different mtime (simulates stat/list divergence)
			localFs.stat = async (path: string) => {
				const content = await localFs.read(path);
				return {
					path, isDirectory: false, size: content.byteLength,
					mtime: 9999, hash: await sha256(content),
				};
			};

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			const entry = result.entries.find((e) => e.path === "new.md");
			expect(entry?.local?.hash).not.toBe("");
			expect(entry?.local?.mtime).toBe(listEntity.mtime);
			expect(entry?.local?.size).toBe(listEntity.size);
		});

		it("does not enrich when no rename pairs exist", async () => {
			await stateStore.put(makeRecord("a.md", { localMtime: 500 }));
			addFile(localFs, "a.md", "modified", 2000);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry?.local?.hash).toBe("");
		});

		it("preserves local entry unchanged when stat() throws", async () => {
			await stateStore.put(makeRecord("old.md", { hash: "sha256abc", localMtime: 1000, localSize: 7 }));
			const listEntity = addFile(localFs, "new.md", "content", 1000);
			addFile(remoteFs, "old.md", "content", 1000);
			localTracker.markRenamed("new.md", "old.md");

			localFs.stat = () => { throw new Error("disk error"); };

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			const entry = result.entries.find((e) => e.path === "new.md");
			expect(entry?.local?.hash).toBe("");
			expect(entry?.local?.mtime).toBe(listEntity.mtime);
			expect(entry?.local?.size).toBe(listEntity.size);
		});
	});

	describe("enrichHashesForRenames (unit)", () => {
		function entry(path: string, localHash: string): MixedEntity {
			return { path, local: { path, isDirectory: false, size: 7, mtime: 1000, hash: localHash } };
		}

		it("fills hash on rename destination when local hash is empty", async () => {
			const entries = [entry("new.md", "")];
			const pairs = new Map([["new.md", "old.md"]]);

			addFile(localFs, "new.md", "content", 1000);
			const origStat = localFs.stat.bind(localFs);
			localFs.stat = async (path: string) => {
				const e = await origStat(path);
				if (e) return { ...e, hash: "sha256-hash" };
				return e;
			};

			await enrichHashesForRenames(entries, localFs, pairs);

			expect(entries[0]!.local!.hash).toBe("sha256-hash");
		});

		it("skips entries where hash is already present", async () => {
			const entries = [entry("new.md", "existing-hash")];
			const pairs = new Map([["new.md", "old.md"]]);

			await enrichHashesForRenames(entries, localFs, pairs);

			expect(entries[0]!.local!.hash).toBe("existing-hash");
		});

		it("skips entries where local is undefined", async () => {
			const entries: MixedEntity[] = [{ path: "new.md" }];
			const pairs = new Map([["new.md", "old.md"]]);

			await enrichHashesForRenames(entries, localFs, pairs);

			expect(entries[0]!.local).toBeUndefined();
		});

		it("skips entries not in rename pairs", async () => {
			const entries = [entry("unrelated.md", "")];
			const pairs = new Map([["new.md", "old.md"]]);

			await enrichHashesForRenames(entries, localFs, pairs);

			expect(entries[0]!.local!.hash).toBe("");
		});

		it("skips when stat() throws", async () => {
			const entries = [entry("new.md", "")];
			const pairs = new Map([["new.md", "old.md"]]);

			localFs.stat = () => { throw new Error("disk error"); };

			await enrichHashesForRenames(entries, localFs, pairs);

			expect(entries[0]!.local!.hash).toBe("");
		});

		it("skips when stat() returns null", async () => {
			const entries = [entry("new.md", "")];
			const pairs = new Map([["new.md", "old.md"]]);

			localFs.stat = () => Promise.resolve(null);

			await enrichHashesForRenames(entries, localFs, pairs);

			expect(entries[0]!.local!.hash).toBe("");
		});

		it("no-ops when rename pairs is empty", async () => {
			const entries = [entry("new.md", "")];

			await enrichHashesForRenames(entries, localFs, new Map());

			expect(entries[0]!.local!.hash).toBe("");
		});
	});
});
