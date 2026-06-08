import { describe, it, expect, beforeEach } from "vitest";
import type { IFileSystem } from "./interface";
import { registerWriteContract } from "./ifilesystem-contract-writes";

/**
 * Shared {@link IFileSystem} behaviour contract, parameterized over a backend
 * factory. Every backend the sync engine drives — the in-memory `createMockFs`
 * double, the real `LocalFs` (over an Obsidian Vault), and each remote
 * (`GoogleDriveFs`, …) — must satisfy the SAME observable semantics, because the
 * pipeline is written against `IFileSystem` and nothing else. A backend that
 * quietly diverges (skips path normalization, clobbers a rename destination,
 * aliases the caller's buffer, …) breaks sync in ways unit tests on the mock
 * alone never catch. So this suite asserts ONLY through the public interface
 * (`stat`/`read`/`list`/`listDir` for observation, `write`/`mkdir` for seeding) —
 * never a backend's private store — and a new backend runs it in one line.
 *
 * **Scope.** This covers the synchronous CRUD/rename surface. The crash-safe
 * delta/checkpoint machinery (ADR 0001) has its own contract,
 * {@link ../caching/remote-fs-contract.runCachingRemoteFsContract}; the
 * orchestrator-level in-session convergence (state C) is pinned in
 * `orchestrator.test.ts`. A new remote backend runs all three.
 *
 * `opts.computesHashOnStat` is the only backend-class difference here, and it is
 * intrinsic, not a weakness: local-storage backends (mock, LocalFs) compute a
 * content hash on `stat()`, while remote backends return `hash: ""` and carry a
 * `remoteChecksum` instead (see {@link IFileSystem.stat}). Everything else is a
 * universal invariant the engine depends on — including type-collision errors
 * and exact messages, which a backend that omits them must FIX rather than
 * opt out of.
 *
 * The suite is split across two files only to stay under the per-module line cap:
 * read-side/rename cases live here; the write/delete/mkdir/normalization cases
 * live in {@link ./ifilesystem-contract-writes}. Both register under one
 * `describe` via the shared {@link IFileSystemContractCtx}.
 */
export interface IFileSystemContractOpts {
	/**
	 * Whether `stat()` fills `FileEntity.hash` with a real content hash for files.
	 * True for local-storage backends (mock, LocalFs); false for remote backends
	 * that return `hash: ""` plus a `remoteChecksum`. Default: true.
	 */
	computesHashOnStat?: boolean;
}

/**
 * Per-test context handed to each contract registrar. The fs is rebuilt in
 * `beforeEach`, so callers reach it through `fs()` rather than capturing it.
 */
export interface IFileSystemContractCtx {
	/** The freshly-built filesystem for the current test. */
	fs: () => IFileSystem;
	/** Whether `stat()` returns a non-empty content hash for files. */
	computesHashOnStat: boolean;
	/** Seed a file through the public `write()` — every backend's real entry point. */
	seed: (path: string, text: string, mtime?: number) => Promise<void>;
	/** A path exists iff `stat()` resolves to a non-null entity (file OR directory). */
	exists: (path: string) => Promise<boolean>;
	/** Read a path's content as text. */
	readText: (path: string) => Promise<string>;
}

