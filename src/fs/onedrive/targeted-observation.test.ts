import { describe, expect, it, vi } from "vitest";
import { OneDriveFs } from "./index";
import type { OneDriveClient } from "./client";
import { GraphApiError, type OneDriveItem } from "./types";

function item(overrides: Partial<OneDriveItem> = {}): OneDriveItem {
	return {
		id: "file-1", name: "note.md", parentReference: { id: "root" },
		size: 3, cTag: "c2", eTag: "e2", file: { hashes: { quickXorHash: "qx" } },
		fileSystemInfo: { lastModifiedDateTime: "2026-08-27T00:00:00Z" }, ...overrides,
	};
}

describe("OneDriveFs detached priority observation", () => {
	it("uses cTag and reobserves after the id-bound read", async () => {
		const getItem = vi.fn(() => Promise.resolve(item()));
		const getChildByName = vi.fn(() => Promise.resolve(item()));
		const download = vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]).buffer));
		const fs = new OneDriveFs({ getItem, getChildByName, download } as unknown as OneDriveClient, "root");
		const observed = await fs.priority.observe({ path: "note.md", identityKey: "file-1" });
		expect(observed).toMatchObject({ kind: "current", token: "onedrive:c2" });
		if (observed.kind !== "current") throw new Error("expected current");
		expect(await fs.priority.read(observed)).toMatchObject({ kind: "content" });
		expect(getItem).toHaveBeenCalledTimes(2);
	});

	it("reports target_changed when the opaque token changes across the read", async () => {
		const getItem = vi.fn()
			.mockResolvedValueOnce(item({ cTag: "c2" }))
			.mockResolvedValueOnce(item({ cTag: "c3" }));
		const getChildByName = vi.fn()
			.mockResolvedValueOnce(item({ cTag: "c2" }))
			.mockResolvedValueOnce(item({ cTag: "c3" }));
		const fs = new OneDriveFs({
			getItem, getChildByName,
			download: vi.fn(() => Promise.resolve(new ArrayBuffer(3))),
		} as unknown as OneDriveClient, "root");
		const observed = await fs.priority.observe({ path: "note.md", identityKey: "file-1" });
		if (observed.kind !== "current") throw new Error("expected current");
		expect(await fs.priority.read(observed)).toEqual({ kind: "target_changed" });
	});

	it("distinguishes a path replacement from authoritative absence", async () => {
		const replacement = item({ id: "file-2", cTag: "c3" });
		const fs = new OneDriveFs({
			getItem: vi.fn(() => Promise.resolve(replacement)),
			getChildByName: vi.fn(() => Promise.resolve(replacement)),
		} as unknown as OneDriveClient, "root");

		expect(await fs.priority.observe({ path: "note.md", identityKey: "file-1" }))
			.toMatchObject({ kind: "structural", occupant: { kind: "current", identityKey: "file-2" } });
	});

	it("reports authoritative absence when both identity and path are gone", async () => {
		const missing = () => Promise.reject(new GraphApiError("gone", 404, "itemNotFound"));
		const fs = new OneDriveFs({
			getItem: vi.fn(missing), getChildByName: vi.fn(missing),
		} as unknown as OneDriveClient, "root");

		expect(await fs.priority.observe({ path: "note.md", identityKey: "file-1" }))
			.toEqual({ kind: "missing", occupant: { kind: "absent" } });
	});
});
