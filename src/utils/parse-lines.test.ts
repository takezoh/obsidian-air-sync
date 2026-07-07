import { describe, it, expect } from "vitest";
import { parseLines } from "./parse-lines";

describe("parseLines", () => {
	it("trims and drops blank lines by default", () => {
		expect(parseLines("  a \n\n  b\n   ")).toEqual(["a", "b"]);
	});

	it("splits on newlines only", () => {
		expect(parseLines("a/b\nc")).toEqual(["a/b", "c"]);
	});

	it("strips trailing slashes before dropping blanks (so '/' becomes empty and is removed)", () => {
		expect(parseLines("docs///\n/\nx/", { stripTrailingSlash: true })).toEqual(["docs", "x"]);
	});

	it("preserves trailing slashes when not asked to strip (gitignore dir-only semantics)", () => {
		expect(parseLines("build/\nx", {})).toEqual(["build/", "x"]);
	});

	it("dedupes preserving first-seen order", () => {
		expect(parseLines("a\nb\na", { dedupe: true })).toEqual(["a", "b"]);
	});

	it("composes the dot-paths recipe (strip slash + dedupe)", () => {
		expect(parseLines(".t/\n.t\nx\n.s", { stripTrailingSlash: true, dedupe: true }))
			.toEqual([".t", "x", ".s"]);
	});

	it("returns an empty list for empty/whitespace input", () => {
		expect(parseLines("")).toEqual([]);
		expect(parseLines("\n  \n")).toEqual([]);
	});
});
