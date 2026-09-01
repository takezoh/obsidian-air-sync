import { describe, expect, it, vi } from "vitest";
import { OneDriveFs } from "./index";
import type { OneDriveClient } from "./client";
import { GraphApiError, type OneDriveItem } from "./types";

function item(overrides: Partial<OneDriveItem> = {}): OneDriveItem {
	return { id: "file-1", name: "note.md", parentReference: { id: "root" }, size: 3,
		cTag: "c2", eTag: "e2", file: { hashes: { quickXorHash: "qx" } },
		fileSystemInfo: { lastModifiedDateTime: "2026-08-27T00:00:00Z" }, ...overrides };
}

describe("OneDriveFs detached priority observation", () => {
	it("uses cTag and detects a version change across the id-bound read", async () => {
		const getItem = vi.fn().mockResolvedValueOnce(item({ cTag: "c2" })).mockResolvedValueOnce(item({ cTag: "c3" }));
		const getChildByName = vi.fn().mockResolvedValueOnce(item({ cTag: "c2" })).mockResolvedValueOnce(item({ cTag: "c3" }));
		const fs = new OneDriveFs({ getItem, getChildByName, download: vi.fn(() => Promise.resolve(new ArrayBuffer(3))) } as unknown as OneDriveClient, "root");
		const observed = await fs.priority.observe({ path: "note.md", identityKey: "file-1" });
		expect(observed).toMatchObject({ kind: "current", token: "onedrive:c2" });
		if (observed.kind !== "current") throw new Error("expected current");
		expect(await fs.priority.read(observed)).toEqual({ kind: "target_changed" });
	});

	it("fails closed for replacement and absence", async () => {
		const replacement = item({ id: "file-2", cTag: "c3" });
		const replaced = new OneDriveFs({ getItem: vi.fn(() => Promise.resolve(replacement)),
			getChildByName: vi.fn(() => Promise.resolve(replacement)) } as unknown as OneDriveClient, "root");
		expect(await replaced.priority.observe({ path: "note.md", identityKey: "file-1" })).toMatchObject({
			kind: "structural", occupant: { identityKey: "file-2" },
		});
		const missing = () => Promise.reject(new GraphApiError("gone", 404, "itemNotFound"));
		const absent = new OneDriveFs({ getItem: vi.fn(missing), getChildByName: vi.fn(missing) } as unknown as OneDriveClient, "root");
		expect(await absent.priority.observe({ path: "note.md", identityKey: "file-1" }))
			.toEqual({ kind: "missing", occupant: { kind: "absent" } });
	});
});
