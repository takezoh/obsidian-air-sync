import { describe, it, expect } from "vitest";
import { encodeContent, decodeContent } from "./content-codec";

function toBuf(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer;
}
function toText(buf: ArrayBuffer): string {
	return new TextDecoder().decode(buf);
}

describe("content-codec", () => {
	it("round-trips text content", () => {
		const text = "# Title\n\nSome markdown body with **bold** and a list:\n- a\n- b\n";
		const decoded = decodeContent(encodeContent(toBuf(text)));
		expect(toText(decoded)).toBe(text);
	});

	it("compresses repetitive text below its original size (FORMAT_DEFLATE)", () => {
		const text = "the quick brown fox ".repeat(500); // highly compressible
		const original = toBuf(text);
		const encoded = encodeContent(original);
		expect(encoded.byteLength).toBeLessThan(original.byteLength);
		expect(new Uint8Array(encoded)[0]).toBe(0x01); // FORMAT_DEFLATE
		expect(toText(decodeContent(encoded))).toBe(text);
	});

	it("stores tiny/incompressible input raw (FORMAT_RAW) and round-trips", () => {
		const original = toBuf("hi"); // too small for deflate to help
		const encoded = encodeContent(original);
		expect(new Uint8Array(encoded)[0]).toBe(0x00); // FORMAT_RAW
		expect(toText(decodeContent(encoded))).toBe("hi");
	});

	it("is binary-safe (handles arbitrary bytes incl. 0x00)", () => {
		const bytes = new Uint8Array([0, 1, 2, 255, 0, 128, 64, 0]);
		const decoded = new Uint8Array(decodeContent(encodeContent(bytes.buffer)));
		expect(Array.from(decoded)).toEqual(Array.from(bytes));
	});

	it("round-trips empty content", () => {
		const decoded = decodeContent(encodeContent(new ArrayBuffer(0)));
		expect(decoded.byteLength).toBe(0);
	});

	it("throws on an unknown format byte", () => {
		const bad = new Uint8Array([0x7f, 1, 2, 3]).buffer;
		expect(() => decodeContent(bad)).toThrow(/Unknown content codec format/);
	});
});
