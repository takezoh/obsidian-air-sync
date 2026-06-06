import { describe, it, expect } from "vitest";
import { assertOk, pcloudEntryToEntity, parsePCloudTime, folderIdOf, withoutContents } from "./types";
import { AuthError } from "../errors";
import { pcFile, pcFolder } from "./test-helpers";

describe("assertOk", () => {
	it("passes for result 0", () => {
		expect(() => assertOk({ result: 0 }, "listFolder")).not.toThrow();
	});

	it("throws a generic Error for a non-auth result code", () => {
		expect(() => assertOk({ result: 2005, error: "Directory does not exist." }, "listFolder")).toThrow(
			"pCloud API listFolder failed: 2005 Directory does not exist.",
		);
	});

	it("throws AuthError for authentication-class result codes", () => {
		for (const code of [1000, 2000, 2094, 2095]) {
			let caught: unknown;
			try {
				assertOk({ result: code, error: "auth" }, "stat");
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(AuthError);
			expect((caught as AuthError).status).toBe(401);
		}
	});

	it("throws on a malformed (no result) response", () => {
		expect(() => assertOk({}, "diff")).toThrow("malformed response");
	});
});

describe("parsePCloudTime", () => {
	it("parses an RFC datetime to epoch ms", () => {
		expect(parsePCloudTime("Wed, 02 Oct 2013 14:17:54 +0000")).toBe(Date.parse("2013-10-02T14:17:54Z"));
	});
	it("returns 0 for missing or unparseable input", () => {
		expect(parsePCloudTime(undefined)).toBe(0);
		expect(parsePCloudTime("not a date")).toBe(0);
	});
});

describe("pcloudEntryToEntity", () => {
	it("maps a file to an opaque remoteChecksum and empty hash", () => {
		const entity = pcloudEntryToEntity("a.md", pcFile(7, "a.md", 0, { hash: 12345, size: 42 }));
		expect(entity.isDirectory).toBe(false);
		expect(entity.size).toBe(42);
		expect(entity.hash).toBe("");
		expect(entity.remoteChecksum).toEqual({ algo: "opaque", value: "12345" });
		expect(entity.backendMeta).toEqual({ pcloudId: "f7" });
	});

	it("maps a folder to a minimal entity (no checksum)", () => {
		const entity = pcloudEntryToEntity("sub", pcFolder(2, "sub", 0));
		expect(entity).toEqual({ path: "sub", isDirectory: true, size: 0, mtime: 0, hash: "" });
	});

	it("omits remoteChecksum when hash is absent", () => {
		const entity = pcloudEntryToEntity("a.md", pcFile(7, "a.md", 0, { hash: undefined }));
		expect(entity.remoteChecksum).toBeUndefined();
	});
});

describe("folderIdOf / withoutContents", () => {
	it("returns the folder id as a string", () => {
		expect(folderIdOf(pcFolder(9, "x", 0))).toBe("9");
	});
	it("strips the recursive contents array", () => {
		const folder = pcFolder(2, "sub", 0, [pcFile(1, "a.md", 2)]);
		expect(withoutContents(folder).contents).toBeUndefined();
		// original is untouched
		expect(folder.contents).toHaveLength(1);
	});
});
