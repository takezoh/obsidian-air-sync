import { describe, it, expect } from "vitest";
import { Vault } from "obsidian";
import { DotPathAdapter } from "./dot-path-adapter";

function createAdapter(dotRoots: string[] = [".smartsync"]): {
	vault: Vault;
	adapter: DotPathAdapter;
} {
	const vault = new Vault();
	const mkdirFn = async (path: string) => {
		if (!(await vault.adapter.exists(path))) {
			await vault.createFolder(path);
		}
	};
	const adapter = new DotPathAdapter(vault, mkdirFn, () => dotRoots);
	return { vault, adapter };
}

describe("DotPathAdapter", () => {
	describe("isDotPath", () => {
		it("matches a single root", () => {
			const { adapter } = createAdapter([".smartsync"]);
			expect(adapter.isDotPath(".smartsync")).toBe(true);
			expect(adapter.isDotPath(".smartsync/logs")).toBe(true);
			expect(adapter.isDotPath("notes")).toBe(false);
		});

		it("matches multiple roots", () => {
			const { adapter } = createAdapter([".smartsync", ".templates"]);
			expect(adapter.isDotPath(".smartsync")).toBe(true);
			expect(adapter.isDotPath(".smartsync/logs")).toBe(true);
			expect(adapter.isDotPath(".templates")).toBe(true);
			expect(adapter.isDotPath(".templates/daily.md")).toBe(true);
			expect(adapter.isDotPath(".other")).toBe(false);
		});

		it("does not match partial prefix", () => {
			const { adapter } = createAdapter([".smart"]);
			expect(adapter.isDotPath(".smartsync")).toBe(false);
			expect(adapter.isDotPath(".smart")).toBe(true);
			expect(adapter.isDotPath(".smart/file")).toBe(true);
		});
	});

	describe("listAll", () => {
		it("lists files from all dot roots", async () => {
			const { vault, adapter } = createAdapter([".smartsync", ".templates"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".smartsync", { type: "folder" });
			vaultInternal.files.set(".smartsync/state.json", {
				type: "file",
				content: new ArrayBuffer(10),
				mtime: 100,
			});
			vaultInternal.files.set(".templates", { type: "folder" });
			vaultInternal.files.set(".templates/daily.md", {
				type: "file",
				content: new ArrayBuffer(20),
				mtime: 200,
			});

			const entities: { path: string; isDirectory: boolean }[] = [];
			await adapter.listAll(entities as never);

			const paths = entities.map((e) => e.path);
			expect(paths).toContain(".smartsync/state.json");
			expect(paths).toContain(".templates/daily.md");
		});

		it("skips roots that do not exist", async () => {
			const { adapter } = createAdapter([".smartsync", ".missing"]);
			const entities: { path: string }[] = [];
			await adapter.listAll(entities as never);
			expect(entities).toHaveLength(0);
		});
	});

	describe("listDir", () => {
		it("lists direct children of a dot path", async () => {
			const { vault, adapter } = createAdapter([".templates"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".templates", { type: "folder" });
			vaultInternal.files.set(".templates/sub", { type: "folder" });
			vaultInternal.files.set(".templates/daily.md", {
				type: "file",
				content: new ArrayBuffer(5),
				mtime: 100,
			});
			// Nested file should not appear (not a direct child)
			vaultInternal.files.set(".templates/sub/nested.md", {
				type: "file",
				content: new ArrayBuffer(5),
				mtime: 100,
			});

			const entities = await adapter.listDir(".templates");
			const paths = entities.map((e) => e.path);
			expect(paths).toContain(".templates/sub");
			expect(paths).toContain(".templates/daily.md");
			expect(paths).not.toContain(".templates/sub/nested.md");
		});

		it("returns empty array for non-existent path", async () => {
			const { adapter } = createAdapter([".templates"]);
			const entities = await adapter.listDir(".templates");
			expect(entities).toHaveLength(0);
		});
	});

	describe("rename", () => {
		it("renames a file within a dot path", async () => {
			const { vault, adapter } = createAdapter([".templates"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".templates", { type: "folder" });
			const content = new TextEncoder().encode("hello").buffer;
			await vault.adapter.writeBinary(".templates/old.md", content);

			await adapter.rename(".templates/old.md", ".templates/new.md");

			expect(await vault.adapter.exists(".templates/new.md")).toBe(true);
			expect(await vault.adapter.exists(".templates/old.md")).toBe(false);
		});

		it("throws for non-existent source", async () => {
			const { adapter } = createAdapter([".templates"]);
			await expect(
				adapter.rename(".templates/missing.md", ".templates/new.md"),
			).rejects.toThrow("File not found");
		});

		it("throws for existing destination", async () => {
			const { vault, adapter } = createAdapter([".templates"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".templates", { type: "folder" });
			const content = new TextEncoder().encode("a").buffer;
			await vault.adapter.writeBinary(".templates/old.md", content);
			await vault.adapter.writeBinary(".templates/new.md", content);

			await expect(
				adapter.rename(".templates/old.md", ".templates/new.md"),
			).rejects.toThrow("Destination already exists");
		});
	});
});
