import { describe, it, expect, vi } from "vitest";
import { listAllFiles } from "./list-all";
import type { GoogleDriveFileList } from "./types";

const FOLDER = "application/vnd.google-apps.folder";
const instantSleep = () => Promise.resolve();

/** Build a GoogleDriveFileList from a minimal file spec (test double). */
function fileList(files: Array<{ id: string; name: string; mimeType: string }>): GoogleDriveFileList {
	return { files: files.map((f) => ({ ...f, parents: ["root"] })) } as unknown as GoogleDriveFileList;
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

		await expect(listAllFiles(listFiles, "root", instantSleep)).rejects.toThrow();
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

		const result = await listAllFiles(listFiles, "root", instantSleep);
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

		await expect(listAllFiles(listFiles, "root", instantSleep)).rejects.toThrow();
		// root + both children attempted; the drain settles every task before rethrowing
		// (no sibling left with an unhandled rejection).
		expect(listFiles).toHaveBeenCalledTimes(3);
	});
});
