import { describe, it, expect, vi } from "vitest";
import { ensureDir } from "./raw-fs";
import type { RawFsAdapter } from "./raw-fs";

function createMockAdapter(existingDirs: Set<string> = new Set()) {
	const mkdir = vi.fn((path: string) => {
		existingDirs.add(path);
		return Promise.resolve();
	});
	const adapter: RawFsAdapter = {
		exists: (path: string) => Promise.resolve(existingDirs.has(path)),
		read: () => Promise.reject(new Error("not used")),
		write: () => Promise.reject(new Error("not used")),
		mkdir,
	};
	return { adapter, mkdir };
}

describe("ensureDir", () => {
	it("creates every missing level of a nested path", async () => {
		const { adapter, mkdir } = createMockAdapter();

		await ensureDir(adapter, "a/b/c");

		expect(mkdir).toHaveBeenCalledTimes(3);
		expect(mkdir).toHaveBeenNthCalledWith(1, "a");
		expect(mkdir).toHaveBeenNthCalledWith(2, "a/b");
		expect(mkdir).toHaveBeenNthCalledWith(3, "a/b/c");
	});

	it("calls mkdir() unconditionally even when exists() reports a directory is already there", async () => {
		// exists() can be stale after an out-of-band deletion (e.g. the user
		// removing .airsync directly on disk). Gating mkdir() on exists() would
		// silently skip recreating a directory that's actually gone.
		const { adapter, mkdir } = createMockAdapter(new Set(["a"]));

		await ensureDir(adapter, "a/b");

		expect(mkdir).toHaveBeenCalledWith("a");
		expect(mkdir).toHaveBeenCalledWith("a/b");
	});

	it("tolerates a mkdir() failure when the directory verifiably exists afterward", async () => {
		const existingDirs = new Set<string>();
		const adapter: RawFsAdapter = {
			exists: (path: string) => Promise.resolve(existingDirs.has(path)),
			read: () => Promise.reject(new Error("not used")),
			write: () => Promise.reject(new Error("not used")),
			mkdir: (path: string) => {
				// Simulate "already exists" -- mkdir() rejects, but the directory
				// is (and remains) genuinely present.
				existingDirs.add(path);
				return Promise.reject(new Error("EEXIST"));
			},
		};

		await expect(ensureDir(adapter, "a")).resolves.toBeUndefined();
	});

	it("surfaces a genuine failure when mkdir() fails and the directory still doesn't exist", async () => {
		const adapter: RawFsAdapter = {
			exists: () => Promise.resolve(false),
			read: () => Promise.reject(new Error("not used")),
			write: () => Promise.reject(new Error("not used")),
			mkdir: () => Promise.reject(new Error("permission denied")),
		};

		await expect(ensureDir(adapter, "a")).rejects.toThrow(/Failed to create directory/);
	});
});
