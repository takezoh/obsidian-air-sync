import { describe, expect, it } from "vitest";
import type { RemoteObject } from "../../../src/backend-api";
import { RemoteObjectValidationError, validateRemoteObject } from "../../../src/fs/managed/remote-object-validation";

function fileObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "f1",
		name: "a.md",
		kind: "file",
		location: { addressing: "parent_id", parentId: "d1" },
		pathAuthority: "provider_resolved",
		size: 3,
		mtimeMs: 10,
		versionToken: "v1",
		checksum: { algorithm: "md5", value: "abc" },
		...overrides,
	};
}

describe("validateRemoteObject", () => {
	it("accepts a well-formed parent_id file and preserves every field", () => {
		const object = validateRemoteObject(fileObject());
		expect(object).toEqual({
			id: "f1", name: "a.md", kind: "file",
			location: { addressing: "parent_id", parentId: "d1" },
			pathAuthority: "provider_resolved",
			size: 3, mtimeMs: 10, versionToken: "v1",
			checksum: { algorithm: "md5", value: "abc" },
		} satisfies RemoteObject);
	});

	it("accepts a provider_path directory with a null parent and no checksum", () => {
		const object = validateRemoteObject({
			id: "d1", name: "docs", kind: "directory",
			location: { addressing: "provider_path", rootId: "root", path: "docs" },
		});
		expect(object.kind).toBe("directory");
		expect(object.location).toEqual({ addressing: "provider_path", rootId: "root", path: "docs" });
	});

	it("accepts a parent_id root-level entry (parentId null) and unknown size/mtime", () => {
		const object = validateRemoteObject({
			id: "f1", name: "a.md", kind: "file",
			location: { addressing: "parent_id", parentId: null },
		});
		expect(object.size).toBeUndefined();
		expect(object.mtimeMs).toBeUndefined();
	});

	it.each([
		["a non-object", 5],
		["a missing id", { name: "a", kind: "file", location: { addressing: "parent_id", parentId: null } }],
		["an empty name", { id: "x", name: "", kind: "file", location: { addressing: "parent_id", parentId: null } }],
		["an unknown kind", { id: "x", name: "a", kind: "symlink", location: { addressing: "parent_id", parentId: null } }],
		["a bad addressing", { id: "x", name: "a", kind: "file", location: { addressing: "magic" } }],
		["a non-string parentId", { id: "x", name: "a", kind: "file", location: { addressing: "parent_id", parentId: 5 } }],
		["a provider_path without rootId", { id: "x", name: "a", kind: "file", location: { addressing: "provider_path", path: "a" } }],
		["a negative size", fileObject({ size: -1 })],
		["a non-finite mtime", fileObject({ mtimeMs: Number.NaN })],
		["a bad pathAuthority", fileObject({ pathAuthority: "guessed" })],
		["a malformed checksum", fileObject({ checksum: { algorithm: "md5" } })],
		["a directory carrying a checksum", fileObject({ kind: "directory", checksum: { algorithm: "md5", value: "x" } })],
	])("rejects %s", (_label, value) => {
		expect(() => validateRemoteObject(value)).toThrow(RemoteObjectValidationError);
	});

	it("marks a malformed object permanent so the retry policy does not spin", () => {
		try {
			validateRemoteObject(null);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(RemoteObjectValidationError);
			expect((err as RemoteObjectValidationError).permanent).toBe(true);
		}
	});
});
