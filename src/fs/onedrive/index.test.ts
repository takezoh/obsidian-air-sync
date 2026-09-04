import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { OneDriveItem } from "./types";

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
