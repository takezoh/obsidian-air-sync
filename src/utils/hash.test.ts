import { describe, it, expect } from "vitest";
import { sha1, sha256, digest, dropboxContentHash, isLocallyComputable } from "./hash";
import { quickXorHashBase64 } from "./quickxor";

function buf(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

/** 4 MiB — the Dropbox content-hash block size. */
const DROPBOX_BLOCK = 4 * 1024 * 1024;

/** Build an ArrayBuffer of `len` bytes all set to `byte`. */
function filled(len: number, byte: number): ArrayBuffer {
	return new Uint8Array(len).fill(byte).buffer;
}

describe("hash utils", () => {
	it("sha1 matches known vectors", async () => {
		expect(await sha1(buf(""))).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
		expect(await sha1(buf("abc"))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
	});

	it("digest dispatches by algorithm", async () => {
		expect(await digest(buf("abc"), "md5")).toBe("900150983cd24fb0d6963f7d28e17f72");
		expect(await digest(buf("abc"), "sha1")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
		expect(await digest(buf("abc"), "sha256")).toBe(await sha256(buf("abc")));
		expect(await digest(buf("abc"), "dropbox")).toBe(await dropboxContentHash(buf("abc")));
		expect(await digest(buf("abc"), "quickxor")).toBe(quickXorHashBase64(buf("abc")));
	});

	it("digest throws for opaque (not locally computable)", async () => {
		await expect(digest(buf("abc"), "opaque")).rejects.toThrow();
	});

	it("isLocallyComputable is false only for opaque", () => {
		expect(isLocallyComputable("md5")).toBe(true);
		expect(isLocallyComputable("sha1")).toBe(true);
		expect(isLocallyComputable("sha256")).toBe(true);
		expect(isLocallyComputable("dropbox")).toBe(true);
		expect(isLocallyComputable("quickxor")).toBe(true);
		expect(isLocallyComputable("opaque")).toBe(false);
	});
});

describe("dropboxContentHash", () => {
	// An empty file hashes the empty block-digest concatenation, i.e. sha256("").
	it("hashes an empty file as sha256 of empty", async () => {
		expect(await dropboxContentHash(buf(""))).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(await dropboxContentHash(buf(""))).toBe(await sha256(buf("")));
	});

	// A <4 MiB file is one block: sha256(sha256(content).digest()). Pinned vector.
	it("hashes a sub-block file as a single-block tree", async () => {
		expect(await dropboxContentHash(buf("abc"))).toBe(
			"4f8b42c22dd3729b519ba6f68d2da7cc5b2d606d05daed5ad5128cc03e6c6358",
		);
	});

	// One block whose length is exactly the block size stays a single block.
	it("hashes an exactly-one-block file", async () => {
		expect(await dropboxContentHash(filled(DROPBOX_BLOCK, 0x61))).toBe(
			"907a506cf5e706bda5c7a29b43c9c65d8344bd2fa2f22339b359c214812af5a1",
		);
	});

	// Crossing the 4 MiB boundary produces a multi-block tree. Pinned vector for
	// 4 MiB of 'a' followed by 100 'b'.
	it("hashes a multi-block file across the 4 MiB boundary", async () => {
		const data = new Uint8Array(DROPBOX_BLOCK + 100);
		data.fill(0x61, 0, DROPBOX_BLOCK);
		data.fill(0x62, DROPBOX_BLOCK);
		expect(await dropboxContentHash(data.buffer)).toBe(
			"02155e86ebc2babf5adb548bc0eff2e56e21d395499e5977cd8e7a27738d4cc9",
		);
	});
});
