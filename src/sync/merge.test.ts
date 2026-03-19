import { describe, it, expect } from "vitest";
import { isMergeEligible, threeWayMerge } from "./merge";

describe("isMergeEligible", () => {
	it("returns true for markdown files within size limit", () => {
		expect(isMergeEligible("notes/daily.md", 500)).toBe(true);
	});

	it("returns true for other text file extensions", () => {
		expect(isMergeEligible("config.json", 100)).toBe(true);
		expect(isMergeEligible("styles.css", 100)).toBe(true);
		expect(isMergeEligible("notes.txt", 100)).toBe(true);
		expect(isMergeEligible("script.js", 100)).toBe(true);
		expect(isMergeEligible("code.ts", 100)).toBe(true);
		expect(isMergeEligible("data.yaml", 100)).toBe(true);
		expect(isMergeEligible("data.yml", 100)).toBe(true);
		expect(isMergeEligible("data.csv", 100)).toBe(true);
		expect(isMergeEligible("image.svg", 100)).toBe(true);
	});

	it("returns false for binary file extensions", () => {
		expect(isMergeEligible("photo.png", 100)).toBe(false);
		expect(isMergeEligible("image.jpg", 100)).toBe(false);
		expect(isMergeEligible("archive.zip", 100)).toBe(false);
		expect(isMergeEligible("document.pdf", 100)).toBe(false);
	});

	it("returns false for files exceeding 1MB", () => {
		expect(isMergeEligible("big.md", 1024 * 1024 + 1)).toBe(false);
	});

	it("returns true at exactly 1MB", () => {
		expect(isMergeEligible("exact.md", 1024 * 1024)).toBe(true);
	});

	it("returns false for files with no extension", () => {
		expect(isMergeEligible("Makefile", 100)).toBe(false);
	});

	it("handles nested paths correctly", () => {
		expect(isMergeEligible("a/b/c/deep.md", 100)).toBe(true);
	});

	it("returns false for extensionless file in dotted directory", () => {
		expect(isMergeEligible("dir.md/config", 100)).toBe(false);
	});
});

