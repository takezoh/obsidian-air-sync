import { describe, it, expect, beforeEach, vi } from "vitest";
import { prepareConflict, resolveConflict } from "./conflict-resolver";
import type { SyncRecord } from "./types";
import { AuthError } from "../fs/errors";
import {
	createMockLocalFs, createMockRemoteFs, type MockFileSystem,
	createMockStateStore,
	addFile,
	readText,
} from "../__mocks__/sync-test-helpers";

describe("resolveConflict", () => {
	let localFs: MockFileSystem;
	let remoteFs: MockFileSystem;

	beforeEach(() => {
		localFs = createMockLocalFs();
		remoteFs = createMockRemoteFs();
	});

	describe("fresh rename preparation", () => {
		it("is read-only and records primary then additional obligations", async () => {
			const local = addFile(localFs, "new.md", "local", 2000);
			const source = addFile(remoteFs, "old.md", "R", 1100);
			source.identityKey = "R";
			const occupant = addFile(remoteFs, "new.md", "Y", 1200);
			occupant.identityKey = "Y";
			const writes = [vi.spyOn(localFs, "write"), vi.spyOn(remoteFs, "write")];
			const deletes = [vi.spyOn(localFs, "delete"), vi.spyOn(remoteFs, "delete")];
			const renames = [vi.spyOn(localFs, "rename"), vi.spyOn(remoteFs, "rename")];

			const prepared = await prepareConflict({
				path: "new.md", localPath: "new.md", remotePath: "old.md",
				remoteIdentitySource: source, additionalRemote: occupant,
				localFs, remoteFs, local, remote: source, freshRename: true,
			});

			expect(prepared.kind).toBe("prepared_rotation_required");
			expect(prepared.obligations).toEqual([
				{ role: "primary", sourcePath: "old.md", identityKey: "R" },
				{ role: "additional", sourcePath: "new.md", identityKey: "Y" },
			]);
			for (const mutation of [...writes, ...deletes, ...renames]) {
				expect(mutation).not.toHaveBeenCalled();
			}
		});

		it("classifies inconsistent second exact read as proof_mismatch", async () => {
			const source = addFile(remoteFs, "old.md", "first", 0);
			source.identityKey = "R";
			source.hash = "";
			source.remoteChecksum = undefined;
			const originalRead = remoteFs.read.bind(remoteFs);
			let reads = 0;
			vi.spyOn(remoteFs, "read").mockImplementation(async (path) => {
				const value = await originalRead(path);
				reads++;
				return reads === 2 ? new TextEncoder().encode("other").buffer : value;
			});

			await expect(prepareConflict({
				path: "new.md", remotePath: "old.md", remoteIdentitySource: source,
				localFs, remoteFs, remote: source, freshRename: true,
			})).rejects.toMatchObject({ kind: "proof_mismatch" });
			expect(reads).toBe(2);
		});

		it.each([
			[new Error("offline"), "external_io_failure"],
			[new AuthError("expired", 401), "external_auth_failure"],
		] as const)("classifies unreadable source as %s", async (failure, kind) => {
			const source = addFile(remoteFs, "old.md", "R", 1000);
			source.identityKey = "R";
			vi.spyOn(remoteFs, "read").mockRejectedValue(failure);

			await expect(prepareConflict({
				path: "new.md", remotePath: "old.md", remoteIdentitySource: source,
				localFs, remoteFs, remote: source, freshRename: true,
			})).rejects.toMatchObject({ kind });
		});
	});

	describe("duplicate strategy", () => {
		it("adapts different local, remote, and baseline paths while preserving remote content", async () => {
			const local = addFile(localFs, "new.md", "local current", 2000);
			const remote = addFile(remoteFs, "old.md", "remote changed", 1500);

			const result = await resolveConflict({
				path: "new.md", localPath: "new.md", remotePath: "old.md", baselinePath: "old.md",
				localFs, remoteFs, local, remote,
			}, "duplicate");

			expect(result).toMatchObject({ action: "duplicated", duplicatePath: "new.conflict.md" });
			expect(readText(localFs, "new.conflict.md")).toBe("remote changed");
			expect(readText(remoteFs, "new.conflict.md")).toBe("remote changed");
			expect(readText(remoteFs, "new.md")).toBe("local current");
			expect(readText(remoteFs, "old.md")).toBe("remote changed");
		});

		it("preserves primary R and additional Y without rotating either original", async () => {
			const local = addFile(localFs, "new.md", "local current", 2000);
			const remote = addFile(remoteFs, "new.md", "destination occupant", 1500);
			remote.identityKey = "Y";
			addFile(remoteFs, "old.md", "baseline changed source", 1000).identityKey = "R";
			const source = (await remoteFs.stat("old.md"))!;

			const result = await resolveConflict({
				path: "new.md", localPath: "new.md", remotePath: "old.md",
				remoteIdentitySource: source, additionalRemote: remote, baselinePath: "old.md",
				localFs, remoteFs, local, remote: source, freshRename: true,
			}, "duplicate");

			expect(result).toMatchObject({ action: "duplicated", duplicatePath: "new.conflict.md" });
			expect(result.verifiedOutputs).toEqual([
				{ role: "primary", path: "new.conflict.md", sourcePath: "old.md" },
				{ role: "additional", path: "new.conflict-2.md", sourcePath: "new.md" },
			]);
			expect(readText(remoteFs, "new.conflict.md")).toBe("baseline changed source");
			expect(readText(remoteFs, "new.conflict-2.md")).toBe("destination occupant");
			expect(readText(remoteFs, "new.md")).toBe("destination occupant");
			expect(readText(remoteFs, "old.md")).toBe("baseline changed source");
		});

		it("retains partial verified outputs and allocates higher numbers on retry", async () => {
			const local = addFile(localFs, "new.md", "local", 2000);
			const source = addFile(remoteFs, "old.md", "R", 1000);
			source.identityKey = "R";
			const occupant = addFile(remoteFs, "new.md", "Y", 1100);
			occupant.identityKey = "Y";
			const context = {
				path: "new.md", localPath: "new.md", remotePath: "old.md",
				remoteIdentitySource: source, additionalRemote: occupant,
				localFs, remoteFs, local, remote: source, freshRename: true,
			} as const;

			await resolveConflict(context, "duplicate");
			const retried = await resolveConflict(context, "duplicate");

			expect(retried.verifiedOutputs?.map(({ path }) => path)).toEqual([
				"new.conflict-3.md", "new.conflict-4.md",
			]);
			expect(readText(remoteFs, "new.conflict.md")).toBe("R");
			expect(readText(remoteFs, "new.conflict-2.md")).toBe("Y");
		});

		it("fails on preservation readback mismatch while leaving the written output", async () => {
			const local = addFile(localFs, "new.md", "local", 2000);
			const source = addFile(remoteFs, "old.md", "R", 1000);
			source.identityKey = "R";
			const originalRead = localFs.read.bind(localFs);
			vi.spyOn(localFs, "read").mockImplementation(async (path) =>
				path === "new.conflict.md"
					? new TextEncoder().encode("mismatch").buffer
					: originalRead(path));

			await expect(resolveConflict({
				path: "new.md", localPath: "new.md", remotePath: "old.md",
				remoteIdentitySource: source, localFs, remoteFs, local,
				remote: source, freshRename: true,
			}, "duplicate")).rejects.toMatchObject({ kind: "proof_mismatch" });
			expect(readText(remoteFs, "new.conflict.md")).toBe("R");
		});

		it("uses at most two reads to prove checksum-less zero-mtime source bytes", async () => {
			const local = addFile(localFs, "new.md", "local current", 2000);
			const sourceEntity = addFile(remoteFs, "old.md", "baseline stale source", 1000);
			sourceEntity.identityKey = "R";
			sourceEntity.hash = "";
			sourceEntity.remoteChecksum = undefined;
			sourceEntity.mtime = 0;
			const source = (await remoteFs.stat("old.md"))!;
			source.hash = "";
			const originalStat = remoteFs.stat.bind(remoteFs);
			vi.spyOn(remoteFs, "stat").mockImplementation(async (path) => {
				const entity = await originalStat(path);
				return entity ? { ...entity, hash: "", remoteChecksum: undefined, mtime: 0 } : null;
			});
			const read = vi.spyOn(remoteFs, "read");

			const prepared = await prepareConflict({
				path: "new.md", localPath: "new.md", remotePath: "old.md",
				remoteIdentitySource: source, baselinePath: "old.md",
				localFs, remoteFs, local, remote: source, freshRename: true,
			});

			expect(prepared.kind).toBe("prepared_rotation_required");
			expect(prepared.primary.witness).toEqual({
				kind: "exact_bytes", size: "baseline stale source".length,
			});
			expect(read).toHaveBeenCalledTimes(2);
		});

		it("bounds both checksum-less sources and blocks an unstable additional version", async () => {
			const local = addFile(localFs, "new.md", "local", 2000);
			const source = addFile(remoteFs, "old.md", "R", 0);
			source.identityKey = "R";
			const occupant = addFile(remoteFs, "new.md", "Y", 0);
			occupant.identityKey = "Y";
			for (const entity of [source, occupant]) {
				entity.hash = "";
				entity.remoteChecksum = undefined;
				entity.mtime = 0;
			}
			const originalStat = remoteFs.stat.bind(remoteFs);
			vi.spyOn(remoteFs, "stat").mockImplementation(async (path) => {
				const entity = await originalStat(path);
				return entity ? { ...entity, hash: "", remoteChecksum: undefined, mtime: 0 } : null;
			});
			const originalRead = remoteFs.read.bind(remoteFs);
			const reads = new Map<string, number>();
			vi.spyOn(remoteFs, "read").mockImplementation(async (path) => {
				const count = (reads.get(path) ?? 0) + 1;
				reads.set(path, count);
				if (path === "new.md" && count === 2) {
					return new TextEncoder().encode("Z").buffer;
				}
				return originalRead(path);
			});
			const writes = [vi.spyOn(localFs, "write"), vi.spyOn(remoteFs, "write")];

			await expect(prepareConflict({
				path: "new.md", localPath: "new.md", remotePath: "old.md",
				remoteIdentitySource: source, additionalRemote: occupant,
				localFs, remoteFs, local, remote: source, freshRename: true,
			})).rejects.toMatchObject({ kind: "proof_mismatch" });

			expect(reads.get("old.md")).toBe(2);
			expect(reads.get("new.md")).toBe(2);
			for (const write of writes) expect(write).not.toHaveBeenCalled();
		});

		it("creates a conflict copy when both files exist", async () => {
			const local = addFile(localFs, "file.md", "local content", 2000);
			const remote = addFile(remoteFs, "file.md", "remote content", 1000);

			const result = await resolveConflict(
				{ path: "file.md", localFs, remoteFs, local, remote },
				"duplicate",
			);

			expect(result.action).toBe("duplicated");
			expect(result.duplicatePath).toBe("file.conflict.md");
			expect(readText(remoteFs, "file.md")).toBe("local content");
			expect(readText(localFs, "file.conflict.md")).toBe(
				"remote content",
			);
		});

		it("restores remote version locally when local is deleted", async () => {
			const remote = addFile(remoteFs, "file.md", "remote only", 1000);

			const result = await resolveConflict(
				{ path: "file.md", localFs, remoteFs, remote },
				"duplicate",
			);

			expect(result.action).toBe("duplicated");
			expect(readText(localFs, "file.md")).toBe("remote only");
		});

		it("restores local version remotely when remote is deleted", async () => {
			const local = addFile(localFs, "file.md", "local only", 1000);

			const result = await resolveConflict(
				{ path: "file.md", localFs, remoteFs, local },
				"duplicate",
			);

			expect(result.action).toBe("duplicated");
			expect(readText(remoteFs, "file.md")).toBe("local only");
		});
	});

	describe("auto_merge strategy", () => {
		it("preserves exact primary R and additional Y before merging only the primary", async () => {
			const base = "one\ntwo\nthree\nfour\nfive\n";
			const localText = "one\nlocal\nthree\nfour\nfive\n";
			const remoteText = "one\ntwo\nthree\nfour\nremote\n";
			const local = addFile(localFs, "new.md", localText, 2000);
			const source = addFile(remoteFs, "old.md", remoteText, 1500);
			source.identityKey = "R";
			const occupant = addFile(remoteFs, "new.md", "foreign Y", 1400);
			occupant.identityKey = "Y";
			const stateStore = createMockStateStore();
			stateStore.contents.set("old.md", new TextEncoder().encode(base).buffer.slice(0));
			const baseline: SyncRecord = {
				path: "old.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: base.length, remoteSize: base.length,
				remoteIdentityKey: "R", syncedAt: 900,
			};

			const result = await resolveConflict({
				path: "new.md", localPath: "new.md", remotePath: "old.md", baselinePath: "old.md",
				remoteIdentitySource: source, additionalRemote: occupant,
				localFs, remoteFs, local, remote: source, baseline, stateStore, freshRename: true,
			}, "auto_merge");

			expect(result.action).toBe("merged");
			expect(result.verifiedOutputs).toEqual([
				{ role: "primary", path: "new.conflict.md", sourcePath: "old.md" },
				{ role: "additional", path: "new.conflict-2.md", sourcePath: "new.md" },
			]);
			expect(readText(remoteFs, "new.conflict.md")).toBe(remoteText);
			expect(readText(remoteFs, "new.conflict-2.md")).toBe("foreign Y");
			const target = new TextDecoder().decode(result.targetContent);
			expect(target).toContain("local");
			expect(target).toContain("remote");
		});

		it("reads base, local, and remote from rename-aware paths", async () => {
			const base = "one\ntwo\nthree\nfour\nfive\n";
			const localText = "one\nlocal\nthree\nfour\nfive\n";
			const remoteText = "one\ntwo\nthree\nfour\nremote\n";
			const local = addFile(localFs, "new.md", localText, 2000);
			const remote = addFile(remoteFs, "old.md", remoteText, 2000);
			const stateStore = createMockStateStore();
			stateStore.contents.set("old.md", new TextEncoder().encode(base).buffer.slice(0));
			const baseline: SyncRecord = {
				path: "old.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: base.length, remoteSize: base.length, syncedAt: 900,
			};

			const result = await resolveConflict({
				path: "new.md", localPath: "new.md", remotePath: "old.md", baselinePath: "old.md",
				localFs, remoteFs, local, remote, baseline, stateStore,
			}, "auto_merge");

			expect(result.action).toBe("merged");
			expect(readText(localFs, "new.md")).toContain("local");
			expect(readText(remoteFs, "new.md")).toContain("remote");
			expect(readText(remoteFs, "old.md")).toBe(remoteText);
		});

		it("performs 3-way merge when all prerequisites are met", async () => {
			const base = "line1\nline2\nline3\nline4\nline5\n";
			const localText = "line1\nlocal-change\nline3\nline4\nline5\n";
			const remoteText = "line1\nline2\nline3\nline4\nremote-change\n";

			addFile(localFs, "file.md", localText, 2000);
			addFile(remoteFs, "file.md", remoteText, 2000);

			const stateStore = createMockStateStore();
			stateStore.contents.set(
				"file.md",
				new TextEncoder().encode(base).buffer.slice(0),
			);

			const baseline: SyncRecord = {
				path: "file.md",
				hash: "",
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: base.length,
				remoteSize: base.length,
				syncedAt: 900,
			};

			const result = await resolveConflict(
				{
					path: "file.md",
					localFs,
					remoteFs,
					local: localFs.files.get("file.md")!.entity,
					remote: remoteFs.files.get("file.md")!.entity,
					baseline,
					stateStore,
				},
				"auto_merge",
			);

			expect(result.action).toBe("merged");
			expect(result.hasConflictMarkers).toBe(false);
		});

		it("reports conflict markers when both sides edit the same line", async () => {
			const base = "line1\noriginal\nline3\n";
			const localText = "line1\nlocal-edit\nline3\n";
			const remoteText = "line1\nremote-edit\nline3\n";

			addFile(localFs, "file.md", localText, 2000);
			addFile(remoteFs, "file.md", remoteText, 2000);

			const stateStore = createMockStateStore();
			stateStore.contents.set(
				"file.md",
				new TextEncoder().encode(base).buffer.slice(0),
			);

			const baseline: SyncRecord = {
				path: "file.md",
				hash: "",
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: base.length,
				remoteSize: base.length,
				syncedAt: 900,
			};

			const result = await resolveConflict(
				{
					path: "file.md",
					localFs,
					remoteFs,
					local: localFs.files.get("file.md")!.entity,
					remote: remoteFs.files.get("file.md")!.entity,
					baseline,
					stateStore,
				},
				"auto_merge",
			);

			expect(result.action).toBe("merged");
			expect(result.hasConflictMarkers).toBe(true);
		});

		it("falls back to newer-wins when baseline is missing", async () => {
			const local = addFile(localFs, "file.md", "local content", 2000);
			const remote = addFile(remoteFs, "file.md", "remote content", 1000);

			const result = await resolveConflict(
				{ path: "file.md", localFs, remoteFs, local, remote },
				"auto_merge",
			);

			// newer wins → local is newer
			expect(result.action).toBe("kept_local");
			expect(readText(remoteFs, "file.md")).toBe("local content");
		});

		it("falls back to newer-wins when stateStore is missing", async () => {
			const local = addFile(localFs, "file.md", "local content", 2000);
			const remote = addFile(remoteFs, "file.md", "remote content", 1000);

			const baseline: SyncRecord = {
				path: "file.md",
				hash: "",
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: 10,
				remoteSize: 10,
				syncedAt: 900,
			};

			const result = await resolveConflict(
				{ path: "file.md", localFs, remoteFs, local, remote, baseline },
				"auto_merge",
			);

			// Missing stateStore → fallback to newer-wins via auto_merge
			expect(result.action).toBe("kept_local");
		});

		it("falls back to newer-wins for binary files (not merge eligible)", async () => {
			const local = addFile(localFs, "image.png", "local-binary", 2000);
			const remote = addFile(
				remoteFs,
				"image.png",
				"remote-binary",
				1000,
			);

			const stateStore = createMockStateStore();
			stateStore.contents.set(
				"image.png",
				new TextEncoder().encode("base").buffer.slice(0),
			);

			const baseline: SyncRecord = {
				path: "image.png",
				hash: "",
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: 4,
				remoteSize: 4,
				syncedAt: 900,
			};

			const result = await resolveConflict(
				{
					path: "image.png",
					localFs,
					remoteFs,
					local,
					remote,
					baseline,
					stateStore,
				},
				"auto_merge",
			);

			// .png not eligible → newer wins → local is newer
			expect(result.action).toBe("kept_local");
		});

		it("falls back to duplicate when mtime is equal and hashes differ", async () => {
			const local = addFile(localFs, "file.md", "local ver", 1000);
			local.hash = "aaa";
			const remote = addFile(remoteFs, "file.md", "remote ver", 1000);
			remote.hash = "bbb";

			// No stateStore → skips 3-way merge path → newer-wins
			const result = await resolveConflict(
				{ path: "file.md", localFs, remoteFs, local, remote },
				"auto_merge",
			);

			expect(result.action).toBe("duplicated");
		});

		it("falls back to newer-wins when base content is unavailable in store", async () => {
			const local = addFile(localFs, "file.md", "local content", 2000);
			const remote = addFile(remoteFs, "file.md", "remote content", 1000);

			const stateStore = createMockStateStore();
			// No content stored for this path

			const baseline: SyncRecord = {
				path: "file.md",
				hash: "",
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: 10,
				remoteSize: 10,
				syncedAt: 900,
			};

			const result = await resolveConflict(
				{
					path: "file.md",
					localFs,
					remoteFs,
					local,
					remote,
					baseline,
					stateStore,
				},
				"auto_merge",
			);

			// stateStore has no content → falls back to newer-wins → local is newer
			expect(result.action).toBe("kept_local");
		});
	});
});
