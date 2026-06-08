import { describe, it, expect, vi } from "vitest";
import { App, TFile, TFolder } from "obsidian";
import { LocalFs } from "./index";

describe("LocalFs", () => {
	function createLocalFs(dotPaths: string[] = []): { app: App; vault: App["vault"]; fs: LocalFs } {
		const app = new App();
		const fs = new LocalFs(app, () => dotPaths);
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

		it("creates hidden parent dirs via the adapter, not the indexed createFolder", async () => {
			// vault.createFolder (indexed) can't reliably create hidden dirs — same
			// failure class as createBinary — so nested hidden parents use adapter.mkdir.
			const { vault, fs } = createLocalFs([".templates"]);
			const mkdirSpy = vi.spyOn(vault.adapter, "mkdir");
			const createFolderSpy = vi.spyOn(vault, "createFolder");

			await fs.write(".templates/sub/x.md", new TextEncoder().encode("x").buffer, 1);

			expect(mkdirSpy).toHaveBeenCalledWith(".templates/sub");
			expect(createFolderSpy).not.toHaveBeenCalled();
			expect(await vault.adapter.exists(".templates/sub/x.md")).toBe(true);
		});
	});

	describe("delete (.airsync paths)", () => {
		it("deletes a .airsync file via adapter.remove", async () => {
			const { vault, fs } = createLocalFs([".airsync"]);
			await vault.adapter.writeBinary(".airsync/logs/test.log", new ArrayBuffer(8));
			const removeSpy = vi.spyOn(vault.adapter, "remove");

			await fs.delete(".airsync/logs/test.log");

			expect(removeSpy).toHaveBeenCalledWith(".airsync/logs/test.log");
		});

		it("deletes a .airsync directory via adapter.rmdir", async () => {
			const { vault, fs } = createLocalFs([".airsync"]);
			// Create a folder with children on the adapter
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".airsync", { type: "folder" });
			vaultInternal.files.set(".airsync/logs", { type: "folder" });
			vaultInternal.files.set(".airsync/logs/test.log", { type: "file", content: new ArrayBuffer(0), mtime: 0 });
			const rmdirSpy = vi.spyOn(vault.adapter, "rmdir");

			await fs.delete(".airsync");

			expect(rmdirSpy).toHaveBeenCalledWith(".airsync", true);
		});

		it("is idempotent for non-existent .airsync path", async () => {
			const { fs } = createLocalFs([".airsync"]);
			await expect(fs.delete(".airsync/missing")).resolves.not.toThrow();
		});
	});

	describe("stat (.airsync paths)", () => {
		it("returns FileEntity with hash for a .airsync file", async () => {
			const { vault, fs } = createLocalFs([".airsync"]);
			const content = new TextEncoder().encode("log data").buffer;
			await vault.adapter.writeBinary(".airsync/logs/test.log", content);

			const entity = await fs.stat(".airsync/logs/test.log");

			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(false);
			expect(entity!.hash).not.toBe("");
			expect(entity!.path).toBe(".airsync/logs/test.log");
		});

		it("returns FileEntity for a .airsync directory", async () => {
			const { vault, fs } = createLocalFs([".airsync"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".airsync", { type: "folder" });

			const entity = await fs.stat(".airsync");

			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(true);
		});

		it("returns null for non-existent .airsync path", async () => {
			const { fs } = createLocalFs([".airsync"]);
			const entity = await fs.stat(".airsync/missing");
			expect(entity).toBeNull();
		});
	});

	describe("stat (adapter fallback for unindexed files)", () => {
		it("finds an on-disk file missing from the vault index", async () => {
			const { vault, fs } = createLocalFs();
			const content = new TextEncoder().encode("hi").buffer;
			await vault.adapter.writeBinary("notes/a.md", content);
			// Simulate the vault index not yet listing the on-disk file.
			vi.spyOn(vault, "getAbstractFileByPath").mockReturnValue(null);

			const entity = await fs.stat("notes/a.md");

			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(false);
			expect(entity!.size).toBe(2);
			expect(entity!.hash).not.toBe("");
		});

		it("returns null for a path absent from both the index and disk", async () => {
			const { vault, fs } = createLocalFs();
			vi.spyOn(vault, "getAbstractFileByPath").mockReturnValue(null);
			expect(await fs.stat("notes/missing.md")).toBeNull();
		});

		it("reads an unindexed dot-path via the adapter regardless of syncDotPaths", async () => {
			// Routing is a mechanism decision (hidden → adapter), not a policy one.
			// Scope (whether to sync it) is enforced separately by orchestrator.isExcluded.
			const { vault, fs } = createLocalFs(); // .hidden not in syncDotPaths
			const content = new TextEncoder().encode("x").buffer;
			await vault.adapter.writeBinary(".hidden/data.json", content);
			const entity = await fs.stat(".hidden/data.json");
			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(false);
			expect(entity!.hash).not.toBe("");
		});
	});

	describe("read (.airsync paths)", () => {
		it("reads a .airsync file via adapter", async () => {
			const { vault, fs } = createLocalFs([".airsync"]);
			const content = new TextEncoder().encode("log data").buffer;
			await vault.adapter.writeBinary(".airsync/test.log", content);

			const result = await fs.read(".airsync/test.log");
			expect(new TextDecoder().decode(result)).toBe("log data");
		});

		it("throws for non-existent .airsync file", async () => {
			const { fs } = createLocalFs([".airsync"]);
			await expect(fs.read(".airsync/missing")).rejects.toThrow("File not found: .airsync/missing");
		});
	});

	describe("write (.airsync paths)", () => {
		it("writes a .airsync file via adapter", async () => {
			const { vault, fs } = createLocalFs([".airsync"]);
			const content = new TextEncoder().encode("data").buffer;

			const entity = await fs.write(".airsync/test.log", content, 12345);

			expect(entity.isDirectory).toBe(false);
			expect(entity.path).toBe(".airsync/test.log");
			expect(entity.hash).not.toBe("");
			expect(await vault.adapter.exists(".airsync/test.log")).toBe(true);
		});
	});

	describe("write routing (mechanism: dot-prefixed → adapter, not vault API)", () => {
		// Real Obsidian's vault.createBinary can't create files in hidden dirs —
		// it returns null (→ NPE on written.stat) or throws "File already exists".
		// Any dot-prefixed path must use adapter.writeBinary, even when it is not a
		// registered syncDotPath (scope is enforced elsewhere).
		it("routes a dot-prefixed path via adapter.writeBinary, never vault.createBinary", async () => {
			const { vault, fs } = createLocalFs(); // empty syncDotPaths
			const writeBinarySpy = vi.spyOn(vault.adapter, "writeBinary");
			const createBinarySpy = vi.spyOn(vault, "createBinary");

			const content = new TextEncoder().encode("log").buffer;
			const entity = await fs.write(".airsync/logs/d/x.log", content, 123);

			expect(writeBinarySpy).toHaveBeenCalled();
			expect(createBinarySpy).not.toHaveBeenCalled();
			expect(entity.path).toBe(".airsync/logs/d/x.log");
			expect(entity.isDirectory).toBe(false);
			expect(await vault.adapter.exists(".airsync/logs/d/x.log")).toBe(true);
		});

		it("overwrites an existing on-disk dot-path without collision", async () => {
			const { vault, fs } = createLocalFs();
			await vault.adapter.writeBinary(
				".airsync/logs/d/x.log",
				new TextEncoder().encode("old").buffer,
			);

			const entity = await fs.write(
				".airsync/logs/d/x.log",
				new TextEncoder().encode("new").buffer,
				5,
			);

			expect(entity.size).toBe(3);
			const onDisk = await vault.adapter.readBinary(".airsync/logs/d/x.log");
			expect(new TextDecoder().decode(onDisk)).toBe("new");
		});

		it("routes a normal path through the indexed vault API", async () => {
			const { vault, fs } = createLocalFs();
			const writeBinarySpy = vi.spyOn(vault.adapter, "writeBinary");
			const createBinarySpy = vi.spyOn(vault, "createBinary");

			await fs.write("notes/a.md", new TextEncoder().encode("hi").buffer, 1);

			expect(createBinarySpy).toHaveBeenCalled();
			expect(writeBinarySpy).not.toHaveBeenCalled();
		});
	});

	describe("syncDotPaths", () => {
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

	describe("rename across the hidden/normal boundary", () => {
		// A cross-regime rename must keep the indexed (normal) side coherent — it is
		// decomposed into regime-aware read/write/delete rather than a single
		// adapter move that would leave the vault index stale.
		it("moves a hidden file to a normal path (new path becomes index-visible)", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			await vault.adapter.writeBinary(
				".templates/a.md",
				new TextEncoder().encode("x").buffer,
			);

			await fs.rename(".templates/a.md", "notes/a.md");

			expect(vault.getAbstractFileByPath("notes/a.md")).toBeInstanceOf(TFile);
			expect(await vault.adapter.exists(".templates/a.md")).toBe(false);
		});

		it("moves a normal file to a hidden path and removes the source", async () => {
			const { app, vault, fs } = createLocalFs([".templates"]);
			await fs.write("notes/a.md", new TextEncoder().encode("y").buffer, 1);
			const trashSpy = vi.spyOn(app.fileManager, "trashFile");

			await fs.rename("notes/a.md", ".templates/a.md");

			expect(await vault.adapter.exists(".templates/a.md")).toBe(true);
			// Source removal goes through the index-aware trashFile; assert the call
			// (the disk-absence side is covered by the shared IFileSystem contract).
			expect(trashSpy).toHaveBeenCalled();
		});

		it("rejects a cross-regime rename when the destination already exists", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			await vault.adapter.writeBinary(
				".templates/a.md",
				new TextEncoder().encode("x").buffer,
			);
			// Occupied normal destination.
			await fs.write("notes/a.md", new TextEncoder().encode("existing").buffer, 1);

			await expect(fs.rename(".templates/a.md", "notes/a.md")).rejects.toThrow(
				/Destination already exists/,
			);
		});

		it("rejects a directory rename across the boundary instead of corrupting the index", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".templates/sub", { type: "folder" });

			await expect(fs.rename(".templates/sub", "notes/sub")).rejects.toThrow(
				/across the hidden\/normal boundary/,
			);
		});
	});
});
