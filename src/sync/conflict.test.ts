import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveWithStrategy, generateConflictPath } from "./conflict";
import {
	createMockFs,
	createMockStateStore,
	addFile,
	readText,
} from "../__mocks__/sync-test-helpers";
import type { SyncRecord } from "./types";

function encode(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer.slice(0);
}

describe("resolveWithStrategy", () => {
	let localFs: ReturnType<typeof createMockFs>;
	let remoteFs: ReturnType<typeof createMockFs>;

	beforeEach(() => {
		localFs = createMockFs("local");
		remoteFs = createMockFs("remote");
	});

	describe("keep_newer", () => {
		it("keeps the remote version when its mtime is newer", async () => {
			const local = addFile(localFs, "f.md", "older local", 1000);
			const remote = addFile(remoteFs, "f.md", "newer remote", 2000);

			const r = await resolveWithStrategy(
				{ path: "f.md", localFs, remoteFs, local, remote },
				"keep_newer",
			);

			expect(r.action).toBe("kept_remote");
			expect(readText(localFs, "f.md")).toBe("newer remote");
		});

		it("keeps local when mtime ties and content is identical", async () => {
			const local = addFile(localFs, "f.md", "same", 1500);
			local.hash = "H";
			const remote = addFile(remoteFs, "f.md", "same", 1500);
			remote.hash = "H";

			const r = await resolveWithStrategy(
				{ path: "f.md", localFs, remoteFs, local, remote },
				"keep_newer",
			);

			expect(r.action).toBe("kept_local");
		});

		it("duplicates when mtime ties but content differs", async () => {
			const local = addFile(localFs, "f.md", "local body", 1500);
			local.hash = "A";
			const remote = addFile(remoteFs, "f.md", "remote body", 1500);
			remote.hash = "B";

			const r = await resolveWithStrategy(
				{ path: "f.md", localFs, remoteFs, local, remote },
				"keep_newer",
			);

			expect(r.action).toBe("duplicated");
		});

		it("treats both-sides-deleted as a no-op", async () => {
			const r = await resolveWithStrategy(
				{ path: "f.md", localFs, remoteFs },
				"keep_newer",
			);

			expect(r.action).toBe("kept_local");
		});
	});

	describe("auto_merge — crash-safe rollback", () => {
		it("restores the pre-merge local file and rethrows when the remote write fails", async () => {
			// Non-overlapping edits → a clean merge that writes to both sides.
			const base = "l1\nl2\nl3\n";
			const localText = "l1\nLOCAL\nl3\n";
			const remoteText = "l1\nl2\nREMOTE\n";
			const local = addFile(localFs, "f.md", localText, 2000);
			const remote = addFile(remoteFs, "f.md", remoteText, 2000);
			const stateStore = createMockStateStore();
			stateStore.contents.set("f.md", encode(base));
			const baseline: SyncRecord = {
				path: "f.md",
				hash: "",
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: base.length,
				remoteSize: base.length,
				syncedAt: 900,
			};
			// The merged content reaches local first, then the remote write blows up.
			vi.spyOn(remoteFs, "write").mockRejectedValueOnce(
				new Error("remote unavailable"),
			);

			await expect(
				resolveWithStrategy(
					{
						path: "f.md",
						localFs,
						remoteFs,
						local,
						remote,
						prevSync: baseline,
						stateStore,
					},
					"auto_merge",
				),
			).rejects.toThrow("remote unavailable");

			// Local must be rolled back to its original content — never left holding a
			// merge that was never committed remotely (the two sides must not diverge).
			expect(readText(localFs, "f.md")).toBe(localText);
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
			return resolveWithStrategy(
				{
					path: "data.json",
					localFs,
					remoteFs,
					local,
					remote,
					prevSync: baseline(base),
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
			expect(readText(localFs, "data.json")).toBe(
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
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		expect(
			await generateConflictPath("notes/file.md", localFs, remoteFs),
		).toBe("notes/file.conflict.md");
	});

	it("numbers sequentially when the conflict path is occupied on any side", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		addFile(remoteFs, "notes/file.conflict.md", "already here");
		expect(
			await generateConflictPath("notes/file.md", localFs, remoteFs),
		).toBe("notes/file.conflict-2.md");
	});
});
