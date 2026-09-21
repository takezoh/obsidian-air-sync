import { describe, expect, it } from "vitest";
import { createChecksumRegistry } from "../../src/fs/modules/checksum-registry";

function bytes(text: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(text);
	return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

describe("ChecksumRegistry", () => {
	it("registers the core algorithms and computes their vectors", async () => {
		const registry = createChecksumRegistry();
		for (const id of ["sha256", "sha1", "md5", "dropbox", "quickxor"]) {
			expect(registry.has(id)).toBe(true);
		}
		expect(await registry.compute(bytes("abc"), "sha256")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(await registry.compute(bytes("abc"), "sha1")).toBe(
			"a9993e364706816aba3e25717850c26c9cd0d89d",
		);
		expect(await registry.compute(bytes("abc"), "md5")).toBe("900150983cd24fb0d6963f7d28e17f72");
	});

	it("treats an empty dropbox hash as sha256 of the empty concatenation", async () => {
		const registry = createChecksumRegistry();
		expect(await registry.compute(bytes(""), "dropbox")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it("fails closed for an unregistered algorithm", async () => {
		const registry = createChecksumRegistry();
		expect(registry.has("opaque")).toBe(false);
		await expect(registry.compute(bytes("x"), "opaque")).rejects.toThrow(/Unsupported/);
	});

	it("uses a module-provided digest without a core switch", async () => {
		const registry = createChecksumRegistry();
		registry.register({ id: "fakebackend:length", digest: (content) => Promise.resolve(String(content.byteLength)) });
		expect(registry.has("fakebackend:length")).toBe(true);
		expect(await registry.compute(bytes("abcd"), "fakebackend:length")).toBe("4");
	});

	it("refuses to override a reserved id or double-register", () => {
		const registry = createChecksumRegistry();
		expect(() => registry.register({ id: "sha256", digest: () => Promise.resolve("x") })).toThrow(/reserved/);
		registry.register({ id: "fakebackend:x", digest: () => Promise.resolve("x") });
		expect(() => registry.register({ id: "fakebackend:x", digest: () => Promise.resolve("y") })).toThrow(
			/already registered/,
		);
	});
});
