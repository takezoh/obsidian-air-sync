import { describe, it, expect } from "vitest";
import {
	getFileExtension,
	normalizeSyncPath,
	validateRename,
	isDotPrefixed,
	isDotPathOutOfScope,
} from "./path";

describe("isDotPrefixed", () => {
	it("matches a top-level hidden path", () => {
		expect(isDotPrefixed(".airsync")).toBe(true);
		expect(isDotPrefixed(".airsync/logs/x.log")).toBe(true);
	});
	it("matches a nested hidden segment", () => {
		expect(isDotPrefixed("notes/.hidden/x")).toBe(true);
	});
	it("does not match normal paths", () => {
		expect(isDotPrefixed("notes/a.md")).toBe(false);
		expect(isDotPrefixed("a.b.md")).toBe(false);
	});
});

describe("isDotPathOutOfScope", () => {
	it("normal paths are never out of scope", () => {
		expect(isDotPathOutOfScope("notes/a.md", [])).toBe(false);
		expect(isDotPathOutOfScope("notes/a.md", [".airsync"])).toBe(false);
	});
	it("hidden paths not under a syncDotPaths root are out of scope", () => {
		expect(isDotPathOutOfScope(".airsync/logs/x.log", [])).toBe(true);
		expect(isDotPathOutOfScope(".git/config", [".templates"])).toBe(true);
	});
	it("hidden paths under a configured root are in scope", () => {
		expect(isDotPathOutOfScope(".airsync/logs/x.log", [".airsync"])).toBe(false);
		expect(isDotPathOutOfScope(".templates", [".templates"])).toBe(false);
	});
	it("tolerates a trailing slash on the root", () => {
		expect(isDotPathOutOfScope(".airsync/x", [".airsync/"])).toBe(false);
	});
	it("does not match a partial-prefix sibling root", () => {
		expect(isDotPathOutOfScope(".airsync2/x", [".airsync"])).toBe(true);
	});
});

describe("normalizeSyncPath", () => {
	it("strips leading slash", () => {
		expect(normalizeSyncPath("/foo/bar")).toBe("foo/bar");
	});

	it("strips trailing slash", () => {
		expect(normalizeSyncPath("foo/bar/")).toBe("foo/bar");
	});

	it("converts backslashes to forward slashes", () => {
		expect(normalizeSyncPath("foo\\bar\\baz")).toBe("foo/bar/baz");
	});

	it("collapses double slashes", () => {
		expect(normalizeSyncPath("foo//bar///baz")).toBe("foo/bar/baz");
	});

	it("handles empty string", () => {
		expect(normalizeSyncPath("")).toBe("");
	});

	it("handles already-normalized path", () => {
		expect(normalizeSyncPath("notes/hello.md")).toBe("notes/hello.md");
	});

	it("handles combined issues", () => {
		expect(normalizeSyncPath("/foo\\\\bar//baz/")).toBe("foo/bar/baz");
	});
});

describe("getFileExtension", () => {
	it("returns extension for simple file", () => {
		expect(getFileExtension("file.md")).toBe(".md");
	});

	it("returns extension for nested path", () => {
		expect(getFileExtension("a/b/file.json")).toBe(".json");
	});

	it("returns empty string for extensionless file", () => {
		expect(getFileExtension("Makefile")).toBe("");
	});

	it("returns empty string when dot is only in directory name", () => {
		expect(getFileExtension("dir.md/config")).toBe("");
	});

	it("returns file extension when both directory and file have dots", () => {
		expect(getFileExtension("dir.md/file.txt")).toBe(".txt");
	});

	it("returns lowercase extension", () => {
		expect(getFileExtension("FILE.MD")).toBe(".md");
	});

	it("returns last extension for multiple dots", () => {
		expect(getFileExtension("archive.tar.gz")).toBe(".gz");
	});
});

describe("validateRename", () => {
	it("throws when renaming to itself", () => {
		expect(() => validateRename("a.txt", "a.txt")).toThrow(
			'Cannot rename "a.txt" to itself'
		);
	});

	it("throws when moving into own subtree", () => {
		expect(() => validateRename("dir", "dir/sub")).toThrow(
			'Cannot move "dir" into its own subtree "dir/sub"'
		);
	});

	it("does not throw for valid rename", () => {
		expect(() => validateRename("a.txt", "b.txt")).not.toThrow();
	});

	it("does not throw for path sharing prefix", () => {
		expect(() => validateRename("dir", "dir-new")).not.toThrow();
	});
});
