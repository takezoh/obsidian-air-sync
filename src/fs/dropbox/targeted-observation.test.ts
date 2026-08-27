import { describe, expect, it, vi } from "vitest";
import { DropboxFs } from "./index";
import type { DropboxClient } from "./client";
import type { DropboxEntry } from "./types";

function entry(overrides: Partial<DropboxEntry> = {}): DropboxEntry {
	return {
		".tag": "file", id: "id:file", name: "note.md",
		path_lower: "/renamed-vault/note.md", path_display: "/Renamed Vault/note.md",
		rev: "r2", size: 3, content_hash: "hash", server_modified: "2026-08-27T00:00:00Z",
		...overrides,
	};
}

describe("DropboxFs detached priority observation", () => {
	it("uses a request-local current root path and never updates the shared root anchor", async () => {
		const target = entry();
		const root = entry({ ".tag": "folder", id: "id:root", name: "Renamed Vault", path_lower: "/renamed-vault", path_display: "/Renamed Vault", rev: undefined, content_hash: undefined, size: undefined });
		const getMetadata = vi.fn((id: string) => Promise.resolve(id === "id:root" ? root : target));
		const client = {
			getMetadata,
			download: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]).buffer)),
		} as unknown as DropboxClient;
		const fs = new DropboxFs(client, "id:root");

		const observed = await fs.priority.observe({ path: "note.md", identityKey: "id:file" });
		expect(observed).toMatchObject({ kind: "current", token: "dropbox:r2" });
		expect(getMetadata).toHaveBeenNthCalledWith(1, "id:file");
		expect(getMetadata).toHaveBeenNthCalledWith(2, "id:root/note.md");
		expect(getMetadata).toHaveBeenNthCalledWith(3, "id:root");
	});

	it("fails closed when rev/content evidence is incomplete", async () => {
		const target = entry({ rev: undefined });
		const root = entry({ ".tag": "folder", id: "id:root", path_display: "/Renamed Vault" });
		const client = { getMetadata: vi.fn((id: string) => Promise.resolve(id === "id:root" ? root : target)) } as unknown as DropboxClient;
		const fs = new DropboxFs(client, "id:root");
		expect((await fs.priority.observe({ path: "note.md", identityKey: "id:file" })).kind)
			.toBe("unverifiable");
	});

	it("distinguishes a path replacement from authoritative absence", async () => {
		const replacement = entry({ id: "id:replacement", rev: "r3" });
		const root = entry({ ".tag": "folder", id: "id:root", path_display: "/Renamed Vault" });
		const client = {
			getMetadata: vi.fn((id: string) => Promise.resolve(id === "id:root" ? root : replacement)),
		} as unknown as DropboxClient;
		const fs = new DropboxFs(client, "id:root");

		expect(await fs.priority.observe({ path: "note.md", identityKey: "id:file" }))
			.toMatchObject({ kind: "structural", occupant: { kind: "current", identityKey: "id:replacement" } });
	});
});
