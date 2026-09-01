import { describe, expect, it, vi } from "vitest";
import { GoogleDriveFs } from "./index";
import type { GoogleDriveClient } from "./client";
import type { GoogleDriveFile } from "./types";

function file(overrides: Partial<GoogleDriveFile> = {}): GoogleDriveFile {
	return { id: "file-1", name: "note.md", mimeType: "application/octet-stream", parents: ["root"],
		size: "3", modifiedTime: "2026-08-27T00:00:00Z", md5Checksum: "abc", version: "2", ...overrides };
}

describe("GoogleDriveFs detached priority observation", () => {
	it("observes and reads by stable id without consuming list/change state", async () => {
		const current = file();
		const getFile = vi.fn(() => Promise.resolve(current));
		const listChildrenByName = vi.fn(() => Promise.resolve([current]));
		const downloadFile = vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]).buffer));
		const fs = new GoogleDriveFs({ getFile, listChildrenByName, downloadFile } as unknown as GoogleDriveClient, "root");
		const observed = await fs.priority.observe({ path: "note.md", identityKey: "file-1" });
		expect(observed).toMatchObject({ kind: "current", token: "googledrive:2" });
		if (observed.kind !== "current") throw new Error("expected current");
		expect(await fs.priority.read(observed)).toMatchObject({ kind: "content" });
		expect(downloadFile).toHaveBeenCalledWith("file-1");
	});

	it("fails closed for absent version evidence, path replacement, and duplicate occupants", async () => {
		const incomplete = new GoogleDriveFs({
			getFile: vi.fn(() => Promise.resolve(file({ version: undefined }))),
			listChildrenByName: vi.fn(() => Promise.resolve([file({ version: undefined })])),
		} as unknown as GoogleDriveClient, "root");
		expect((await incomplete.priority.observe({ path: "note.md", identityKey: "file-1" })).kind).toBe("unverifiable");
		const replacement = file({ id: "file-2", version: "3" });
		const replaced = new GoogleDriveFs({
			getFile: vi.fn(() => Promise.reject(Object.assign(new Error("gone"), { status: 404 }))),
			listChildrenByName: vi.fn(() => Promise.resolve([replacement])),
		} as unknown as GoogleDriveClient, "root");
		expect(await replaced.priority.observe({ path: "note.md", identityKey: "file-1" })).toMatchObject({
			kind: "structural", occupant: { kind: "current", identityKey: "file-2" },
		});
		const duplicate = new GoogleDriveFs({
			getFile: vi.fn(() => Promise.resolve(file())),
			listChildrenByName: vi.fn(() => Promise.resolve([file(), replacement])),
		} as unknown as GoogleDriveClient, "root");
		expect(await duplicate.priority.observe({ path: "note.md", identityKey: "file-1" })).toMatchObject({
			kind: "unverifiable", occupant: { kind: "conflicting" },
		});
	});
});
