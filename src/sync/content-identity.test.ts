import { describe, it, expect } from "vitest";
import { contentKey, checksumsEqual, sameContent, sameSynchronizedContent } from "./content-identity";
import type { SyncRecord } from "./types";
import type { FileEntity } from "../fs/types";

function entity(overrides: Partial<FileEntity> = {}): FileEntity {
	return {
		path: "f.md",
		isDirectory: false,
		size: 100,
		mtime: 1000,
		hash: "",
		...overrides,
	};
}

describe("contentKey", () => {
	it("prefers the SHA-256 hash when present", () => {
		expect(contentKey(entity({ hash: "abc" }))).toEqual({ algo: "sha256", value: "abc" });
	});

	it("falls back to remoteChecksum when hash is empty", () => {
		expect(
			contentKey(entity({ hash: "", remoteChecksum: { algo: "md5", value: "m1" } })),
		).toEqual({ algo: "md5", value: "m1" });
	});

	it("hash wins over remoteChecksum when both are present", () => {
		expect(
			contentKey(entity({ hash: "abc", remoteChecksum: { algo: "md5", value: "m1" } })),
		).toEqual({ algo: "sha256", value: "abc" });
	});

	it("returns null when neither hash nor remoteChecksum is available", () => {
		expect(contentKey(entity({ hash: "" }))).toBeNull();
	});
});

describe("checksumsEqual", () => {
	it("equal when algorithm and value both match", () => {
		expect(checksumsEqual({ algo: "md5", value: "x" }, { algo: "md5", value: "x" })).toBe(true);
	});

	it("not equal when values differ", () => {
		expect(checksumsEqual({ algo: "md5", value: "x" }, { algo: "md5", value: "y" })).toBe(false);
	});

	it("not equal across algorithms even if the value strings coincide", () => {
		expect(checksumsEqual({ algo: "md5", value: "x" }, { algo: "sha256", value: "x" })).toBe(false);
	});
});

describe("sameContent", () => {
	it("matches two SHA-256 hashes", () => {
		expect(sameContent(entity({ hash: "h" }), entity({ hash: "h" }))).toBe(true);
	});

	it("matches a local hash against a same-algo remoteChecksum (remote hash empty)", () => {
		// A backend that returns hash:"" but a sha256 remoteChecksum equal to the
		// local hash provably holds identical content.
		expect(
			sameContent(
				entity({ hash: "h" }),
				entity({ hash: "", remoteChecksum: { algo: "sha256", value: "h" } }),
			),
		).toBe(true);
	});

	it("does NOT match across algorithms (local sha256 vs remote md5)", () => {
		expect(
			sameContent(
				entity({ hash: "h" }),
				entity({ hash: "", remoteChecksum: { algo: "md5", value: "h" } }),
			),
		).toBe(false);
	});

	it("does NOT match when either side has no content key", () => {
		expect(sameContent(entity({ hash: "" }), entity({ hash: "h" }))).toBe(false);
		expect(sameContent(entity({ hash: "h" }), entity({ hash: "" }))).toBe(false);
	});

	it("ignores size — content identity is checksum-only", () => {
		expect(sameContent(entity({ hash: "h", size: 1 }), entity({ hash: "h", size: 999 }))).toBe(true);
	});
});

describe("sameSynchronizedContent", () => {
	const baseline: SyncRecord = {
		path: "old.md", hash: "local-sha", localMtime: 1000, remoteMtime: 1000,
		localSize: 100, remoteSize: 100, syncedAt: 1000,
		remoteChecksum: { algo: "md5", value: "provider-md5" },
	};
	const local = entity({ path: "new.md", hash: "local-sha" });
	const remote = entity({ path: "old.md", remoteChecksum: { algo: "md5", value: "provider-md5" } });

	it("uses independently matching committed fingerprints without equating their algorithms", () => {
		expect(sameContent(local, remote)).toBe(false);
		expect(sameSynchronizedContent(local, remote, baseline)).toBe(true);
	});

	it.each([
		{ hash: "changed" }, { hash: "" }, { size: 99 },
	])("rejects changed or unproven local content %o", (changed) => {
		expect(sameSynchronizedContent({ ...local, ...changed }, remote, baseline)).toBe(false);
	});

	it.each<Partial<FileEntity>>([
		{ remoteChecksum: undefined },
		{ remoteChecksum: { algo: "md5", value: "changed" } },
		{ remoteChecksum: { algo: "sha1", value: "provider-md5" } },
		{ hash: "contradictory-current-sha" },
		{ size: 99 },
	])("rejects changed or unproven remote content %o", (changed) => {
		expect(sameSynchronizedContent(local, { ...remote, ...changed }, baseline)).toBe(false);
	});

	it("does not substitute matching metadata for a missing committed content proof", () => {
		expect(sameSynchronizedContent(local, remote)).toBe(false);
		expect(sameSynchronizedContent(local, remote, { ...baseline, remoteChecksum: undefined })).toBe(false);
		expect(sameSynchronizedContent(local, remote, { ...baseline, remoteSize: 99 })).toBe(false);
	});
});
