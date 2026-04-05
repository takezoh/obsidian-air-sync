import { describe, it, expect, vi } from "vitest";
import { App, TFile, TFolder } from "obsidian";
import { LocalFs } from "./index";
import { AIRSYNC_DIR } from "../../constants";

describe("LocalFs", () => {
	function createLocalFs(syncDotPaths: string[] = []): { app: App; vault: App["vault"]; fs: LocalFs } {
		const app = new App();
		const fs = new LocalFs(app, () => syncDotPaths);
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
			const mockFile = new TFile();
			mockFile.path = "a/file.txt";
			mockFile.stat = { size: 5, mtime: 0, ctime: 0 };
			vi.spyOn(vault, "createBinary").mockResolvedValue(mockFile);

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

	// These operations work via the raw vault adapter fallback for paths not
	// in the Obsidian vault index (dot-prefixed paths such as .airsync/).
	describe("delete (adapter fallback)", () => {
		it("deletes a file via adapter.remove", async () => {
			const { vault, fs } = createLocalFs();
			await vault.adapter.writeBinary(`${AIRSYNC_DIR}/logs/test.log`, new ArrayBuffer(8));
			const removeSpy = vi.spyOn(vault.adapter, "remove");

			await fs.delete(`${AIRSYNC_DIR}/logs/test.log`);

			expect(removeSpy).toHaveBeenCalledWith(`${AIRSYNC_DIR}/logs/test.log`);
		});

		it("deletes a directory via adapter.rmdir", async () => {
			const { vault, fs } = createLocalFs();
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(AIRSYNC_DIR, { type: "folder" });
			vaultInternal.files.set(`${AIRSYNC_DIR}/logs`, { type: "folder" });
			vaultInternal.files.set(`${AIRSYNC_DIR}/logs/test.log`, { type: "file", content: new ArrayBuffer(0), mtime: 0 });
			const rmdirSpy = vi.spyOn(vault.adapter, "rmdir");

			await fs.delete(AIRSYNC_DIR);

			expect(rmdirSpy).toHaveBeenCalledWith(AIRSYNC_DIR, true);
		});

		it("is idempotent for non-existent path", async () => {
			const { fs } = createLocalFs();
			await expect(fs.delete(`${AIRSYNC_DIR}/missing`)).resolves.not.toThrow();
		});
	});

	describe("stat (adapter fallback)", () => {
		it("returns FileEntity with hash for a file not in vault index", async () => {
			const { vault, fs } = createLocalFs();
			const content = new TextEncoder().encode("log data").buffer;
			await vault.adapter.writeBinary(`${AIRSYNC_DIR}/logs/test.log`, content);

			const entity = await fs.stat(`${AIRSYNC_DIR}/logs/test.log`);

			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(false);
			expect(entity!.hash).not.toBe("");
			expect(entity!.path).toBe(`${AIRSYNC_DIR}/logs/test.log`);
		});

		it("returns FileEntity for a directory not in vault index", async () => {
			const { vault, fs } = createLocalFs();
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(AIRSYNC_DIR, { type: "folder" });

			const entity = await fs.stat(AIRSYNC_DIR);

			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(true);
		});

		it("returns null for non-existent path", async () => {
			const { fs } = createLocalFs();
			const entity = await fs.stat(`${AIRSYNC_DIR}/missing`);
			expect(entity).toBeNull();
		});
	});

	describe("read (adapter fallback)", () => {
		it("reads a file not in vault index via adapter", async () => {
			const { vault, fs } = createLocalFs();
			const content = new TextEncoder().encode("log data").buffer;
			await vault.adapter.writeBinary(`${AIRSYNC_DIR}/test.log`, content);

			const result = await fs.read(`${AIRSYNC_DIR}/test.log`);
			expect(new TextDecoder().decode(result)).toBe("log data");
		});

		it("reads metadata.json written by the remote backend", async () => {
			const { vault, fs } = createLocalFs();
			const metadata = JSON.stringify({ vaultName: "My Vault" });
			await vault.adapter.writeBinary(`${AIRSYNC_DIR}/metadata.json`, new TextEncoder().encode(metadata).buffer);

			const result = await fs.read(`${AIRSYNC_DIR}/metadata.json`);
			expect(new TextDecoder().decode(result)).toBe(metadata);
		});

		it("throws for non-existent file", async () => {
			const { fs } = createLocalFs();
			await expect(fs.read(`${AIRSYNC_DIR}/missing`)).rejects.toThrow(`File not found: ${AIRSYNC_DIR}/missing`);
		});
	});

	describe("write (adapter fallback)", () => {
		it("writes a dot-prefixed file via adapter", async () => {
			const { vault, fs } = createLocalFs();
			const content = new TextEncoder().encode("data").buffer;

			const entity = await fs.write(`${AIRSYNC_DIR}/test.log`, content, 12345);

			expect(entity.isDirectory).toBe(false);
			expect(entity.path).toBe(`${AIRSYNC_DIR}/test.log`);
			expect(entity.hash).not.toBe("");
			expect(await vault.adapter.exists(`${AIRSYNC_DIR}/test.log`)).toBe(true);
		});
	});

	describe("syncDotPaths", () => {
		it("does not include .airsync in list() with default settings", async () => {
			const { vault, fs } = createLocalFs(); // no syncDotPaths
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(AIRSYNC_DIR, { type: "folder" });
			vaultInternal.files.set(`${AIRSYNC_DIR}/logs/device/2024-01-01.log`, {
				type: "file",
				content: new ArrayBuffer(100),
				mtime: 100,
			});

			const paths = (await fs.list()).map((e) => e.path);
			expect(paths).not.toContain(AIRSYNC_DIR);
			expect(paths).not.toContain(`${AIRSYNC_DIR}/logs/device/2024-01-01.log`);
		});

		it("includes .airsync in list() when added to syncDotPaths", async () => {
			const { vault, fs } = createLocalFs([AIRSYNC_DIR]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(AIRSYNC_DIR, { type: "folder" });
			vaultInternal.files.set(`${AIRSYNC_DIR}/logs`, { type: "folder" });
			vaultInternal.files.set(`${AIRSYNC_DIR}/logs/device`, { type: "folder" });
			vaultInternal.files.set(`${AIRSYNC_DIR}/logs/device/2024-01-01.log`, {
				type: "file",
				content: new ArrayBuffer(100),
				mtime: 100,
			});

			const paths = (await fs.list()).map((e) => e.path);
			expect(paths).toContain(`${AIRSYNC_DIR}/logs/device/2024-01-01.log`);
		});

		it("includes custom dot paths in list()", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".templates", { type: "folder" });
			vaultInternal.files.set(".templates/daily.md", {
				type: "file",
				content: new TextEncoder().encode("template").buffer,
				mtime: 100,
			});

			const entities = await fs.list();
			const paths = entities.map((e) => e.path);
			expect(paths).toContain(".templates/daily.md");
		});

		it("stat works for custom dot path files", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const content = new TextEncoder().encode("data").buffer;
			await vault.adapter.writeBinary(".templates/note.md", content);

			const entity = await fs.stat(".templates/note.md");
			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(false);
			expect(entity!.hash).not.toBe("");
		});

		it("read works for custom dot path files", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const content = new TextEncoder().encode("hello").buffer;
			await vault.adapter.writeBinary(".templates/note.md", content);

			const result = await fs.read(".templates/note.md");
			expect(new TextDecoder().decode(result)).toBe("hello");
		});

		it("write works for custom dot path files", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const content = new TextEncoder().encode("data").buffer;

			const entity = await fs.write(".templates/note.md", content, 12345);
			expect(entity.path).toBe(".templates/note.md");
			expect(await vault.adapter.exists(".templates/note.md")).toBe(true);
		});

		it("delete works for custom dot path files", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			await vault.adapter.writeBinary(".templates/note.md", new ArrayBuffer(0));

			await fs.delete(".templates/note.md");
			expect(await vault.adapter.exists(".templates/note.md")).toBe(false);
		});

		it("listDir works for custom dot path", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".templates", { type: "folder" });
			vaultInternal.files.set(".templates/daily.md", {
				type: "file",
				content: new ArrayBuffer(5),
				mtime: 100,
			});

			const entities = await fs.listDir(".templates");
			expect(entities.map((e) => e.path)).toContain(".templates/daily.md");
		});

		it("rename works for custom dot path files", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".templates", { type: "folder" });
			const content = new TextEncoder().encode("data").buffer;
			await vault.adapter.writeBinary(".templates/old.md", content);

			await fs.rename(".templates/old.md", ".templates/new.md");

			expect(await vault.adapter.exists(".templates/new.md")).toBe(true);
			expect(await vault.adapter.exists(".templates/old.md")).toBe(false);
		});

		it("does not include dot paths when syncDotPaths is empty", async () => {
			const { vault, fs } = createLocalFs();
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".templates", { type: "folder" });
			vaultInternal.files.set(".templates/daily.md", {
				type: "file",
				content: new ArrayBuffer(5),
				mtime: 100,
			});

			const entities = await fs.list();
			const paths = entities.map((e) => e.path);
			expect(paths).not.toContain(".templates");
			expect(paths).not.toContain(".templates/daily.md");
		});
	});
});
