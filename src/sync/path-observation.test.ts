import { describe, expect, it } from "vitest";
import type { FileEntity } from "../fs/types";
import { exactEntity, observePath } from "./path-observation";

function entity(path: string, pathAuthority?: FileEntity["pathAuthority"]): FileEntity {
	return { path, pathAuthority, isDirectory: false, size: 1, mtime: 1, hash: "h" };
}

describe("observePath", () => {
	it("recognizes exact and alias paths only from actual-resolved producers", () => {
		const exact = observePath("local", "A.md", entity("A.md", "actual_resolved"));
		const alias = observePath("remote", "A.md", entity("a.md", "actual_resolved"));

		expect(exact.kind).toBe("exact");
		expect(exactEntity(exact)?.path).toBe("A.md");
		expect(alias).toMatchObject({ kind: "alias", requestedPath: "A.md", resolvedPath: "a.md" });
		expect(exactEntity(alias)).toBeUndefined();
	});

	it("keeps requested echoes and unspecified authority unresolved", () => {
		for (const candidate of [entity("A.md", "requested_echo"), entity("A.md")]) {
			expect(observePath("remote", "A.md", candidate)).toMatchObject({
				kind: "present_unresolved", requestedPath: "A.md", returnedPath: "A.md", source: "stat",
			});
		}
	});

	it("records whether unresolved presence came from list or stat", () => {
		expect(observePath("remote", "A.md", entity("A.md"), "stat", "list")).toMatchObject({
			kind: "present_unresolved", source: "list",
		});
		expect(observePath("remote", "A.md", entity("A.md"))).toMatchObject({
			kind: "present_unresolved", source: "stat",
		});
	});

	it("distinguishes checkpoint tombstones from stat absence", () => {
		expect(observePath("remote", "A.md", null, "checkpoint_deleted")).toEqual({
			kind: "absent", side: "remote", requestedPath: "A.md", authority: "checkpoint_deleted",
		});
		expect(observePath("local", "A.md", null)).toEqual({
			kind: "absent", side: "local", requestedPath: "A.md", authority: "stat",
		});
	});
});
