import { describe, it, expect, beforeEach } from "vitest";
import { generateConflictPath } from "./conflict";
import { resolveConflict } from "./conflict-resolver";
import {
	createMockLocalFs, createMockRemoteFs, type MockFileSystem,
	createMockStateStore,
	addFile,
	readText,
} from "../__mocks__/sync-test-helpers";
import type { SyncRecord } from "./types";

function encode(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer.slice(0);
}

describe("resolveConflict", () => {
	let localFs: MockFileSystem;
	let remoteFs: MockFileSystem;

	beforeEach(() => {
		localFs = createMockLocalFs();
		remoteFs = createMockRemoteFs();
	});

	describe("auto_merge", () => {
		it("keeps the remote version when its mtime is newer", async () => {
			const local = addFile(localFs, "f.md", "older local", 1000);
			const remote = addFile(remoteFs, "f.md", "newer remote", 2000);

			const r = await resolveConflict(
				{ path: "f.md", localFs, remoteFs, local, remote },
				"auto_merge",
			);

			expect(r.action).toBe("kept_remote");
			expect(new TextDecoder().decode(r.targetContent)).toBe("newer remote");
			expect(readText(localFs, "f.md")).toBe("older local");
		});

		it("keeps local when mtime ties and content is identical", async () => {
			const local = addFile(localFs, "f.md", "same", 1500);
			const remote = addFile(remoteFs, "f.md", "same", 1500);

			const r = await resolveConflict(
				{ path: "f.md", localFs, remoteFs, local, remote },
				"auto_merge",
			);

			expect(r.action).toBe("kept_local");
		});

		it("duplicates when mtime ties but content differs", async () => {
			const local = addFile(localFs, "f.md", "local body", 1500);
			const remote = addFile(remoteFs, "f.md", "remote body", 1500);

			const r = await resolveConflict(
				{ path: "f.md", localFs, remoteFs, local, remote },
				"auto_merge",
			);

			expect(r.action).toBe("duplicated");
		});

		it("treats both-sides-deleted as a no-op", async () => {
			const r = await resolveConflict(
				{ path: "f.md", localFs, remoteFs },
				"auto_merge",
			);

			expect(r.action).toBe("kept_local");
		});
	});

	describe("auto_merge — JSON integrity guard", () => {
		const baseline = (content: string): SyncRecord => ({
			path: "data.json",
			hash: "",
			localMtime: 1000,
			remoteMtime: 1000,
			localSize: content.length,
			remoteSize: content.length,
			syncedAt: 900,
		});

		async function mergeJson(
			base: string,
			localText: string,
			remoteText: string,
		) {
			const local = addFile(localFs, "data.json", localText, 2000);
			const remote = addFile(remoteFs, "data.json", remoteText, 2000);
			const stateStore = createMockStateStore();
			stateStore.contents.set("data.json", encode(base));
			return resolveConflict(
				{
					path: "data.json",
					localFs,
					remoteFs,
					local,
					remote,
					baseline: baseline(base),
					stateStore,
				},
				"auto_merge",
			);
		}

		it("writes a clean merge when the result is still valid JSON", async () => {
			const r = await mergeJson(
				'{\n"a": 1,\n"b": 2\n}',
				'{\n"a": 99,\n"b": 2\n}',
				'{\n"a": 1,\n"b": 200\n}',
			);
			expect(r.action).toBe("merged");
			expect(r.hasConflictMarkers).toBe(false);
			expect(new TextDecoder().decode(r.targetContent)).toBe(
				'{\n"a": 99,\n"b": 200\n}',
			);
		});

		it("falls back to duplicate when a clean merge produces invalid JSON", async () => {
			// Non-overlapping edits, no conflict markers — but the merged text has a
			// trailing comma, so it is not valid JSON and must NOT be written.
			const r = await mergeJson(
				'{\n"a": 1,\n"b": 2\n}',
				'{\n"a": 99,\n"b": 2\n}',
				'{\n"a": 1,\n"b": 200,\n}',
			);
			expect(r.action).toBe("duplicated");
		});

		it("falls back to duplicate when JSON edits conflict on the same line", async () => {
			const r = await mergeJson(
				'{\n"a": 1\n}',
				'{\n"a": 2\n}',
				'{\n"a": 3\n}',
			);
			expect(r.action).toBe("duplicated");
		});
	});
});

describe("generateConflictPath", () => {
	it("returns the .conflict path when it is free", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs();
		expect(
			await generateConflictPath("notes/file.md", localFs, remoteFs),
		).toBe("notes/file.conflict.md");
	});

	it("numbers sequentially when the conflict path is occupied on any side", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs();
		addFile(remoteFs, "notes/file.conflict.md", "already here");
		expect(
			await generateConflictPath("notes/file.md", localFs, remoteFs),
		).toBe("notes/file.conflict-2.md");
	});
});