describe("threeWayMerge", () => {
	it("merges non-overlapping changes cleanly", () => {
		const base = "# Title\n\nFirst paragraph.\n\nSecond paragraph.";
		const local = "# Title\n\nFirst paragraph updated locally.\n\nSecond paragraph.";
		const remote = "# Title\n\nFirst paragraph.\n\nSecond paragraph updated remotely.";

		const result = threeWayMerge(base, local, remote);

		expect(result.success).toBe(true);
		expect(result.hasConflicts).toBe(false);
		expect(result.content).toBe(
			"# Title\n\nFirst paragraph updated locally.\n\nSecond paragraph updated remotely."
		);
	});

	it("detects conflicts when same lines are modified", () => {
		const base = "# Notes\n\nThis line will conflict.\n\nUntouched line.";
		const local = "# Notes\n\nEdited by local author.\n\nUntouched line.";
		const remote = "# Notes\n\nEdited by remote author.\n\nUntouched line.";

		const result = threeWayMerge(base, local, remote);

		expect(result.success).toBe(false);
		expect(result.hasConflicts).toBe(true);
		expect(result.content).toContain("<<<<<<< LOCAL");
		expect(result.content).toContain("Edited by local author.");
		expect(result.content).toContain("Edited by remote author.");
		expect(result.content).toContain(">>>>>>> REMOTE");
	});

	it("handles identical changes (no conflict)", () => {
		const base = "# Doc\n\nOld content here.\n\nFooter text.";
		const local = "# Doc\n\nSame new content here.\n\nFooter text.";
		const remote = "# Doc\n\nSame new content here.\n\nFooter text.";

		const result = threeWayMerge(base, local, remote);

		expect(result.success).toBe(true);
		expect(result.hasConflicts).toBe(false);
		expect(result.content).toBe("# Doc\n\nSame new content here.\n\nFooter text.");
	});

	it("handles empty base", () => {
		const base = "";
		const local = "new local content";
		const remote = "new remote content";

		const result = threeWayMerge(base, local, remote);

		// Both added different content — conflict
		expect(result.hasConflicts).toBe(true);
	});

	it("preserves indentation and inline spaces", () => {
		const base = "- item 1\n  - nested item\n- separator\n- item 2";
		const local = "- item 1\n  - nested item edited\n- separator\n- item 2";
		const remote = "- item 1\n  - nested item\n- separator\n- item 2 updated";

		const result = threeWayMerge(base, local, remote);

		expect(result.success).toBe(true);
		expect(result.hasConflicts).toBe(false);
		expect(result.content).toBe(
			"- item 1\n  - nested item edited\n- separator\n- item 2 updated"
		);
	});

	it("preserves CRLF line endings after merge (M4)", () => {
		const base = "# Title\r\n\r\nFirst paragraph.\r\n\r\nSecond paragraph.";
		const local = "# Title\r\n\r\nFirst paragraph updated locally.\r\n\r\nSecond paragraph.";
		const remote = "# Title\r\n\r\nFirst paragraph.\r\n\r\nSecond paragraph updated remotely.";

		const result = threeWayMerge(base, local, remote);

		expect(result.success).toBe(true);
		expect(result.hasConflicts).toBe(false);
		expect(result.content).toBe(
			"# Title\r\n\r\nFirst paragraph updated locally.\r\n\r\nSecond paragraph updated remotely."
		);
	});

	it("keeps LF line endings when input uses LF (M4)", () => {
		const base = "line1\nline2\nline3\nline4\nline5";
		const local = "line1\nlocal-change\nline3\nline4\nline5";
		const remote = "line1\nline2\nline3\nline4\nremote-change";

		const result = threeWayMerge(base, local, remote);

		expect(result.success).toBe(true);
		expect(result.content).not.toContain("\r\n");
		expect(result.content).toBe("line1\nlocal-change\nline3\nline4\nremote-change");
	});

	it("preserves trailing newline", () => {
		const base = "line 1\nline 2\n";
		const local = "line 1 changed\nline 2\n";
		const remote = "line 1\nline 2\n";

		const result = threeWayMerge(base, local, remote);

		expect(result.success).toBe(true);
		expect(result.content).toBe("line 1 changed\nline 2\n");
	});

	it("merges adjacent lines changed by different sides", () => {
		const base = "- item A\n- item B";
		const local = "- item A\n- item Bb";
		const remote = "- item Aa\n- item B";

		const result = threeWayMerge(base, local, remote);

		expect(result.success).toBe(true);
		expect(result.hasConflicts).toBe(false);
		expect(result.content).toBe("- item Aa\n- item Bb");
	});

	it("merges insertion adjacent to modification", () => {
		const base = "A\nB";
		const local = "A\nX\nBb";
		const remote = "Aa\nB";

		const result = threeWayMerge(base, local, remote);

		expect(result.success).toBe(true);
		expect(result.hasConflicts).toBe(false);
		expect(result.content).toBe("Aa\nX\nBb");
	});

	it("merges deletion with non-adjacent modification", () => {
		const base = "A\nB\nC";
		const local = "A\nC";
		const remote = "Aa\nB\nC";

		const result = threeWayMerge(base, local, remote);

		expect(result.success).toBe(true);
		expect(result.content).toBe("Aa\nC");
	});

	it("merges 5 lines with L=1,3 R=0,4 changes", () => {
		const base = "A\nB\nC\nD\nE";
		const local = "A\nX\nC\nY\nE";
		const remote = "Z\nB\nC\nD\nW";

		const result = threeWayMerge(base, local, remote);

		expect(result.success).toBe(true);
		expect(result.content).toBe("Z\nX\nC\nY\nW");
	});

	it("handles both sides making the same change (false conflict)", () => {
		const base = "A\nB\nC";
		const local = "A\nX\nC";
		const remote = "A\nX\nC";

		const result = threeWayMerge(base, local, remote);

		expect(result.success).toBe(true);
		expect(result.content).toBe("A\nX\nC");
	});

	it("conflicts when delete vs modify on same line", () => {
		const base = "A\nB\nC";
		const local = "A\nC";
		const remote = "A\nBb\nC";

		const result = threeWayMerge(base, local, remote);

		expect(result.hasConflicts).toBe(true);
		expect(result.content).toContain("<<<<<<< LOCAL");
		expect(result.content).toContain(">>>>>>> REMOTE");
	});

	it("conflicts when empty base and both sides add different content", () => {
		const result = threeWayMerge("", "A", "B");

		expect(result.hasConflicts).toBe(true);
	});

	it("does not include diff3-style BASE markers", () => {
		const base = "A\nB";
		const local = "X\nB";
		const remote = "Y\nB";

		const result = threeWayMerge(base, local, remote);

		expect(result.hasConflicts).toBe(true);
		expect(result.content).not.toContain("||||||| BASE");
	});
});
