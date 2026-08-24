import { describe, it, expect, beforeEach, vi } from "vitest";
import { collectChanges } from "./change-detector";
import { enrichHashesForRenames } from "./change-hash-enrichment";
import { planSync } from "./decision-engine";
import type { ChangeDetectorDeps } from "./change-detector";
import { LocalChangeTracker } from "./local-tracker";
import { createMockLocalFs, createMockRemoteFs, type MockFileSystem, createMockStateStore, addFile } from "../__mocks__/sync-test-helpers";
import type { FileEntity, RemoteChecksum } from "../fs/types";
import type { MixedEntity, PathObservation, SyncRecord } from "./types";
import { md5 } from "../utils/md5";
import { sha256, sha1 } from "../utils/hash";
import { projectRenameScope, projectScope } from "./scope-projection";

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
	let localFs: MockFileSystem;
	let remoteFs: MockFileSystem;
	let stateStore: ReturnType<typeof createMockStateStore>;
	let localTracker: LocalChangeTracker;

	function makeDeps(): ChangeDetectorDeps {
		return { localFs, remoteFs, stateStore, changes: localTracker.snapshot() };
	}

	beforeEach(() => {
		localFs = createMockLocalFs();
		remoteFs = createMockRemoteFs();
		stateStore = createMockStateStore();
		localTracker = new LocalChangeTracker();
	});

	/** Add a file to mock FS with a remote-provided checksum (e.g. Google Drive md5). */
	function addFileWithChecksum(
		fs: MockFileSystem,
		path: string,
		text: string,
		mtime: number,
		checksum: RemoteChecksum,
	): FileEntity {
		const entity = addFile(fs, path, text, mtime);
		entity.remoteChecksum = checksum;
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

		it("enriches hashes with SHA-256 when local MD5 matches remote checksum", async () => {
			const content = "identical content";
			const contentBuf = new TextEncoder().encode(content);
			const expectedMd5 = md5(contentBuf.buffer);
			const expectedSha256 = await sha256(contentBuf.buffer);

			addFile(localFs, "a.md", content, 1000);
			addFileWithChecksum(remoteFs, "a.md", content, 2000, { algo: "md5", value: expectedMd5 });

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry?.local?.hash).toBe(expectedSha256);
			expect(entry?.remote?.hash).toBe(expectedSha256);
		});

		it("enriches when remote checksum is SHA-1 and local SHA-1 matches", async () => {
			const content = "identical content";
			const contentBuf = new TextEncoder().encode(content);
			const expectedSha1 = await sha1(contentBuf.buffer);
			const expectedSha256 = await sha256(contentBuf.buffer);

			addFile(localFs, "a.md", content, 1000);
			addFileWithChecksum(remoteFs, "a.md", content, 2000, { algo: "sha1", value: expectedSha1 });

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry?.local?.hash).toBe(expectedSha256);
			expect(entry?.remote?.hash).toBe(expectedSha256);
		});

		it("skips enrichment when the remote checksum is opaque (not locally computable)", async () => {
			// Identical content + size, but an opaque (e.g. pCloud) checksum cannot be
			// reproduced locally, so cross-side dedup must not fire here.
			const content = "identical content";
			addFile(localFs, "a.md", content, 1000);
			addFileWithChecksum(remoteFs, "a.md", content, 2000, { algo: "opaque", value: "pcloud-hash" });
			const localEntity = localFs.files.get("a.md")!.entity;
			const remoteEntity = remoteFs.files.get("a.md")!.entity;
			remoteEntity.size = localEntity.size;

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry?.local?.hash).toBe("");
			expect(entry?.remote?.hash).toBe("");
		});

		it("does not enrich hashes when MD5 differs", async () => {
			addFile(localFs, "a.md", "local version", 1000);
			addFileWithChecksum(remoteFs, "a.md", "remote version", 2000, { algo: "md5", value: "differentmd5hash" });
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
			addFileWithChecksum(remoteFs, "a.md", "different length content here", 2000, { algo: "md5", value: expectedMd5 });

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry?.local?.hash).toBe("");
			expect(entry?.remote?.hash).toBe("");
		});

		it("skips enrichment when remote has no checksum", async () => {
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
			localTracker.acknowledge(localTracker.snapshot());

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

			// Drive the checkpoint capability's getChangedPaths
			remoteFs.checkpoint!.getChangedPaths = () => Promise.resolve({ modified: ["remote-changed.md"], deleted: [] });

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "remote-changed.md");
			expect(entry).toBeDefined();
			expect(entry?.remote).toBeDefined();
		});

		it("confirms local absence for a new remote-only delta path", async () => {
			await stateStore.put(makeRecord("existing.md"));
			addFile(remoteFs, "new-remote.md", "remote", 2000);
			remoteFs.checkpoint!.getChangedPaths = () => Promise.resolve({
				modified: ["new-remote.md"], deleted: [],
			});

			const result = await collectChanges(makeDeps());

			expect(result.entries.find((entry) => entry.path === "new-remote.md")).toMatchObject({
				local: undefined,
				remote: { path: "new-remote.md" },
				prevSync: undefined,
			});
			expect(result.observations).toContainEqual({
				kind: "absent", side: "local", requestedPath: "new-remote.md", authority: "stat",
			});
		});
	});

	describe("hot path", () => {
		it("returns hot when tracker is initialized and has dirty paths", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "modified", 2000);
			localTracker.markDirty("a.md");
			localTracker.acknowledge(localTracker.snapshot()); // flip out of cold-start
			localTracker.markDirty("a.md"); // dirty again for this cycle

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
		});

		it("only fetches stat for dirty paths", async () => {
			await stateStore.put(makeRecord("dirty.md", { localMtime: 500 }));
			await stateStore.put(makeRecord("clean.md"));
			addFile(localFs, "dirty.md", "changed", 2000);
			addFile(localFs, "clean.md", "unchanged", 1000);
			localTracker.acknowledge(localTracker.snapshot()); // initialize
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

			remoteFs.checkpoint!.getChangedPaths = () => Promise.resolve({ modified: ["remote-only.md"], deleted: [] });

			localTracker.acknowledge(localTracker.snapshot());
			localTracker.markDirty("local-dirty.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			const paths = result.entries.map((e) => e.path);
			expect(paths).toContain("local-dirty.md");
			expect(paths).toContain("remote-only.md");
		});

		it("retains an authoritative remote deletion with an unchanged local file in hot mode", async () => {
			await stateStore.put(makeRecord("local-dirty.md", { localMtime: 500 }));
			addFile(localFs, "local-dirty.md", "changed", 2000);
			addFile(localFs, "remote-deleted.md", "unchanged", 1000);
			const unchanged = await localFs.stat("remote-deleted.md");
			expect(unchanged).not.toBeNull();
			await stateStore.put(makeRecord("remote-deleted.md", {
				hash: unchanged!.hash,
				localMtime: unchanged!.mtime,
				localSize: unchanged!.size,
			}));
			// The local copy survives unchanged; only the checkpoint authoritatively
			// reports that the remote copy was deleted.

			remoteFs.checkpoint!.getChangedPaths = () => Promise.resolve({ modified: [], deleted: ["remote-deleted.md"] });

			localTracker.acknowledge(localTracker.snapshot());
			localTracker.markDirty("local-dirty.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			const paths = result.entries.map((e) => e.path);
			expect(paths).toContain("remote-deleted.md");
			const deleted = result.entries.find((e) => e.path === "remote-deleted.md");
			expect(deleted?.local).toBeDefined();
			expect(deleted?.remote).toBeUndefined();
			expect(planSync([deleted!]).actions).toMatchObject([
				{ path: "remote-deleted.md", action: "delete_local" },
			]);
		});

		it("keeps an authoritative remote deletion as conflict when the local file changed", async () => {
			await stateStore.put(makeRecord("local-dirty.md", { localMtime: 500 }));
			await stateStore.put(makeRecord("remote-deleted.md", {
				hash: "baseline-hash",
				localMtime: 1000,
				localSize: 8,
			}));
			addFile(localFs, "local-dirty.md", "changed", 2000);
			addFile(localFs, "remote-deleted.md", "locally changed", 2000);
			remoteFs.checkpoint!.getChangedPaths = () => Promise.resolve({
				modified: [],
				deleted: ["remote-deleted.md"],
			});
			localTracker.acknowledge(localTracker.snapshot());
			localTracker.markDirty("local-dirty.md");

			const result = await collectChanges(makeDeps());
			const deleted = result.entries.find((e) => e.path === "remote-deleted.md");

			expect(planSync([deleted!]).actions).toMatchObject([
				{ path: "remote-deleted.md", action: "conflict" },
			]);
		});

		it("includes locally deleted file that still exists on remote", async () => {
			await stateStore.put(makeRecord("deleted.md"));
			addFile(remoteFs, "deleted.md", "content", 1000);
			// deleted.md is not in localFs (locally deleted)
			localTracker.acknowledge(localTracker.snapshot());
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
			localTracker.acknowledge(localTracker.snapshot()); // initialize
			localTracker.markDirty("orphan.md"); // dirty path that doesn't exist anywhere

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			// orphan.md has no local, no remote, no prevSync → filtered out
			const entry = result.entries.find((e) => e.path === "orphan.md");
			expect(entry).toBeUndefined();
		});
	});

	describe("checkpoint capability absent or getChangedPaths returning null", () => {
		it("warm mode falls back gracefully when the checkpoint capability is absent", async () => {
			await stateStore.put(makeRecord("a.md", { localMtime: 500 }));
			addFile(localFs, "a.md", "modified", 2000);
			delete remoteFs.checkpoint;

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
		});

		it("warm mode handles getChangedPaths returning null", async () => {
			await stateStore.put(makeRecord("a.md", { localMtime: 500 }));
			addFile(localFs, "a.md", "modified", 2000);

			remoteFs.checkpoint!.getChangedPaths = () => Promise.resolve(null);

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
			localTracker.acknowledge(localTracker.snapshot());
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

			localTracker.acknowledge(localTracker.snapshot());
			localTracker.markRenamed("new.md", "old.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			const paths = result.entries.map((e) => e.path);
			// markRenamed marks both paths dirty → both in stat() results
			expect(paths).toContain("new.md");
			expect(paths).toContain("old.md");
		});

		it("hot mode: treats a case-insensitive stat alias as an absent rename source", async () => {
			await stateStore.put(makeRecord("PRUEBA.md", {
				hash: "sha256abc",
				localMtime: 1000,
				localSize: 7,
			}));
			addFile(localFs, "PRUEBa.md", "content", 1000);
			addFile(remoteFs, "PRUEBA.md", "content", 1000);

			localTracker.acknowledge(localTracker.snapshot());
			localTracker.markRenamed("PRUEBa.md", "PRUEBA.md");

			const exactStat = localFs.stat.bind(localFs);
			localFs.stat = async (path: string) => {
				const exact = await exactStat(path);
				if (exact) return exact;
				const alias = [...localFs.files.keys()].find(
					(candidate) => candidate.toLowerCase() === path.toLowerCase(),
				);
				return alias ? exactStat(alias) : null;
			};

			const result = await collectChanges(makeDeps());
			const source = result.entries.find((entry) => entry.path === "PRUEBA.md");
			const destination = result.entries.find((entry) => entry.path === "PRUEBa.md");

			expect(result.temperature).toBe("hot");
			expect(source).toMatchObject({
				path: "PRUEBA.md",
				local: undefined,
			});
			expect(source?.remote).toBeDefined();
			expect(source?.prevSync).toBeDefined();
			expect(destination?.local?.path).toBe("PRUEBa.md");
		});

		it("hot mode: preserves a rename source that was recreated before syncing", async () => {
			await stateStore.put(makeRecord("PRUEBA.md", {
				hash: "sha256abc",
				localMtime: 1000,
				localSize: 7,
			}));
			addFile(localFs, "PRUEBA.md", "recreated source", 2000);
			addFile(localFs, "PRUEBa.md", "content", 1000);
			addFile(remoteFs, "PRUEBA.md", "content", 1000);

			localTracker.acknowledge(localTracker.snapshot());
			localTracker.markRenamed("PRUEBa.md", "PRUEBA.md");

			const result = await collectChanges(makeDeps());
			const source = result.entries.find((entry) => entry.path === "PRUEBA.md");

			expect(source?.local?.path).toBe("PRUEBA.md");
		});

		it("hot mode: remote rename pairs are included in ChangeSet", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "content", 1000);

			remoteFs.checkpoint!.getChangedPaths = () => Promise.resolve({
				modified: ["b.md"], deleted: ["a.md"],
				renamed: [{ oldPath: "a.md", newPath: "b.md" }],
			});

			localTracker.acknowledge(localTracker.snapshot());
			localTracker.markDirty("a.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			expect(result.observations).toContainEqual({
				kind: "absent", side: "remote", requestedPath: "a.md",
				authority: "checkpoint_deleted",
			});
			expect(result.identityEvidence).toContainEqual({
				kind: "rename", side: "remote", oldPath: "a.md", newPath: "b.md",
				isFolder: false, authority: "reported",
			});
		});

		it("keeps a requested-echo stat result unresolved and out of exact entries", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "content", 1000);
			addFile(remoteFs, "a.md", "content", 1000);
			const originalStat = localFs.stat.bind(localFs);
			localFs.stat = async (path) => {
				const entity = await originalStat(path);
				return entity ? { ...entity, pathAuthority: "requested_echo" } : null;
			};
			localTracker.acknowledge(localTracker.snapshot());
			localTracker.markDirty("a.md");

			const result = await collectChanges(makeDeps());

			expect(result.observations).toContainEqual(expect.objectContaining({
				kind: "present_unresolved", side: "local", requestedPath: "a.md",
			}));
			expect(result.entries.find((entry) => entry.path === "a.md")?.local).toBeUndefined();
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

			remoteFs.checkpoint!.getChangedPaths = () => Promise.resolve({
				modified: ["b.md"], deleted: ["a.md"],
				renamed: [{ oldPath: "a.md", newPath: "b.md" }],
			});

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			expect(result.observations).toContainEqual({
				kind: "absent", side: "remote", requestedPath: "a.md",
				authority: "checkpoint_deleted",
			});
			expect(result.identityEvidence).toContainEqual({
				kind: "rename", side: "remote", oldPath: "a.md", newPath: "b.md",
				isFolder: false, authority: "reported",
			});
		});

		it("warm mode: preserves a stat-confirmed unresolved remote presence", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "content", 1000);
			addFile(remoteFs, "a.md", "content", 1000);
			remoteFs.checkpoint!.getChangedPaths = () => Promise.resolve({
				modified: ["a.md"], deleted: [],
			});
			const originalStat = remoteFs.stat.bind(remoteFs);
			let statCalls = 0;
			remoteFs.stat = async (path) => {
				statCalls += 1;
				if (statCalls > 1) return null;
				const candidate = await originalStat(path);
				return candidate ? { ...candidate, pathAuthority: "requested_echo" } : null;
			};

			const result = await collectChanges(makeDeps());

			expect(statCalls).toBe(1);
			expect(result.observations).toContainEqual(expect.objectContaining({
				kind: "present_unresolved", side: "remote", requestedPath: "a.md", source: "stat",
			}));
			expect(result.entries.find((entry) => entry.path === "a.md")?.remote).toBeUndefined();
		});

		it("cold mode has no reported rename evidence", async () => {
			addFile(localFs, "a.md", "content", 1000);
			addFile(remoteFs, "a.md", "content", 1000);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("cold");
			expect(result.identityEvidence).toEqual([]);
		});

		it("authoritatively observes otherwise-unseen folder rename roots", async () => {
			await localFs.mkdir("new");
			localTracker.markFolderRenamed("new", "old");

			const result = await collectChanges(makeDeps(), { forceFullScan: true });

			expect(result.identityEvidence).toContainEqual({
				kind: "rename", side: "local", oldPath: "old", newPath: "new",
				isFolder: true, authority: "reported",
			});
			expect(result.observations).toContainEqual({
				kind: "absent", side: "local", requestedPath: "old", authority: "stat",
			});
			expect(result.observations).toContainEqual(expect.objectContaining({
				kind: "exact", side: "local", requestedPath: "new",
			}));
		});

		it("aborts when an unseen folder endpoint cannot be confirmed", async () => {
			localTracker.markFolderRenamed("new", "old");
			localFs.stat = () => { throw new Error("folder stat failed"); };

			await expect(collectChanges(makeDeps(), { forceFullScan: true }))
				.rejects.toThrow("folder stat failed");
		});

		it.each([false, true])(
			"lists folder descendants when initialized with concurrent dirty=%s",
			async (withConcurrentDirty) => {
				await stateStore.put(makeRecord("old/a.md"));
				addFile(remoteFs, "old/a.md", "content", 1000);
				addFile(localFs, "new/a.md", "content", 1000);
				if (withConcurrentDirty) {
					await stateStore.put(makeRecord("other.md"));
					addFile(localFs, "other.md", "changed", 2000);
					addFile(remoteFs, "other.md", "original", 1000);
				}
				localTracker.acknowledge(localTracker.snapshot());
				localTracker.markFolderRenamed("new", "old");
				if (withConcurrentDirty) localTracker.markDirty("other.md");

				const result = await collectChanges(makeDeps());

				expect(result.temperature).toBe("warm");
				expect(result.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
					"old/a.md", "new/a.md",
				]));
				const folderEvidence = result.identityEvidence.find((e) =>
					e.kind === "rename" && e.isFolder);
				expect(folderEvidence?.kind).toBe("rename");
				if (!folderEvidence || folderEvidence.kind !== "rename") return;

				const rootsOut = projectScope(result, {
					classifyPath: (path) => path === "old" || path === "new"
						? "policy_out"
						: "included",
				});
				expect(projectRenameScope(folderEvidence, rootsOut).consequence).toBe("defer");

				const mixedChild = projectScope(result, {
					classifyPath: (path) => path === "new/a.md" ? "policy_out" : "included",
				});
				expect(projectRenameScope(folderEvidence, mixedChild).consequence).toBe("defer");
			},
		);

		it.each([false, true])(
			"promotes a remote folder rename to cold with concurrent dirty=%s",
			async (withConcurrentDirty) => {
			await stateStore.put(makeRecord("old/a.md"));
			addFile(localFs, "old/a.md", "content", 1000);
			addFile(remoteFs, "new/a.md", "content", 1000);
			const getChangedPaths = vi.fn(() => Promise.resolve({
				modified: ["new"],
				deleted: ["old"],
				renamed: [{ oldPath: "old", newPath: "new", isFolder: true }],
			}));
			remoteFs.checkpoint!.getChangedPaths = getChangedPaths;
			localTracker.acknowledge(localTracker.snapshot());
			if (withConcurrentDirty) localTracker.markDirty("unrelated.md");

			const result = await collectChanges(makeDeps());

			expect(getChangedPaths).toHaveBeenCalledTimes(1);
			expect(result.temperature).toBe("cold");
			expect(result.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
				"old/a.md", "new/a.md",
			]));
			const folderEvidence = result.identityEvidence.find((e) =>
				e.kind === "rename" && e.side === "remote" && e.isFolder);
			expect(folderEvidence?.kind).toBe("rename");
			if (!folderEvidence || folderEvidence.kind !== "rename") return;

			const mixedChild = projectScope(result, {
				classifyPath: (path) => path === "new/a.md" ? "policy_out" : "included",
			});
			expect(projectRenameScope(folderEvidence, mixedChild).consequence).toBe("defer");
			},
		);

		it("fails closed when a remote folder delta has no replay-free snapshot", async () => {
			await stateStore.put(makeRecord("old/a.md"));
			remoteFs.checkpoint!.getChangedPaths = () => Promise.resolve({
				modified: ["new"], deleted: ["old"],
				renamed: [{ oldPath: "old", newPath: "new", isFolder: true }],
			});
			delete remoteFs.checkpoint!.listCurrentSnapshot;
			localTracker.acknowledge(localTracker.snapshot());
			localTracker.markDirty("unrelated.md");

			await expect(collectChanges(makeDeps())).rejects.toThrow(
				"Remote folder rename requires a replay-free checkpoint snapshot",
			);
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
				if (path === "old.md") return null;
				const content = await localFs.read(path);
				return {
					path, pathAuthority: "actual_resolved", isDirectory: false, size: content.byteLength,
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

		it("records an alias found while enriching as identity evidence", async () => {
			await stateStore.put(makeRecord("old.md", {
				hash: "sha256abc", localMtime: 1000, localSize: 7,
			}));
			addFile(localFs, "new.md", "content", 1000);
			addFile(remoteFs, "old.md", "content", 1000);
			localTracker.markRenamed("new.md", "old.md");
			const originalStat = localFs.stat.bind(localFs);
			localFs.stat = async (path) => {
				if (path !== "new.md") return originalStat(path);
				const candidate = await originalStat(path);
				return candidate ? {
					...candidate, path: "New.md", pathAuthority: "actual_resolved",
				} : null;
			};

			const result = await collectChanges(makeDeps());

			expect(result.entries.find((entry) => entry.path === "new.md")?.local)
				.toBeUndefined();
			expect(result.observations).toContainEqual(expect.objectContaining({
				kind: "alias", side: "local", requestedPath: "new.md", resolvedPath: "New.md",
			}));
			expect(result.identityEvidence).toContainEqual({
				kind: "alias", side: "local", requestedPath: "new.md", resolvedPath: "New.md",
			});
		});

		it("does not enrich when no rename pairs exist", async () => {
			await stateStore.put(makeRecord("a.md", { localMtime: 500 }));
			addFile(localFs, "a.md", "modified", 2000);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry?.local?.hash).toBe("");
		});

		it("aborts when authoritative deletion confirmation throws", async () => {
			await stateStore.put(makeRecord("old.md", { hash: "sha256abc", localMtime: 1000, localSize: 7 }));
			const listEntity = addFile(localFs, "new.md", "content", 1000);
			addFile(remoteFs, "old.md", "content", 1000);
			localTracker.markRenamed("new.md", "old.md");

			localFs.stat = () => { throw new Error("disk error"); };

			await expect(collectChanges(makeDeps())).rejects.toThrow("disk error");
			expect(listEntity.hash).toBe("");
		});
	});

	describe("enrichHashesForRenames (unit)", () => {
		let observations: PathObservation[];

		beforeEach(() => {
			observations = [];
		});

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

			await enrichHashesForRenames(entries, observations, localFs, pairs);

			expect(entries[0]!.local!.hash).toBe("sha256-hash");
			expect(observations).toContainEqual(expect.objectContaining({
				kind: "exact", side: "local", requestedPath: "new.md",
			}));
		});

		it("skips entries where hash is already present", async () => {
			const entries = [entry("new.md", "existing-hash")];
			const pairs = new Map([["new.md", "old.md"]]);

			await enrichHashesForRenames(entries, observations, localFs, pairs);

			expect(entries[0]!.local!.hash).toBe("existing-hash");
		});

		it("skips entries where local is undefined", async () => {
			const entries: MixedEntity[] = [{ path: "new.md" }];
			const pairs = new Map([["new.md", "old.md"]]);

			await enrichHashesForRenames(entries, observations, localFs, pairs);

			expect(entries[0]!.local).toBeUndefined();
		});

		it("skips entries not in rename pairs", async () => {
			const entries = [entry("unrelated.md", "")];
			const pairs = new Map([["new.md", "old.md"]]);

			await enrichHashesForRenames(entries, observations, localFs, pairs);

			expect(entries[0]!.local!.hash).toBe("");
		});

		it("aborts when stat() throws", async () => {
			const entries = [entry("new.md", "")];
			const pairs = new Map([["new.md", "old.md"]]);

			localFs.stat = () => { throw new Error("disk error"); };

			await expect(
				enrichHashesForRenames(entries, observations, localFs, pairs),
			).rejects.toThrow("disk error");

			expect(entries[0]!.local!.hash).toBe("");
		});

		it("replaces a stale listing entry when stat() returns null", async () => {
			const entries = [entry("new.md", "")];
			const pairs = new Map([["new.md", "old.md"]]);

			localFs.stat = () => Promise.resolve(null);

			await enrichHashesForRenames(entries, observations, localFs, pairs);

			expect(entries[0]!.local).toBeUndefined();
			expect(observations).toContainEqual({
				kind: "absent", side: "local", requestedPath: "new.md", authority: "stat",
			});
		});

		it("does not copy a requested-echo stat hash into an exact entry", async () => {
			const entries = [entry("new.md", "")];
			const pairs = new Map([["new.md", "old.md"]]);
			localFs.stat = () => Promise.resolve({
				path: "new.md", pathAuthority: "requested_echo", isDirectory: false,
				size: 7, mtime: 1000, hash: "untrusted-hash",
			});

			await enrichHashesForRenames(entries, observations, localFs, pairs);

			expect(entries[0]!.local).toBeUndefined();
			expect(observations).toContainEqual(expect.objectContaining({
				kind: "present_unresolved", requestedPath: "new.md", source: "stat",
			}));
		});

		it("does not copy an alias stat hash into the requested-path entry", async () => {
			const entries = [entry("new.md", "")];
			const pairs = new Map([["new.md", "old.md"]]);
			localFs.stat = () => Promise.resolve({
				path: "New.md", pathAuthority: "actual_resolved", isDirectory: false,
				size: 7, mtime: 1000, hash: "alias-hash",
			});

			await enrichHashesForRenames(entries, observations, localFs, pairs);

			expect(entries[0]!.local).toBeUndefined();
			expect(observations).toContainEqual(expect.objectContaining({
				kind: "alias", requestedPath: "new.md", resolvedPath: "New.md",
			}));
		});

		it("no-ops when rename pairs is empty", async () => {
			const entries = [entry("new.md", "")];

			await enrichHashesForRenames(entries, observations, localFs, new Map());

			expect(entries[0]!.local!.hash).toBe("");
		});

		it("fills hashes for every file below a folder rename destination", async () => {
			const entries = [
				entry("Published/a.md", ""),
				entry("Published/nested/b.md", ""),
				entry("unrelated.md", ""),
			];
			addFile(localFs, "Published/a.md", "a", 1000).hash = "hash-a";
			addFile(localFs, "Published/nested/b.md", "b", 1000).hash = "hash-b";
			addFile(localFs, "unrelated.md", "other", 1000).hash = "hash-other";

			await enrichHashesForRenames(
				entries, observations, localFs, new Map(), new Map([["Published", "Drafts"]]),
			);

			expect(entries.map((candidate) => candidate.local?.hash)).toEqual([
				"hash-a", "hash-b", "",
			]);
		});

		it("bounds folder descendant stat work to ten concurrent operations", async () => {
			const entries = Array.from({ length: 12 }, (_, index) =>
				entry(`Published/${index}.md`, ""));
			let active = 0;
			let maxActive = 0;
			let releaseStats!: () => void;
			const statsReleased = new Promise<void>((resolve) => { releaseStats = resolve; });
			localFs.stat = async (path) => {
				active++;
				maxActive = Math.max(maxActive, active);
				await statsReleased;
				active--;
				return {
					path, pathAuthority: "actual_resolved", isDirectory: false,
					size: 7, mtime: 1000, hash: `hash-${path}`,
				};
			};

			const enrichment = enrichHashesForRenames(
				entries, observations, localFs, new Map(), new Map([["Published", "Drafts"]]),
			);
			await vi.waitFor(() => expect(maxActive).toBe(10));
			releaseStats();
			await enrichment;

			expect(maxActive).toBe(10);
			expect(entries.every((candidate) => candidate.local?.hash.startsWith("hash-")))
				.toBe(true);
		});
	});
});

