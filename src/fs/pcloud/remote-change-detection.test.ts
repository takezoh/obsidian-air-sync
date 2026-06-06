import { vi, afterEach } from "vitest";
import { spyRequestUrl, mockRes, pcFile } from "./test-helpers";
import type { PCloudFsInternal } from "./test-helpers";
import type { PCloudEntry } from "./types";
import { bytes, runRemoteChangeDetectionContract, statOrThrow } from "../remote-change-detection-contract";

vi.mock("obsidian");

// PCloudFs returns hash:"" from stat() and relies entirely on remoteChecksum
// (pCloud's opaque content hash) + modified time for change detection.
// checksumBased: the metadata-touch case (mtime bumped, identical hash) makes the
// remoteChecksum plumbing load-bearing — mtime+size alone cannot decide it.
runRemoteChangeDetectionContract(
	"PCloudFs",
	async () => {
		let upload: PCloudEntry = pcFile(1, "note.md", 0, { hash: 111, size: 11, modified: "2024-01-01T00:00:00.000Z" });

		(await spyRequestUrl()).mockImplementation((opts: string | { url: string }) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("/uploadfile")) {
				return Promise.resolve(mockRes({ result: 0, metadata: [upload], fileids: [1] }));
			}
			return Promise.resolve(mockRes({ result: 0, metadata: { id: "d0", name: "/", isfolder: true, folderid: 0, contents: [] }, diffid: 1, entries: [] }));
		});

		const { PCloudFs } = await import("./index");
		const { PCloudClient } = await import("./client");
		const client = new PCloudClient(() => "tok", () => "api.pcloud.com");
		const fs = new PCloudFs(client, "0");
		(fs as unknown as PCloudFsInternal).initialized = true;

		const path = "note.md";

		return {
			async observeWritten() {
				await fs.write(path, bytes("version one"), Date.now());
				return statOrThrow(fs, path);
			},
			async observeUnchanged() {
				return statOrThrow(fs, path);
			},
			async observeAfterEdit() {
				// A real content edit: new opaque hash + bumped modified + new size.
				upload = pcFile(1, "note.md", 0, { hash: 222, size: 12, modified: "2024-06-01T00:00:00.000Z" });
				await fs.write(path, bytes("version two!"), Date.now());
				return statOrThrow(fs, path);
			},
			async observeTouchedSameContent() {
				// Metadata-only touch: modified bumped, but hash + size identical.
				// Only the opaque-checksum comparison can prove this is "unchanged".
				upload = pcFile(1, "note.md", 0, { hash: 111, size: 11, modified: "2024-03-01T00:00:00.000Z" });
				await fs.write(path, bytes("version one"), Date.now());
				return statOrThrow(fs, path);
			},
		};
	},
	{ checksumBased: true },
);

afterEach(() => {
	vi.restoreAllMocks();
});
