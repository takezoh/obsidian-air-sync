import { describe, it, expect } from "vitest";
import { Vault } from "obsidian";
import { DiskSurface } from "./disk-surface";

function createAdapter(dotRoots: string[] = [".airsync"]): {
	vault: Vault;
	adapter: DiskSurface;
} {
	const vault = new Vault();
	const mkdirFn = async (path: string) => {
		if (!(await vault.adapter.exists(path))) {
			await vault.createFolder(path);
		}
	};
	const adapter = new DiskSurface(vault, mkdirFn, () => dotRoots);
	return { vault, adapter };
}

describe("DiskSurface", () => {
	describe("stat", () => {
		it("resolves the actual spelling from the parent listing", async () => {
			const { vault, adapter } = createAdapter();
			await vault.adapter.mkdir(".airsync");
			await vault.adapter.writeBinary(".airsync/a.md", new Uint8Array([1]).buffer);

			const entity = await adapter.stat(".airsync/a.md");

			expect(entity).toMatchObject({
				path: ".airsync/a.md",
				pathAuthority: "actual_resolved",
			});
		});
	});

	describe("hasChildren", () => {
		it("is true for a directory whose only child is dot-prefixed", async () => {
			const { vault, adapter } = createAdapter();
			await vault.adapter.mkdir(".airsync");
			await vault.adapter.writeBinary(".airsync/state.json", new ArrayBuffer(2));

			expect(await adapter.hasChildren(".airsync")).toBe(true);
		});

		it("is false for an empty, missing, or file path", async () => {
			const { vault, adapter } = createAdapter();
			await vault.adapter.mkdir(".airsync");
			await vault.adapter.writeBinary(".airsync/a.md", new ArrayBuffer(1));

			expect(await adapter.hasChildren(".airsync/sub")).toBe(false);
			expect(await adapter.hasChildren(".airsync/missing")).toBe(false);
			expect(await adapter.hasChildren(".airsync/a.md")).toBe(false);
		});
	});

	describe("scanRoots", () => {
		it("marks raw adapter listings as resolved provider paths", async () => {
			const { vault, adapter } = createAdapter();
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".airsync", { type: "folder" });
			vaultInternal.files.set(".airsync/sub", { type: "folder" });
			vaultInternal.files.set(".airsync/a.md", {
				type: "file",
				content: new ArrayBuffer(1),
				mtime: 100,
			});

			const entities: Array<{ pathAuthority?: string }> = [];
			await adapter.scanRoots(entities as never);

			expect(entities).not.toHaveLength(0);
			expect(entities.every((entity) => entity.pathAuthority === "actual_resolved")).toBe(true);
		});

		it("lists files from all dot roots", async () => {
			const { vault, adapter } = createAdapter([".airsync", ".templates"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".airsync", { type: "folder" });
			vaultInternal.files.set(".airsync/state.json", {
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
			await adapter.scanRoots(entities as never);

			const paths = entities.map((e) => e.path);
			expect(paths).toContain(".airsync/state.json");
			expect(paths).toContain(".templates/daily.md");
		});

		it("skips roots that do not exist", async () => {
			const { adapter } = createAdapter([".airsync", ".missing"]);
			const entities: { path: string }[] = [];
			await adapter.scanRoots(entities as never);
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
