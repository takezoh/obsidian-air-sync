import { describe, it, expect, vi } from "vitest";
import { listAllFiles } from "./list-all";
import type { GoogleDriveFileList } from "./types";

const FOLDER = "application/vnd.google-apps.folder";
const instantSleep = () => Promise.resolve();

/** Build a GoogleDriveFileList from a minimal file spec (test double). */
function fileList(files: Array<{ id: string; name: string; mimeType: string }>): GoogleDriveFileList {
	return { files: files.map((f) => ({ ...f, parents: ["root"] })) };
}

describe("listAllFiles (adaptive full-scan listing)", () => {
	it("retries then propagates a persistent rate-limit (429) from a folder fetch", async () => {
		let f2Calls = 0;
		const listFiles = vi.fn((folderId: string): Promise<GoogleDriveFileList> => {
			if (folderId === "root") {
				return Promise.resolve(fileList([
					{ id: "f1", name: "ok", mimeType: FOLDER },
					{ id: "f2", name: "bad", mimeType: FOLDER },
				]));
			}
			if (folderId === "f2") {
				f2Calls++;
				return Promise.reject(Object.assign(new Error("Rate limited"), { status: 429 }));
			}
			return Promise.resolve(fileList([]));
		});

		await expect(listAllFiles(listFiles, "root", { sleepFn: instantSleep })).rejects.toThrow();
		// A persistent rate-limit is retried up to MAX_LIST_RETRIES (3) then propagates.
		expect(f2Calls).toBe(3);
	});

	it("retries a rate-limited page then succeeds", async () => {
		let f1Calls = 0;
		const listFiles = vi.fn((folderId: string): Promise<GoogleDriveFileList> => {
			if (folderId === "root") {
				return Promise.resolve(fileList([{ id: "f1", name: "folder1", mimeType: FOLDER }]));
			}
			if (folderId === "f1") {
				f1Calls++;
				if (f1Calls === 1) {
					return Promise.reject(Object.assign(new Error("Rate limited"), { status: 429 }));
				}
				return Promise.resolve(fileList([{ id: "a", name: "a.txt", mimeType: "text/plain" }]));
			}
			return Promise.resolve(fileList([]));
		});

		const result = await listAllFiles(listFiles, "root", { sleepFn: instantSleep });
		expect(result.map((f) => f.name)).toEqual(expect.arrayContaining(["folder1", "a.txt"]));
		expect(f1Calls).toBe(2); // 429 once, then retried successfully
	});

	it("rejects (and attempts every folder) when multiple sibling folders fail", async () => {
		const listFiles = vi.fn((folderId: string): Promise<GoogleDriveFileList> => {
			if (folderId === "root") {
				return Promise.resolve(fileList([
					{ id: "f1", name: "a", mimeType: FOLDER },
					{ id: "f2", name: "b", mimeType: FOLDER },
				]));
			}
			// Both subfolders fail persistently (permission ⇒ not retried).
			return Promise.reject(Object.assign(new Error("Forbidden"), { status: 403 }));
		});

		await expect(listAllFiles(listFiles, "root", { sleepFn: instantSleep })).rejects.toThrow();
		// root + both children attempted; the drain settles every task before rethrowing
		// (no sibling left with an unhandled rejection).
		expect(listFiles).toHaveBeenCalledTimes(3);
	});

	// A repeat reaching MetadataCache.bulkLoad() fails the whole scan on its
	// one-id-one-path guard, so the walk has to collapse repeats itself.
	describe("repeated ids", () => {
		it("collapses a file returned by two in-scope parents, keeping the last", async () => {
			const listFiles = vi.fn((folderId: string): Promise<GoogleDriveFileList> => {
				if (folderId === "root") {
					return Promise.resolve(fileList([
						{ id: "a", name: "A", mimeType: FOLDER },
						{ id: "b", name: "B", mimeType: FOLDER },
					]));
				}
				// One file parented under BOTH A and B — each listing returns it.
				return Promise.resolve({
					files: [{ id: "shared", name: `via-${folderId}.md`, mimeType: "text/markdown", parents: ["a", "b"] }],
				});
			});

			const files = await listAllFiles(listFiles, "root", { sleepFn: instantSleep });

			expect(files.map((f) => f.id)).toEqual(["a", "b", "shared"]);
			expect(files.find((f) => f.id === "shared")?.name).toBe("via-b.md");
		});

		it("collapses a repeat across pages of one folder, keeping the last", async () => {
			const listFiles = vi.fn((folderId: string, pageToken?: string): Promise<GoogleDriveFileList> => {
				if (folderId !== "root") return Promise.resolve(fileList([]));
				if (pageToken === "p2") {
					return Promise.resolve({
						files: [{ id: "dup", name: "renamed.md", mimeType: "text/markdown", parents: ["root"] }],
					});
				}
				return Promise.resolve({
					files: [
						{ id: "dup", name: "original.md", mimeType: "text/markdown", parents: ["root"] },
						{ id: "other", name: "other.md", mimeType: "text/markdown", parents: ["root"] },
					],
					nextPageToken: "p2",
				});
			});

			const files = await listAllFiles(listFiles, "root", { sleepFn: instantSleep });

			expect(files.map((f) => f.id)).toEqual(["dup", "other"]);
			expect(files.find((f) => f.id === "dup")?.name).toBe("renamed.md");
		});

		it("walks a folder reachable from two parents exactly once", async () => {
			const listFiles = vi.fn((folderId: string): Promise<GoogleDriveFileList> => {
				if (folderId === "root") {
					return Promise.resolve(fileList([
						{ id: "a", name: "A", mimeType: FOLDER },
						{ id: "b", name: "B", mimeType: FOLDER },
					]));
				}
				if (folderId === "a" || folderId === "b") {
					// The same subfolder is a child of both A and B.
					return Promise.resolve({
						files: [{ id: "shared-dir", name: "Shared", mimeType: FOLDER, parents: ["a", "b"] }],
					});
				}
				return Promise.resolve({
					files: [{ id: "leaf", name: "leaf.md", mimeType: "text/markdown", parents: ["shared-dir"] }],
				});
			});

			const files = await listAllFiles(listFiles, "root", { sleepFn: instantSleep });

			expect(files.map((f) => f.id)).toEqual(["a", "b", "shared-dir", "leaf"]);
			// root, a, b, shared-dir — the shared subtree is NOT walked twice.
			expect(listFiles).toHaveBeenCalledTimes(4);
		});

		it("terminates on a parent cycle instead of enqueueing forever", async () => {
			// Drive rejects moving a folder into its own descendant, so a cycle should be
			// impossible — but nothing here depends on that. The fuse makes a regression
			// fail fast: without the visited-set this walk never terminates, and a test
			// that hangs takes the worker down instead of reporting.
			let calls = 0;
			const listFiles = vi.fn((folderId: string): Promise<GoogleDriveFileList> => {
				if (++calls > 10) return Promise.reject(new Error("walk did not terminate"));
				if (folderId === "root") {
					return Promise.resolve(fileList([{ id: "x", name: "X", mimeType: FOLDER }]));
				}
				// X contains Y, Y contains X again.
				const child = folderId === "x" ? { id: "y", name: "Y" } : { id: "x", name: "X" };
				return Promise.resolve({ files: [{ ...child, mimeType: FOLDER, parents: [folderId] }] });
			});

			const files = await listAllFiles(listFiles, "root", { sleepFn: instantSleep });

			expect(files.map((f) => f.id).sort()).toEqual(["x", "y"]);
			expect(calls).toBe(3); // root, x, y
		});

		// The case where keying by id is load-bearing for ordering: a folder is seen
		// again AFTER its own child was already recorded. Re-keying (delete+set) would
		// move it behind its child, and `applyIncrementalChanges` would then resolve
		// the child against an unplaced parent and drop it (incremental-sync.ts:70-74).
		it("keeps a re-seen folder ahead of the child recorded before it", async () => {
			const listFiles = vi.fn(async (folderId: string): Promise<GoogleDriveFileList> => {
				if (folderId === "root") {
					return fileList([
						{ id: "a", name: "A", mimeType: FOLDER },
						{ id: "b", name: "B", mimeType: FOLDER },
					]);
				}
				if (folderId === "b") {
					// Defer past A's walk so B re-reports the shared folder only after
					// that folder's own child has already been recorded.
					await new Promise((resolve) => setTimeout(resolve, 0));
					return { files: [{ id: "f", name: "via-b", mimeType: FOLDER, parents: ["a", "b"] }] };
				}
				if (folderId === "a") {
					return { files: [{ id: "f", name: "via-a", mimeType: FOLDER, parents: ["a", "b"] }] };
				}
				return { files: [{ id: "leaf", name: "leaf.md", mimeType: "text/markdown", parents: ["f"] }] };
			});

			const files = await listAllFiles(listFiles, "root", { sleepFn: instantSleep });

			expect(files.map((f) => f.id)).toEqual(["a", "b", "f", "leaf"]);
			expect(files.find((f) => f.id === "f")?.name).toBe("via-b");
		});
	});
});
