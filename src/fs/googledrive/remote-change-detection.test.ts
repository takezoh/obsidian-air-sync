import { vi, afterEach } from "vitest";
import { spyRequestUrl, mockRes } from "./test-helpers";
import type { GoogleDriveFsInternal } from "./test-helpers";
import {
	bytes,
	runRemoteChangeDetectionContract,
	statOrThrow,
} from "../remote-change-detection-contract";

vi.mock("obsidian");

interface DriveUploadResult {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	size: string;
	md5Checksum: string;
}

// GoogleDriveFs returns hash:"" from stat() and relies entirely on
// remoteChecksum (Drive md5) + modifiedTime for change detection.
// checksumBased: the metadata-touch case (mtime bumped, identical md5) makes the
// remoteChecksum plumbing load-bearing — mtime+size alone cannot decide it.
runRemoteChangeDetectionContract(
	"GoogleDriveFs",
	async () => {
		let uploadResult: DriveUploadResult = {
			id: "file1",
			name: "note.md",
			mimeType: "text/plain",
			modifiedTime: "2024-01-01T00:00:00.000Z",
			size: "11",
			md5Checksum: "md5-v1",
		};

		(await spyRequestUrl()).mockImplementation(
			(opts: string | { url: string }) => {
				const url = typeof opts === "string" ? opts : opts.url;
				if (url.includes("uploadType="))
					return Promise.resolve(mockRes(uploadResult));
				return Promise.resolve(mockRes({ files: [] }));
			},
		);

		const { GoogleDriveFs } = await import("./index");
		const { DriveClient } = await import("./client");
		const client = new DriveClient(() => Promise.resolve("access"));
		const fs = new GoogleDriveFs(client, "root");
		(fs as unknown as GoogleDriveFsInternal).initialized = true;

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
				// A real content edit on Drive: new md5 + bumped modifiedTime + new size.
				uploadResult = {
					...uploadResult,
					modifiedTime: "2024-06-01T00:00:00.000Z",
					size: "12",
					md5Checksum: "md5-v2",
				};
				await fs.write(path, bytes("version two!"), Date.now());
				return statOrThrow(fs, path);
			},
			async observeTouchedSameContent() {
				// Metadata-only touch: Drive bumps modifiedTime but md5 + size are identical.
				// Only the contentChecksum comparison can prove this is "unchanged".
				uploadResult = {
					...uploadResult,
					modifiedTime: "2024-03-01T00:00:00.000Z",
				};
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
