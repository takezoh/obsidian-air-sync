import { MockFs } from "./index";
import {
	bytes,
	runRemoteChangeDetectionContract,
	statOrThrow,
} from "../remote-change-detection-contract";

// MockFs is the production test double: hash-based (sha256), mtime round-trips
// through write → stat. It must satisfy the same remote change-detection contract
// as every real backend. It is NOT checksumBased (no backendMeta.contentChecksum),
// so the metadata-touch case does not apply.
runRemoteChangeDetectionContract("MockFs", async () => {
	const fs = new MockFs("remote");
	const path = "note.md";
	return {
		async observeWritten() {
			await fs.write(path, bytes("version one"), 1000);
			return statOrThrow(fs, path);
		},
		async observeUnchanged() {
			return statOrThrow(fs, path);
		},
		async observeAfterEdit() {
			await fs.write(
				path,
				bytes("version two — different content"),
				2000,
			);
			return statOrThrow(fs, path);
		},
	};
});
