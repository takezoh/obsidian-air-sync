import { App } from "obsidian";
import { LocalFs } from "./index";
import { runIFileSystemContract } from "../ifilesystem-contract";

// Run the shared IFileSystem contract against the REAL LocalFs over the in-memory
// Vault mock. This exercises LocalFs's normal-path branches (vault.rename for
// folders, folder.children for listDir, fileManager.trashFile for delete) that
// its bespoke tests only cover for dot-paths — and proves LocalFs models the same
// semantics as the mock and the remotes. LocalFs hashes on stat (sha256), so
// computesHashOnStat stays true.
runIFileSystemContract("LocalFs", () => new LocalFs(new App()), {
	computesHashOnStat: true,
});
