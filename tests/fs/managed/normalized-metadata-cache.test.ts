import { describe, expect, it } from "vitest";
import type { RemoteObject } from "../../../src/backend-api";
import { NormalizedMetadataCache, toFileEntity } from "../../../src/fs/managed/normalized-metadata-cache";

function object(
	id: string,
	name: string,
	kind: "file" | "directory",
	location: RemoteObject["location"],
	extra: Partial<RemoteObject> = {},
): RemoteObject {
	return { id, name, kind, location, ...extra };
}

const parented = (parentId: string | null): RemoteObject["location"] => ({ addressing: "parent_id", parentId });
const pathed = (path: string): RemoteObject["location"] => ({ addressing: "provider_path", rootId: "root", path });

describe("NormalizedMetadataCache", () => {
	it("resolves a complete parent_id snapshot including root-level entries", () => {
		const cache = new NormalizedMetadataCache("root");
		const displacements = cache.buildFromFiles([
			object("d1", "docs", "directory", parented(null)),
			object("f1", "a.md", "file", parented("d1")),
			object("f2", "top.md", "file", parented(null)),
		]);
		expect(displacements).toEqual([]);
		expect([...cache.entries()].map(([path]) => path).sort()).toEqual(["docs", "docs/a.md", "top.md"]);
		expect(cache.isFolder("docs")).toBe(true);
		expect(cache.idAt("docs/a.md")).toBe("f1");
	});

	it("resolves provider_path topology from the snapshot index, regardless of order", () => {
		const cache = new NormalizedMetadataCache("root");
		// Child listed before its parent: the index is built from the whole set first.
		cache.buildFromFiles([
			object("f1", "a.md", "file", pathed("docs/sub/a.md")),
			object("d2", "sub", "directory", pathed("docs/sub")),
			object("d1", "docs", "directory", pathed("docs")),
			object("f2", "root.md", "file", pathed("root.md")),
		]);
		expect([...cache.entries()].map(([path]) => path).sort()).toEqual(["docs", "docs/sub", "docs/sub/a.md", "root.md"]);
		expect(cache.idAt("docs/sub/a.md")).toBe("f1");
	});

	it("fails closed: a provider_path object whose parent is not in the snapshot is not seated", () => {
		const cache = new NormalizedMetadataCache("root");
		cache.buildFromFiles([
			object("f1", "orphan.md", "file", pathed("missing/orphan.md")),
			object("f2", "keep.md", "file", pathed("keep.md")),
			object("f3", "deep.md", "file", pathed("missing/deep/deep.md")),
		]);
		expect([...cache.entries()].map(([path]) => path)).toEqual(["keep.md"]);
	});

	it("resolves a provider_path delta only when its parent is in the working view", () => {
		const cache = new NormalizedMetadataCache("root");
		cache.buildFromFiles([object("d1", "docs", "directory", pathed("docs"))]);
		const seated = cache.applyFileChange(object("f1", "a.md", "file", pathed("docs/a.md")));
		expect(seated?.path).toBe("docs/a.md");
		const orphan = cache.applyFileChange(object("f9", "gone.md", "file", pathed("nowhere/gone.md")));
		expect(orphan).toBeNull();
		expect(cache.hasFile("nowhere/gone.md")).toBe(false);
	});

	it("projects a file entity with size, mtime, checksum, identity and authority", () => {
		const cache = new NormalizedMetadataCache("root");
		cache.buildFromFiles([
			object("d1", "docs", "directory", pathed("docs")),
			object("f1", "a.md", "file", pathed("docs/a.md"), {
				size: 12, mtimeMs: 4_000, versionToken: "v7",
				checksum: { algorithm: "md5", value: "deadbeef" },
			}),
		]);
		const entity = cache.toEntity("docs/a.md", cache.getFile("docs/a.md")!);
		expect(entity).toMatchObject({
			path: "docs/a.md",
			identityKey: "f1",
			isDirectory: false,
			size: 12,
			mtime: 4_000,
			hash: "",
			remoteChecksum: { algo: "md5", value: "deadbeef" },
			backendMeta: { remoteId: "f1", versionToken: "v7" },
		});
		const folder = cache.toEntity("docs", cache.getFile("docs")!);
		expect(folder).toMatchObject({ isDirectory: true, size: 0, mtime: 0, hash: "" });
		expect(folder.remoteChecksum).toBeUndefined();
	});

	it("uses sentinels for an unknown size and mtime and exposes a root-level path", () => {
		const entity = toFileEntity("a.md", object("f1", "a.md", "file", parented(null)), "requested_echo", "h");
		expect(entity).toMatchObject({ size: 0, mtime: 0, hash: "h", pathAuthority: "requested_echo" });
	});

	it("retires a moved provider_path entry's old address from the index", () => {
		const cache = new NormalizedMetadataCache("root");
		cache.buildFromFiles([
			object("d1", "docs", "directory", pathed("docs")),
			object("f1", "a.md", "file", pathed("docs/a.md")),
		]);
		cache.setFile("docs/a.md", object("f1", "a.md", "file", pathed("docs/a.md")));
		cache.removeEntry("docs/a.md");
		expect(cache.hasFile("docs/a.md")).toBe(false);
		// A later delta child under the removed object must not resolve through a stale index.
		const orphan = cache.applyFileChange(object("f2", "b.md", "file", pathed("docs/a.md/b.md")));
		expect(orphan).toBeNull();
	});
});
