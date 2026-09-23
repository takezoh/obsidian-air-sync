import { describe, expect, it, vi } from "vitest";
import { GoogleDriveAdapter } from "./adapter";
import type { GoogleDriveClient } from "./client";
import { FOLDER_MIME } from "./types";

/** A client stub exposing only the methods the adapter under test reaches. */
function stubClient(overrides: Partial<GoogleDriveClient>): GoogleDriveClient {
	return overrides as unknown as GoogleDriveClient;
}

const folder = (id: string, parents: string[], version = "3") => ({
	id,
	name: id,
	mimeType: FOLDER_MIME,
	parents,
	version,
	modifiedTime: "2026-01-01T00:00:00.000Z",
});

const file = (id: string, parents: string[], version = "2") => ({
	id,
	name: `${id}.md`,
	mimeType: "text/markdown",
	parents,
	version,
	modifiedTime: "2026-01-01T00:00:00.000Z",
	md5Checksum: `md5-${id}`,
	size: "1",
});

describe("GoogleDriveAdapter delta completion", () => {
	it("does not walk a changed folder on the delta path", async () => {
		const listAllFiles = vi.fn();
		const listChanges = vi.fn().mockResolvedValue({ changes: [{ fileId: "F", file: folder("F", ["root"]) }] });
		const adapter = new GoogleDriveAdapter(stubClient({ listChanges, listAllFiles }), "root");

		const result = await adapter.getChanges("cursor");

		expect(result.kind).toBe("changes");
		expect(listAllFiles).not.toHaveBeenCalled();
		if (result.kind === "changes") expect(result.changes).toHaveLength(1);
	});

	it("reads exactly one folder subtree by identity", async () => {
		const listAllFiles = vi.fn().mockResolvedValue([folder("F", ["root"], "4"), file("c", ["F"])]);
		const adapter = new GoogleDriveAdapter(stubClient({ listAllFiles }), "root");

		const result = await adapter.listSubtreeById("F");

		expect(listAllFiles).toHaveBeenCalledTimes(1);
		expect(listAllFiles).toHaveBeenCalledWith("F");
		expect(result.kind).toBe("subtree");
		if (result.kind === "subtree") expect(result.objects.map((object) => object.id)).toEqual(["F", "c"]);
	});

	it("maps a 410 on the subtree read to cursor_invalid", async () => {
		const listAllFiles = vi.fn().mockRejectedValue(Object.assign(new Error("gone"), { status: 410 }));
		const adapter = new GoogleDriveAdapter(stubClient({ listAllFiles }), "root");

		expect(await adapter.listSubtreeById("F")).toEqual({ kind: "cursor_invalid" });
	});
});
