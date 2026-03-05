import { describe, it, expect, vi } from "vitest";
import { App, TFolder } from "obsidian";
import { LocalFs } from "./index";

describe("LocalFs", () => {
	function createLocalFs(): { app: App; vault: App["vault"]; fs: LocalFs } {
		const app = new App();
		const fs = new LocalFs(app);
		return { app, vault: app.vault, fs };
	}

	describe("mkdirRecursive (via write)", () => {
		it("creates parent directories when writing a nested file", async () => {
			const { vault, fs } = createLocalFs();
			const content = new TextEncoder().encode("hello").buffer;

			await fs.write("a/b/file.txt", content, Date.now());

			expect(vault.getAbstractFileByPath("a")).toBeInstanceOf(TFolder);
			expect(vault.getAbstractFileByPath("a/b")).toBeInstanceOf(TFolder);
		});

		it("skips createFolder when the folder already exists in vault index", async () => {
			const { vault, fs } = createLocalFs();
			await vault.createFolder("a");
			const spy = vi.spyOn(vault, "createFolder");

			const content = new TextEncoder().encode("hello").buffer;
			await fs.write("a/file.txt", content, Date.now());

			expect(spy).not.toHaveBeenCalled();
		});

		it("skips createFolder when folder exists on disk but not in vault index", async () => {
			const { vault, fs } = createLocalFs();
			// getAbstractFileByPath returns null (not in index), but exists() returns true (on disk)
			vi.spyOn(vault, "getAbstractFileByPath").mockReturnValue(null);
			vi.spyOn(vault.adapter, "exists").mockResolvedValue(true);
			const createSpy = vi.spyOn(vault, "createFolder");
			vi.spyOn(vault, "createBinary").mockResolvedValue(
				Object.assign(Object.create((await import("obsidian")).TFile.prototype), {
					path: "a/file.txt",
					stat: { size: 5, mtime: 0 },
				}),
			);

			const content = new TextEncoder().encode("hello").buffer;
			await fs.write("a/file.txt", content, Date.now());

			expect(createSpy).not.toHaveBeenCalled();
		});

		it("calls createFolder when folder does not exist on disk or in index", async () => {
			const { vault, fs } = createLocalFs();
			const createSpy = vi.spyOn(vault, "createFolder");

			const content = new TextEncoder().encode("hello").buffer;
			await fs.write("a/file.txt", content, Date.now());

			expect(createSpy).toHaveBeenCalledWith("a");
		});
	});

});
