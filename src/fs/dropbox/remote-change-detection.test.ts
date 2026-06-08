import { vi, afterEach } from "vitest";
import { spyRequestUrl, mockRes, dbxFile } from "./test-helpers";
import type { DropboxFsInternal } from "./test-helpers";
import type { DropboxEntry } from "./types";
import { bytes, runRemoteChangeDetectionContract, statOrThrow } from "../remote-change-detection-contract";

vi.mock("obsidian");

// DropboxFs returns hash:"" from stat() and relies on remoteChecksum (the
// content_hash 4 MiB SHA-256 tree) + server_modified for change detection.
// checksumBased: the metadata-only touch case (mtime bumped, identical
// content_hash) makes the checksum plumbing load-bearing — mtime+size alone
// cannot decide it.
runRemoteChangeDetectionContract(
	"DropboxFs",
	async () => {
		let upload: DropboxEntry = dbxFile("1", "/root/note.md", {
			content_hash: "HASH-1",
			size: 11,
			server_modified: "2024-01-01T00:00:00Z",
		});

		(await spyRequestUrl()).mockImplementation((opts: string | { url: string }) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("/files/upload")) return Promise.resolve(mockRes(upload));
			return Promise.resolve(mockRes({ entries: [], cursor: "C", has_more: false }));
		});

		const { DropboxFs } = await import("./index");
		const { DropboxClient } = await import("./client");
		const fs = new DropboxFs(new DropboxClient(() => Promise.resolve("AT")), "id:root");
		(fs as unknown as DropboxFsInternal).initialized = true;

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
				// A real content edit: new content_hash + bumped server_modified + new size.
				upload = dbxFile("1", "/root/note.md", { content_hash: "HASH-2", size: 12, server_modified: "2024-06-01T00:00:00Z" });
				await fs.write(path, bytes("version two!"), Date.now());
				return statOrThrow(fs, path);
			},
			async observeTouchedSameContent() {
				// Metadata-only touch: server_modified bumped, content_hash + size identical.
				// Only the dropbox-checksum comparison can prove this is "unchanged".
				upload = dbxFile("1", "/root/note.md", { content_hash: "HASH-1", size: 11, server_modified: "2024-03-01T00:00:00Z" });
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
