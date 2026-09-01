import { describe, expect, it } from "vitest";
import {
	addFile,
	confirmMockPath,
	createMockFs,
	createMockLocalFs,
	createMockRemoteFs,
} from "./sync-test-helpers";
import { bytes, runIFileSystemContract } from "../fs/contracts/ifilesystem.contract";

// The canonical in-memory test double (createMockFs) must model the same
// IFileSystem semantics LocalFs / GoogleDriveFs do — path normalization, rename
// validation, copy-on-read, type-collision errors. Drive it through the shared
// backend-agnostic contract so it cannot silently drift from the real backends.
runIFileSystemContract("createMockFs", () => createMockFs("test", "actual_resolved"), {
	computesHashOnStat: true,
});

describe("createMockFs path authority", () => {
	it("distinguishes mutation echoes from resolved observations", async () => {
		const fs = createMockFs("test", "requested_echo");

		expect((await fs.write("dir/a.md", bytes("a"), 1000)).pathAuthority)
			.toBe("requested_echo");
		expect((await fs.mkdir("empty")).pathAuthority).toBe("requested_echo");
		expect((await fs.stat("dir/a.md"))?.pathAuthority).toBe("requested_echo");
		expect((await fs.stat("empty"))?.pathAuthority).toBe("requested_echo");
	});

	it.each([
		["local", createMockLocalFs, "actual_resolved"],
		["remote", createMockRemoteFs, "requested_echo"],
	] as const)("preserves %s mutation authority through observations and rename", async (
		_role, createFs, expectedAuthority,
	) => {
		const fs = createFs();
		await fs.write("dir/a.md", bytes("a"), 1000);
		await fs.mkdir("empty");
		await fs.rename("dir", "moved");

		expect((await fs.stat("moved/a.md"))?.pathAuthority).toBe(expectedAuthority);
		expect((await fs.stat("empty"))?.pathAuthority).toBe(expectedAuthority);
		expect(new Map((await fs.list()).map((entity) => [entity.path, entity.pathAuthority])))
			.toMatchObject(new Map([
				["moved", expectedAuthority],
				["moved/a.md", expectedAuthority],
				["empty", expectedAuthority],
			]));
	});

	it.each([
		["local", createMockLocalFs],
		["remote", createMockRemoteFs],
	] as const)("treats %s addFile fixtures as producer-resolved seeds", async (
		_role, createFs,
	) => {
		const fs = createFs();
		addFile(fs, "seed/note.md", "observed");

		expect((await fs.stat("seed"))?.pathAuthority).toBe("actual_resolved");
		expect((await fs.stat("seed/note.md"))?.pathAuthority).toBe("actual_resolved");
	});

	it("requires an explicit provider-confirmation transition for remote mutations", async () => {
		const fs = createMockRemoteFs();
		await fs.write("dir/a.md", bytes("a"), 1000);
		expect((await fs.stat("dir/a.md"))?.pathAuthority).toBe("requested_echo");

		confirmMockPath(fs, "dir");

		expect((await fs.stat("dir/a.md"))?.pathAuthority).toBe("actual_resolved");
	});
});
