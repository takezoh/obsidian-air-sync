import { describe, expect, it } from "vitest";
import { createMockFs } from "./sync-test-helpers";
import { bytes, runIFileSystemContract } from "../fs/ifilesystem-contract.test";

// The canonical in-memory test double (createMockFs) must model the same
// IFileSystem semantics LocalFs / GoogleDriveFs do — path normalization, rename
// validation, copy-on-read, type-collision errors. Drive it through the shared
// backend-agnostic contract so it cannot silently drift from the real backends.
runIFileSystemContract("createMockFs", () => createMockFs("test"), {
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
});
