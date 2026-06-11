import { describe, it, expect } from "vitest";
import { quickXorHashBase64 } from "./quickxor";

/**
 * Golden vectors captured from the LIVE Microsoft Graph API (personal OneDrive)
 * via the opt-in e2e creds: each `content` was uploaded, then its
 * `file.hashes.quickXorHash` read back. The local implementation MUST reproduce
 * these exactly, or cross-side dedup (digest === remoteChecksum.value) silently
 * fails against real OneDrive. Regenerate with the probe in docs/e2e-testing if
 * Microsoft ever changes the algorithm (they have not since its publication).
 */

/** Regenerate a deterministic sample identically to how the golden was produced. */
function sample(kind: "text" | "ramp" | "lcg", n: number): ArrayBuffer {
	if (kind === "text") return new TextEncoder().encode("hello sha1 casing probe").buffer as ArrayBuffer;
	const b = new Uint8Array(n);
	if (kind === "ramp") for (let i = 0; i < n; i++) b[i] = i & 0xff;
	else for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
	return b.buffer;
}

const GOLDEN: Array<[string, ArrayBuffer, string]> = [
	["text 23B", sample("text", 0), "qSVkG9ns4uDKMJlgnwEIxhCGOaQ="],
	["ramp 1B", sample("ramp", 1), "AAAAAAAAAAAAAAAAAQAAAAAAAAA="],
	["ramp 200B", sample("ramp", 200), "4wTRmVq14WTAStOsg6tbwZMFVT0="],
	["ramp 4096B", sample("ramp", 4096), "QkGEfSisZcA7k+FCh6xr2dbCayY="],
	["lcg 1000B", sample("lcg", 1000), "X4X7cC7/cVgPZMrjju+fOUsa7aY="],
];

describe("quickXorHashBase64", () => {
	for (const [name, content, expected] of GOLDEN) {
		it(`matches live Graph quickXorHash for ${name}`, () => {
			expect(quickXorHashBase64(content)).toBe(expected);
		});
	}

	it("is deterministic and content-sensitive", () => {
		const a = sample("ramp", 200);
		const b = sample("lcg", 200);
		expect(quickXorHashBase64(a)).toBe(quickXorHashBase64(a));
		expect(quickXorHashBase64(a)).not.toBe(quickXorHashBase64(b));
	});
});