/** Encode text as an ArrayBuffer. */
export function bytes(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** Decode an ArrayBuffer as UTF-8 text. */
export function decode(buf: ArrayBuffer): string {
	return new TextDecoder().decode(buf);
}

export function runIFileSystemContract(
	name: string,
	makeFs: () => IFileSystem | Promise<IFileSystem>,
	opts: IFileSystemContractOpts = {},
): void {
	describe(`IFileSystem contract — ${name}`, () => {
		let current: IFileSystem;

		beforeEach(async () => {
			current = await makeFs();
		});

		const ctx: IFileSystemContractCtx = {
			fs: () => current,
			computesHashOnStat: opts.computesHashOnStat ?? true,
			seed: async (path, text, mtime = 1000) => {
				await current.write(path, bytes(text), mtime);
			},
			exists: async (path) => (await current.stat(path)) !== null,
			readText: async (path) => decode(await current.read(path)),
		};

		registerRenameAndReadContract(ctx);
		registerWriteContract(ctx);
	});
}

/** rename + the read-only observation surface (list / stat / read). */
function registerRenameAndReadContract(ctx: IFileSystemContractCtx): void {
	const { seed, exists, readText } = ctx;

	describe("rename", () => {
		it("renames a single file", async () => {
			await seed("a.txt", "hello");
			await ctx.fs().rename("a.txt", "b.txt");
			expect(await exists("a.txt")).toBe(false);
			expect(await readText("b.txt")).toBe("hello");
		});

		it("renames a directory and all its children", async () => {
			await seed("dir/a.txt", "aaa");
			await seed("dir/sub/b.txt", "bbb");
			await ctx.fs().rename("dir", "renamed");
			expect(await exists("dir")).toBe(false);
			expect(await exists("dir/a.txt")).toBe(false);
			expect(await exists("dir/sub/b.txt")).toBe(false);
			expect(await readText("renamed/a.txt")).toBe("aaa");
			expect(await readText("renamed/sub/b.txt")).toBe("bbb");
			expect(await exists("renamed")).toBe(true);
			expect(await exists("renamed/sub")).toBe(true);
		});

		it("does not affect entries that share a prefix but are not children", async () => {
			await seed("dir-extra/c.txt", "ccc");
			await seed("dir/a.txt", "aaa");
			await ctx.fs().rename("dir", "renamed");
			expect(await readText("dir-extra/c.txt")).toBe("ccc");
		});

		it("throws when source does not exist", async () => {
			await expect(ctx.fs().rename("missing", "dest")).rejects.toThrow(
				"File not found: missing",
			);
		});

		it("throws when destination already exists", async () => {
			await seed("a.txt", "aaa");
			await seed("b.txt", "bbb");
			await expect(ctx.fs().rename("a.txt", "b.txt")).rejects.toThrow(
				"Destination already exists: b.txt",
			);
		});

		it("throws when renaming to itself", async () => {
			await seed("a.txt", "hello");
			await expect(ctx.fs().rename("a.txt", "a.txt")).rejects.toThrow(
				'Cannot rename "a.txt" to itself',
			);
		});

		it("throws when moving into own subtree", async () => {
			await seed("dir/a.txt", "aaa");
			await expect(ctx.fs().rename("dir", "dir/sub")).rejects.toThrow(
				'Cannot move "dir" into its own subtree "dir/sub"',
			);
		});

		it("creates parent directories for new path", async () => {
			await seed("a.txt", "hello");
			await ctx.fs().rename("a.txt", "new-dir/sub/b.txt");
			expect(await exists("new-dir")).toBe(true);
			expect(await exists("new-dir/sub")).toBe(true);
			expect(await readText("new-dir/sub/b.txt")).toBe("hello");
		});

		it("preserves file content and mtime through rename", async () => {
			await seed("old.txt", "content", 12345);
			await ctx.fs().rename("old.txt", "new.txt");
			const entity = await ctx.fs().stat("new.txt");
			expect(entity).not.toBeNull();
			expect(entity!.mtime).toBe(12345);
			expect(await readText("new.txt")).toBe("content");
		});
	});

	describe("list", () => {
		it("returns all seeded files and directories", async () => {
			await seed("a.txt", "aaa");
			await seed("dir/b.txt", "bbb");
			const paths = (await ctx.fs().list())
				.map((e) => e.path)
				.sort();
			expect(paths).toContain("a.txt");
			expect(paths).toContain("dir");
			expect(paths).toContain("dir/b.txt");
		});

		it("returns empty array when no files exist", async () => {
			expect(await ctx.fs().list()).toEqual([]);
		});

		it("returns hash as empty string for performance", async () => {
			await seed("a.txt", "hello");
			const file = (await ctx.fs().list()).find((e) => e.path === "a.txt");
			expect(file!.hash).toBe("");
		});

		it("returns correct size and mtime", async () => {
			await seed("a.txt", "hello", 99999);
			const file = (await ctx.fs().list()).find((e) => e.path === "a.txt");
			expect(file!.mtime).toBe(99999);
			expect(file!.size).toBe(
				new TextEncoder().encode("hello").byteLength,
			);
		});
	});

	describe("stat", () => {
		it("returns FileEntity for an existing file", async () => {
			await seed("a.txt", "hello");
			const entity = await ctx.fs().stat("a.txt");
			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(false);
			// Local-storage backends hash on stat; remotes carry a remoteChecksum
			// instead and report hash "" (see IFileSystem.stat).
			if (ctx.computesHashOnStat) {
				expect(entity!.hash).not.toBe("");
			} else {
				expect(entity!.hash).toBe("");
			}
		});

		it("returns FileEntity for a directory", async () => {
			await ctx.fs().mkdir("dir");
			const entity = await ctx.fs().stat("dir");
			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(true);
			expect(entity!.hash).toBe("");
		});

		it("returns null for non-existent path", async () => {
			expect(await ctx.fs().stat("missing")).toBeNull();
		});
	});

	describe("read", () => {
		it("returns file content as ArrayBuffer", async () => {
			await seed("a.txt", "hello");
			expect(decode(await ctx.fs().read("a.txt"))).toBe("hello");
		});

		it("returns a copy (not the original buffer)", async () => {
			await seed("a.txt", "hello");
			const buf1 = await ctx.fs().read("a.txt");
			const buf2 = await ctx.fs().read("a.txt");
			expect(buf1).not.toBe(buf2);
		});

		it("throws for non-existent file", async () => {
			await expect(ctx.fs().read("missing")).rejects.toThrow(
				"File not found: missing",
			);
		});

		it("throws for a directory with distinct message", async () => {
			await ctx.fs().mkdir("dir");
			await expect(ctx.fs().read("dir")).rejects.toThrow(
				"Not a file (is a directory): dir",
			);
		});
	});
}
