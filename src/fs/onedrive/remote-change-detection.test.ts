import { vi, afterEach } from "vitest";
import { spyRequestUrl, mockRes, odFile } from "./test-helpers";
import type { OneDriveFsInternal } from "./test-helpers";
import type { OneDriveItem } from "./types";
import { bytes, runRemoteChangeDetectionContract, statOrThrow } from "../remote-change-detection-contract";

vi.mock("obsidian");

// OneDriveFs returns hash:"" from stat() and relies on remoteChecksum (the
// quickXorHash) + fileSystemInfo.lastModifiedDateTime for change detection.
// checksumBased: the metadata-only touch case (mtime bumped, identical checksum)
// makes the checksum plumbing load-bearing — mtime+size alone cannot decide it.
runRemoteChangeDetectionContract(
	"OneDriveFs",
	async () => {
		let uploaded: OneDriveItem = odFile("f1", "note.md", "root", {
			file: { hashes: { quickXorHash: "HASH-1" } },
			size: 11,
			fileSystemInfo: { lastModifiedDateTime: "2024-01-01T00:00:00Z" },
		});

		(await spyRequestUrl()).mockImplementation((opts: string | { url: string }) => {
			const url = typeof opts === "string" ? opts : opts.url;
			// Both the content PUT and the mtime PATCH return the current upload item.
			if (url.includes("/me/drive/items/")) return Promise.resolve(mockRes(uploaded));
			return Promise.resolve(mockRes({ value: [], "@odata.deltaLink": "https://g?token=C" }));
		});

		const { OneDriveFs } = await import("./index");
		const { OneDriveClient } = await import("./client");
		const fs = new OneDriveFs(new OneDriveClient(() => Promise.resolve("AT")), "root");
		(fs as unknown as OneDriveFsInternal).initialized = true;

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
				// A real content edit: new checksum + bumped mtime + new size.
				uploaded = odFile("f1", "note.md", "root", {
					file: { hashes: { quickXorHash: "HASH-2" } },
					size: 12,
					fileSystemInfo: { lastModifiedDateTime: "2024-06-01T00:00:00Z" },
				});
				await fs.write(path, bytes("version two!"), Date.now());
				return statOrThrow(fs, path);
			},
			async observeTouchedSameContent() {
				// Metadata-only touch: mtime bumped, checksum + size identical. Only the
				// checksum comparison can prove this is "unchanged".
				uploaded = odFile("f1", "note.md", "root", {
					file: { hashes: { quickXorHash: "HASH-1" } },
					size: 11,
					fileSystemInfo: { lastModifiedDateTime: "2024-03-01T00:00:00Z" },
				});
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
