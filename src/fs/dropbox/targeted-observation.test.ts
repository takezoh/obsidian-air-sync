import { describe, expect, it, vi } from "vitest";
import { DropboxFs } from "./index";
import type { DropboxClient } from "./client";
import { DropboxApiError, type DropboxEntry } from "./types";

function entry(overrides: Partial<DropboxEntry> = {}): DropboxEntry {
	return { ".tag": "file", id: "id:file", name: "note.md", path_lower: "/vault/note.md",
		path_display: "/Vault/note.md", rev: "r2", size: 3, content_hash: "hash",
		server_modified: "2026-08-27T00:00:00Z", ...overrides };
}

describe("DropboxFs detached priority observation", () => {
	it("uses a request-local root lookup and revalidates an id-bound read", async () => {
		let rev = "r2";
		const root = entry({ ".tag": "folder", id: "id:root", name: "Vault", path_display: "/Vault",
			rev: undefined, content_hash: undefined, size: undefined });
		const getMetadata = vi.fn((id: string) => Promise.resolve(id === "id:root" ? root : entry({ rev })));
		const download = vi.fn(() => { rev = "r3"; return Promise.resolve(new ArrayBuffer(3)); });
		const fs = new DropboxFs({ getMetadata, download } as unknown as DropboxClient, "id:root");
		const observed = await fs.priority.observe({ path: "note.md", identityKey: "id:file" });
		expect(observed).toMatchObject({ kind: "current", token: "dropbox:r2" });
		if (observed.kind !== "current") throw new Error("expected current");
		expect(await fs.priority.read(observed)).toEqual({ kind: "target_changed" });
		expect(getMetadata).toHaveBeenNthCalledWith(2, "id:root/note.md");
	});

	it("fails closed for incomplete evidence, replacement, and missing path", async () => {
		const root = entry({ ".tag": "folder", id: "id:root", path_display: "/Vault" });
		const incomplete = new DropboxFs({ getMetadata: vi.fn((id: string) => Promise.resolve(
			id === "id:root" ? root : entry({ rev: undefined }),
		)) } as unknown as DropboxClient, "id:root");
		expect((await incomplete.priority.observe({ path: "note.md", identityKey: "id:file" })).kind).toBe("unverifiable");
		const replacement = new DropboxFs({ getMetadata: vi.fn((id: string) => Promise.resolve(
			id === "id:root" ? root : entry({ id: "id:replacement", rev: "r3" }),
		)) } as unknown as DropboxClient, "id:root");
		expect(await replacement.priority.observe({ path: "note.md", identityKey: "id:file" })).toMatchObject({
			kind: "structural", occupant: { identityKey: "id:replacement" },
		});
		const missing = new DropboxFs({ getMetadata: vi.fn(() => Promise.reject(
			new DropboxApiError("gone", 409, "path/not_found"),
		)) } as unknown as DropboxClient, "id:root");
		expect(await missing.priority.observe({ path: "note.md", identityKey: "id:file" }))
			.toEqual({ kind: "missing", occupant: { kind: "absent" } });
	});
});
