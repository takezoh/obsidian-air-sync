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

/** A Google Workspace-native object: no size, no md5Checksum, unreadable via alt=media. */
const native = (id: string, parents: string[], version = "2") => ({
	id,
	name: `${id} (doc)`,
	mimeType: "application/vnd.google-apps.document",
	parents,
	version,
	modifiedTime: "2026-01-01T00:00:00.000Z",
});

/** A byte-backed object the provider reports with no parent (e.g. an item in "Shared with me"). */
const unparented = (id: string, version = "2") => ({
	id,
	name: `${id}.pdf`,
	mimeType: "application/pdf",
	parents: [] as string[],
	version,
	modifiedTime: "2026-01-01T00:00:00.000Z",
	md5Checksum: `md5-${id}`,
	size: "10",
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

describe("GoogleDriveAdapter excludes provider-native Workspace objects (RB-SVC-010)", () => {
	it("omits native objects from the full listing while keeping byte-backed files", async () => {
		const listAllFiles = vi.fn().mockResolvedValue([file("c", ["root"]), native("n", ["root"])]);
		const adapter = new GoogleDriveAdapter(stubClient({ listAllFiles }), "root");

		const objects = await adapter.listAll();

		expect(objects.map((object) => object.id)).toEqual(["c"]);
	});

	it("omits native objects from a folder subtree read", async () => {
		const listAllFiles = vi.fn().mockResolvedValue([
			folder("F", ["root"]),
			file("c", ["F"]),
			native("n", ["F"]),
		]);
		const adapter = new GoogleDriveAdapter(stubClient({ listAllFiles }), "root");

		const result = await adapter.listSubtreeById("F");

		if (result.kind !== "subtree") throw new Error("expected subtree");
		expect(result.objects.map((object) => object.id)).toEqual(["F", "c"]);
	});

	it("does not upsert a native object from the delta feed but keeps its delete", async () => {
		const listChanges = vi.fn().mockResolvedValue({
			changes: [
				{ type: "file", fileId: "a", removed: false, file: file("a", ["root"]) },
				{ type: "file", fileId: "n", removed: false, file: native("n", ["root"]) },
				{ type: "file", fileId: "n", removed: true },
			],
		});
		const adapter = new GoogleDriveAdapter(stubClient({ listChanges }), "root");

		const result = await adapter.getChanges("cursor");

		if (result.kind !== "changes") throw new Error("expected changes");
		const upserts: string[] = [];
		const deletes: string[] = [];
		for (const change of result.changes) {
			if (change.kind === "upsert") upserts.push(change.object.id);
			else if ("id" in change) deletes.push(change.id);
		}
		expect(upserts).toEqual(["a"]);
		expect(deletes).toEqual(["n"]);
	});

	it("resolves a native object to absence by path and identity", async () => {
		const getFile = vi.fn().mockResolvedValue(native("n", ["root"]));
		const listChildrenByName = vi.fn().mockResolvedValue([native("n", ["root"])]);
		const adapter = new GoogleDriveAdapter(stubClient({ getFile, listChildrenByName }), "root");

		expect(await adapter.getById("n")).toBeNull();
		expect(await adapter.getByPath("n (doc)")).toEqual([]);
	});

	it("fails a version-bound read of a native object as unverifiable without downloading", async () => {
		const getFile = vi.fn().mockResolvedValue(native("n", ["root"]));
		const downloadFile = vi.fn();
		const adapter = new GoogleDriveAdapter(stubClient({ getFile, downloadFile }), "root");

		const result = await adapter.read({ id: "n", versionToken: "googledrive:v:2" });

		expect(result.kind).toBe("unverifiable");
		expect(downloadFile).not.toHaveBeenCalled();
	});
});

describe("GoogleDriveAdapter keeps out-of-subtree objects out of the view", () => {
	it("omits an object with no provider parent from the listing and the delta feed", async () => {
		const listAllFiles = vi.fn().mockResolvedValue([file("c", ["root"]), unparented("u")]);
		const listChanges = vi.fn().mockResolvedValue({
			changes: [
				{ type: "file", fileId: "c", removed: false, file: file("c", ["root"]) },
				{ type: "file", fileId: "u", removed: false, file: unparented("u") },
			],
		});
		const adapter = new GoogleDriveAdapter(stubClient({ listAllFiles, listChanges }), "root");

		expect((await adapter.listAll()).map((object) => object.id)).toEqual(["c"]);

		const result = await adapter.getChanges("cursor");
		if (result.kind !== "changes") throw new Error("expected changes");
		const upserts: string[] = [];
		for (const change of result.changes) {
			if (change.kind === "upsert") upserts.push(change.object.id);
		}
		expect(upserts).toEqual(["c"]);
	});

	it("resolves a no-parent object to absence by identity and path", async () => {
		const getFile = vi.fn().mockResolvedValue(unparented("u"));
		const listChildrenByName = vi.fn().mockResolvedValue([unparented("u")]);
		const adapter = new GoogleDriveAdapter(stubClient({ getFile, listChildrenByName }), "root");

		expect(await adapter.getById("u")).toBeNull();
		expect(await adapter.getByPath("u.pdf")).toEqual([]);
	});
});