describe("collectChanges — warm deletion confirmation", () => {
	let localFs: MockFileSystem;
	let remoteFs: MockFileSystem;
	let stateStore: ReturnType<typeof createMockStateStore>;
	let localTracker: LocalChangeTracker;

	function makeDeps(): ChangeDetectorDeps {
		return { localFs, remoteFs, stateStore, changes: localTracker.snapshot() };
	}

	beforeEach(() => {
		localFs = createMockLocalFs();
		remoteFs = createMockRemoteFs();
		stateStore = createMockStateStore();
		localTracker = new LocalChangeTracker();
	});

	it("keeps a baseline path present on disk but missing from list() (no deletion)", async () => {
		await stateStore.put(
			makeRecord("a.md", { localMtime: 1000, localSize: 5, remoteMtime: 1000, remoteSize: 5 }),
		);
		addFile(remoteFs, "a.md", "hello", 1000);
		addFile(localFs, "a.md", "hello", 1000); // on disk → stat finds it
		vi.spyOn(localFs, "list").mockResolvedValueOnce([]); // incomplete listing

		const result = await collectChanges(makeDeps());

		const entry = result.entries.find((e) => e.path === "a.md");
		expect(entry?.local).toBeDefined(); // confirmed present → not a deletion
	});

	it("treats a baseline path absent on disk (stat null) as a deletion", async () => {
		await stateStore.put(
			makeRecord("gone.md", { localMtime: 1000, localSize: 5, remoteMtime: 1000, remoteSize: 5 }),
		);
		addFile(remoteFs, "gone.md", "hello", 1000);
		// gone.md not in localFs → stat returns null

		const result = await collectChanges(makeDeps());

		const entry = result.entries.find((e) => e.path === "gone.md");
		expect(entry?.local).toBeUndefined(); // genuine deletion preserved
	});
});

