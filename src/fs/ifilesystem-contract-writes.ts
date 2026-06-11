import { describe, it, expect } from "vitest";
import { bytes, decode } from "./ifilesystem-contract";
import type { IFileSystemContractCtx } from "./ifilesystem-contract";

/**
 * The write-side and structural half of the {@link runIFileSystemContract} suite:
 * write / delete / mkdir, path normalization, listDir, and snapshot isolation.
 * Split out of `ifilesystem-contract.ts` purely to stay under the per-module line
 * cap; it registers under the same `describe` via the shared context. See that
 * file's header for the contract's rationale and scope.
 */
export function registerWriteContract(ctx: IFileSystemContractCtx): void {
	const { seed, exists, readText } = ctx;

	describe("write", () => {
		it("creates a new file and returns FileEntity with hash", async () => {
			const entity = await ctx.fs().write("a.txt", bytes("hello"), 1000);
			expect(entity.isDirectory).toBe(false);
			// write() always returns a content hash, even for remote backends — it
			// just hashed the bytes it received (unlike stat(), which would have to
			// download them).
			expect(entity.hash).not.toBe("");
			expect(await readText("a.txt")).toBe("hello");
		});

		it("overwrites existing file", async () => {
			await seed("a.txt", "old");
			await ctx.fs().write("a.txt", bytes("new"), 1000);
			expect(await readText("a.txt")).toBe("new");
		});

		it("returns the new size and mtime when overwriting", async () => {
			// The returned entity must reflect the just-written bytes, not the
			// pre-overwrite state — a backend that hands back a stale TFile/stat
			// would re-baseline against the wrong size/mtime.
			await seed("a.txt", "old", 1000);
			const entity = await ctx.fs().write("a.txt", bytes("a longer body"), 2000);
			expect(entity.size).toBe(
				new TextEncoder().encode("a longer body").byteLength,
			);
			ctx.expectMtime(entity.mtime, 2000);
		});

		it("creates parent directories automatically", async () => {
			await ctx.fs().write("a/b/c.txt", bytes("data"), 1000);
			expect(await exists("a")).toBe(true);
			expect(await exists("a/b")).toBe(true);
			expect(await readText("a/b/c.txt")).toBe("data");
		});

		it("throws when writing to an existing directory", async () => {
			await ctx.fs().mkdir("dir");
			await expect(
				ctx.fs().write("dir", bytes("data"), 1000),
			).rejects.toThrow(
				'Cannot write file: "dir" is an existing directory',
			);
		});

		it("uses provided mtime", async () => {
			const entity = await ctx.fs().write("a.txt", bytes("data"), 12345);
			ctx.expectMtime(entity.mtime, 12345);
		});
	});

	describe("delete", () => {
		it("deletes a file", async () => {
			await seed("a.txt", "hello");
			await ctx.fs().delete("a.txt");
			expect(await exists("a.txt")).toBe(false);
		});

		it("deletes a directory and all children", async () => {
			await seed("dir/a.txt", "aaa");
			await seed("dir/sub/b.txt", "bbb");
			await ctx.fs().delete("dir");
			expect(await exists("dir")).toBe(false);
			expect(await exists("dir/a.txt")).toBe(false);
			expect(await exists("dir/sub/b.txt")).toBe(false);
		});

		it("is idempotent for non-existent path", async () => {
			await expect(ctx.fs().delete("missing")).resolves.not.toThrow();
		});

		it("does not affect entries sharing a prefix", async () => {
			await seed("dir/a.txt", "aaa");
			await seed("dir-extra/b.txt", "bbb");
			await ctx.fs().delete("dir");
			expect(await readText("dir-extra/b.txt")).toBe("bbb");
		});
	});

	describe("mkdir", () => {
		it("creates a directory", async () => {
			await ctx.fs().mkdir("a");
			const entity = await ctx.fs().stat("a");
			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(true);
		});

		it("creates intermediate directories", async () => {
			await ctx.fs().mkdir("a/b/c");
			expect(await exists("a")).toBe(true);
			expect(await exists("a/b")).toBe(true);
			expect(await exists("a/b/c")).toBe(true);
		});

		it("is idempotent for existing directories", async () => {
			await ctx.fs().mkdir("a/b");
			await expect(ctx.fs().mkdir("a/b")).resolves.not.toThrow();
		});

		it("throws if an intermediate path is a file", async () => {
			await seed("a/b", "file-content");
			await expect(ctx.fs().mkdir("a/b/c")).rejects.toThrow(
				'Cannot create directory "a/b/c": "a/b" is a file',
			);
		});

		it("throws if the target path itself is a file", async () => {
			await seed("x", "file");
			await expect(ctx.fs().mkdir("x")).rejects.toThrow(
				'Cannot create directory "x": "x" is a file',
			);
		});
	});

	describe("path normalization", () => {
		it("stat with trailing slash", async () => {
			await seed("a.txt", "hello");
			const entity = await ctx.fs().stat("a.txt/");
			expect(entity).not.toBeNull();
			expect(entity!.path).toBe("a.txt");
		});

		it("stat with leading slash", async () => {
			await seed("a.txt", "hello");
			expect(await ctx.fs().stat("/a.txt")).not.toBeNull();
		});

		it("read with backslash path", async () => {
			await seed("dir/a.txt", "hello");
			expect(decode(await ctx.fs().read("dir\\a.txt"))).toBe("hello");
		});

		it("write with double slash", async () => {
			await ctx.fs().write("dir//a.txt", bytes("data"), 100);
			expect(await readText("dir/a.txt")).toBe("data");
		});

		it("delete with leading slash", async () => {
			await seed("a.txt", "hello");
			await ctx.fs().delete("/a.txt");
			expect(await exists("a.txt")).toBe(false);
		});
	});

	describe("listDir", () => {
		it("returns immediate children only", async () => {
			await seed("dir/a.txt", "aaa");
			await seed("dir/b.txt", "bbb");
			await seed("dir/sub/c.txt", "ccc");
			const paths = (await ctx.fs().listDir("dir"))
				.map((c) => c.path)
				.sort();
			expect(paths).toEqual(["dir/a.txt", "dir/b.txt", "dir/sub"]);
		});

		it("returns empty array for empty directory", async () => {
			await ctx.fs().mkdir("empty");
			expect(await ctx.fs().listDir("empty")).toEqual([]);
		});

		it("returns empty array for non-existent directory", async () => {
			expect(await ctx.fs().listDir("nope")).toEqual([]);
		});
	});

	// Real backends own their stored bytes and build a fresh FileEntity per call,
	// so a caller can never reach back through a returned value and mutate storage.
	describe("snapshot isolation (backend fidelity)", () => {
		it("write() does not alias the caller's buffer", async () => {
			const buf = bytes("original");
			await ctx.fs().write("a.txt", buf, 1000);
			new Uint8Array(buf).fill(0); // mutate the caller's buffer after writing
			expect(await readText("a.txt")).toBe("original");
		});

		it("read() returns a detached copy each call", async () => {
			await seed("a.txt", "data");
			const first = await ctx.fs().read("a.txt");
			new Uint8Array(first).fill(0);
			expect(await readText("a.txt")).toBe("data");
		});

		it("list()/stat() return snapshots that cannot mutate stored state", async () => {
			await seed("a.txt", "data", 1000);
			const listed = (await ctx.fs().list()).find(
				(e) => e.path === "a.txt",
			)!;
			listed.mtime = 99999;
			listed.hash = "tampered";
			const fresh = await ctx.fs().stat("a.txt");
			ctx.expectMtime(fresh!.mtime, 1000);
			expect(fresh!.mtime).not.toBe(99999); // the tampered value must not have leaked
			expect(fresh!.hash).not.toBe("tampered");
		});
	});
}
