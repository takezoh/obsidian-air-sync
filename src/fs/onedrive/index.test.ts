import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestUrlParam } from "obsidian";
import type { OneDriveItem } from "./types";
import { spyRequestUrl, mockRes, odFile } from "./test-helpers";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OneDriveFs case-only parent resolution", () => {
	it("preserves provider casing when the requested parent differs only by case", async () => {
		const { OneDriveFs } = await import("./index");
		const folder: OneDriveItem = {
			id: "folder-1", name: "Templates", folder: {},
			parentReference: { id: "root" },
		};
		const child: OneDriveItem = {
			id: "child-1", name: "note.md", size: 4, file: {},
			parentReference: { id: folder.id },
		};
		const client = {
			createFolder: vi.fn().mockResolvedValue(folder),
			upload: vi.fn().mockResolvedValue(child),
		};
		const warn = vi.fn();
		const fs = new OneDriveFs(client as never, "root", {
			debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), flush: vi.fn(),
		} as never);
		const internal = fs as unknown as {
			initialized: boolean;
			cache: { setFile(path: string, item: OneDriveItem): void };
		};
		internal.initialized = true;
		internal.cache.setFile("Templates", folder);
		internal.cache.setFile("Templates/note.md", child);

		await fs.write("TemplateS/note.md", new TextEncoder().encode("same").buffer, 1000);

		expect(client.createFolder).not.toHaveBeenCalled();
		expect(client.upload).toHaveBeenCalledWith(folder.id, "note.md", expect.any(ArrayBuffer), 1000);
		expect(warn).not.toHaveBeenCalled();
		expect((await fs.stat("Templates/note.md"))?.identityKey).toBe("child-1");
		expect(await fs.stat("TemplateS/note.md")).toBeNull();
	});
});

describe("OneDriveFs full scan with a repeated delta id", () => {
	// Reproduces the reported failure: Graph repeats a driveItem across delta pages,
	// which reached MetadataCache.bulkLoad() as a duplicate stable id and failed the
	// whole scan ("Metadata cache contains duplicate stable id ...") — classified
	// transient, so it burned three full enumerations before giving up.
	it("completes instead of failing the scan as corrupt metadata", async () => {
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("token=latest")) {
				return Promise.resolve(mockRes({ value: [], "@odata.deltaLink": "https://g?token=START" }));
			}
			if (url.includes("nextpage")) {
				return Promise.resolve(mockRes({
					value: [odFile("f1", "a.md", "root")],
					"@odata.deltaLink": "https://g?token=END",
				}));
			}
			return Promise.resolve(mockRes({
				value: [odFile("f1", "a.md", "root"), odFile("f2", "b.md", "root")],
				"@odata.nextLink": "https://graph/nextpage",
			}));
		});

		const { OneDriveClient } = await import("./client");
		const { OneDriveFs } = await import("./index");
		const client = new OneDriveClient(() => Promise.resolve("tok"), undefined, () => Promise.resolve());
		const fs = new OneDriveFs(client, "root");

		const entries = await fs.list();

		expect(entries.map((e) => e.path).sort()).toEqual(["a.md", "b.md"]);
	});
});