/**
 * forceFullScan recovery (ARCHITECTURE.md principle #5, "an interrupted sync
 * converges by re-syncing"). WARM detects remote changes via the delta cursor
 * alone. After an interrupted/partial sync the cursor has advanced past files
 * that were *reported* but never pulled-and-baselined, so WARM is structurally
 * blind to them: they exist remotely, have no baseline, and never reappear in
 * the delta. forceFullScan forces a COLD full join (remote list vs records),
 * which is the only mode that rediscovers such orphans.
 */
describe("collectChanges — forceFullScan rediscovers un-baselined remote files", () => {
	let localFs: MockFileSystem;
	let remoteFs: MockFileSystem;
	let stateStore: ReturnType<typeof createMockStateStore>;
	let localTracker: LocalChangeTracker;

	function makeDeps(): ChangeDetectorDeps {
		return { localFs, remoteFs, stateStore, changes: localTracker.snapshot() };
	}

	beforeEach(async () => {
		localFs = createMockLocalFs();
		remoteFs = createMockRemoteFs();
		stateStore = createMockStateStore();
		localTracker = new LocalChangeTracker();
		// Post-crash state: synced.md was pulled and its baseline committed;
		// orphan.md was left un-pulled. The remote delta cursor has moved past
		// orphan.md, so getChangedPaths() (the mock default) reports nothing.
		addFile(localFs, "synced.md", "kept", 1000);
		addFile(remoteFs, "synced.md", "kept", 1000);
		addFile(remoteFs, "orphan.md", "left behind", 1000);
		await stateStore.put(
			makeRecord("synced.md", { localMtime: 1000, localSize: 4, remoteMtime: 1000, remoteSize: 4 }),
		);
		// Fresh tracker (dirty set lost on restart) + non-empty store routes to WARM.
	});

	it("WARM is blind to the un-baselined remote file (documents the gap)", async () => {
		const result = await collectChanges(makeDeps());

		expect(result.temperature).toBe("warm");
		expect(result.entries.find((e) => e.path === "orphan.md")).toBeUndefined();
	});

	it("forceFullScan goes COLD and surfaces the orphan as a remote-only entry", async () => {
		const result = await collectChanges(makeDeps(), { forceFullScan: true });

		expect(result.temperature).toBe("cold");
		const orphan = result.entries.find((e) => e.path === "orphan.md");
		expect(orphan?.remote).toBeDefined();
		expect(orphan?.local).toBeUndefined();
		expect(orphan?.prevSync).toBeUndefined(); // no baseline → will be pulled
	});
});
