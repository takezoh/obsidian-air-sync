import { describe, expect, it, vi } from "vitest";
import { GoogleDriveFs } from "./index";
import type { GoogleDriveClient } from "./client";
import type { GoogleDriveFile } from "./types";

function file(overrides: Partial<GoogleDriveFile> = {}): GoogleDriveFile {
	return {
		id: "file-1", name: "note.md", mimeType: "application/octet-stream",
		parents: ["root"], size: "3", modifiedTime: "2026-08-27T00:00:00Z",
		md5Checksum: "abc", version: "2", ...overrides,
	};
}

describe("GoogleDriveFs detached priority observation", () => {
	it("observes and reads by stable id without consuming list/change state", async () => {
		const current = file();
		const getFile = vi.fn(() => Promise.resolve(current));
		const listChildrenByName = vi.fn(() => Promise.resolve([current]));
		const downloadFile = vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]).buffer));
		const client = { getFile, listChildrenByName, downloadFile } as unknown as GoogleDriveClient;
		const fs = new GoogleDriveFs(client, "root");

		const observed = await fs.priority.observe({ path: "note.md", identityKey: "file-1" });
		expect(observed).toMatchObject({ kind: "current", token: "googledrive:2" });
		if (observed.kind !== "current") throw new Error("expected current");
		expect(await fs.priority.read(observed)).toMatchObject({ kind: "content" });
		expect(downloadFile).toHaveBeenCalledWith("file-1");
		expect(getFile).toHaveBeenCalledTimes(2);
	});

	it("fails closed when numeric version evidence is absent", async () => {
		const client = { getFile: vi.fn(() => Promise.resolve(file({ version: undefined }))) } as unknown as GoogleDriveClient;
		client.listChildrenByName = vi.fn(() => Promise.resolve([file({ version: undefined })]));
		const fs = new GoogleDriveFs(client, "root");
		expect((await fs.priority.observe({ path: "note.md", identityKey: "file-1" })).kind)
			.toBe("unverifiable");
	});

	it("reports a replacement when the admitted identity is gone but the path is occupied", async () => {
		const replacement = file({ id: "file-2", version: "3" });
		const client = {
			getFile: vi.fn(() => Promise.reject(Object.assign(new Error("gone"), { status: 404 }))),
			listChildrenByName: vi.fn(() => Promise.resolve([replacement])),
		} as unknown as GoogleDriveClient;
		const fs = new GoogleDriveFs(client, "root");

		const observed = await fs.priority.observe({ path: "note.md", identityKey: "file-1" });

		expect(observed).toMatchObject({
			kind: "structural",
			occupant: { kind: "current", identityKey: "file-2", token: "googledrive:3" },
		});
	});

	it("fails closed when complete pagination finds duplicate path occupants", async () => {
		const admitted = file({ id: "file-1" });
		const duplicate = file({ id: "file-2", version: "3" });
		const client = {
			getFile: vi.fn(() => Promise.resolve(admitted)),
			listChildrenByName: vi.fn(() => Promise.resolve([admitted, duplicate])),
		} as unknown as GoogleDriveClient;
		const fs = new GoogleDriveFs(client, "root");

		const observed = await fs.priority.observe({ path: "note.md", identityKey: "file-1" });

		expect(observed).toEqual({
			kind: "unverifiable",
			occupant: { kind: "conflicting", identityKeys: ["file-1", "file-2"] },
		});
	});
});
