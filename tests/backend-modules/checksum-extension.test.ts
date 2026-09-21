import { describe, expect, it } from "vitest";
import type { FileEntity } from "../../src/fs/types";
import { createChecksumRegistry } from "../../src/fs/modules/checksum-registry";
import { bytesMatch } from "../../src/sync/content-snapshot";

function bytes(text: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(text);
	return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

function entity(checksum: string): FileEntity {
	return {
		path: "note.md",
		isDirectory: false,
		size: 4,
		mtime: 0,
		hash: "",
		remoteChecksum: { algo: "fake:length", value: checksum },
	};
}

describe("T05 extension point — a module digest flows through sync without a core switch", () => {
	it("uses a registered module algorithm to prove content equality", async () => {
		const registry = createChecksumRegistry();
		registry.register({
			id: "fake:length",
			digest: (content) => Promise.resolve(String(content.byteLength)),
		});
		expect(await bytesMatch(bytes("abcd"), entity("4"), registry)).toBe(true);
	});

	it("detects same-size different content via the module digest", async () => {
		const registry = createChecksumRegistry();
		registry.register({
			id: "fake:length",
			// A digest that is sensitive to content, not just size.
			digest: (content) => Promise.resolve(String(new Uint8Array(content)[0])),
		});
		expect(await bytesMatch(bytes("abcd"), entity("97"), registry)).toBe(true);
		// Same size (4) but a different first byte contradicts the observed checksum.
		expect(await bytesMatch(bytes("Xbcd"), entity("97"), registry)).toBe(false);
	});

	it("fails closed for the same entity when the algorithm is not registered", async () => {
		const registry = createChecksumRegistry();
		expect(await bytesMatch(bytes("abcd"), entity("4"), registry)).toBe(false);
	});
});
