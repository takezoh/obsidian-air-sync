import { createMockFs } from "./sync-test-helpers";
import { runIFileSystemContract } from "../fs/ifilesystem-contract";

// The canonical in-memory test double (createMockFs) must model the same
// IFileSystem semantics LocalFs / GoogleDriveFs do — path normalization, rename
// validation, copy-on-read, type-collision errors. Drive it through the shared
// backend-agnostic contract so it cannot silently drift from the real backends.
runIFileSystemContract("createMockFs", () => createMockFs("test"), {
	computesHashOnStat: true,
});
