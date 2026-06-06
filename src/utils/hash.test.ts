import { describe, it, expect } from "vitest";
import { sha1, sha256, digest, isLocallyComputable } from "./hash";

function buf(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer as ArrayBuffer;
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
	});

	it("digest throws for opaque (not locally computable)", async () => {
		await expect(digest(buf("abc"), "opaque")).rejects.toThrow();
	});

	it("isLocallyComputable is false only for opaque", () => {
		expect(isLocallyComputable("md5")).toBe(true);
		expect(isLocallyComputable("sha1")).toBe(true);
		expect(isLocallyComputable("sha256")).toBe(true);
		expect(isLocallyComputable("opaque")).toBe(false);
	});
});
