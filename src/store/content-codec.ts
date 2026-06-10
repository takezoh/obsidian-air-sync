import { deflateSync, inflateSync } from "fflate";

/**
 * Codec for base (3-way merge) content stored in IndexedDB.
 *
 * Stored bytes are self-describing: a single leading format byte tells the
 * decoder how the body is encoded. This keeps the on-disk format forward-
 * compatible (a future codec can claim a new byte) and lets us skip
 * compression for inputs where it would not pay off.
 *
 * The content store is non-authoritative — entries written before this codec
 * existed lack the format byte, so a DB_VERSION cold-start drops them and they
 * re-baseline into the new format on the next sync.
 */
const FORMAT_RAW = 0x00; // body is the original bytes verbatim
const FORMAT_DEFLATE = 0x01; // body is raw-deflate compressed

/** Compress content for storage, prefixing a 1-byte format header. */
export function encodeContent(buf: ArrayBuffer): ArrayBuffer {
	const input = new Uint8Array(buf);
	const compressed = deflateSync(input);
	// Skip compression when it does not shrink the input (tiny/incompressible
	// data, where the deflate overhead would otherwise grow it).
	const useDeflate = compressed.length < input.length;
	const body = useDeflate ? compressed : input;
	const out = new Uint8Array(body.length + 1);
	out[0] = useDeflate ? FORMAT_DEFLATE : FORMAT_RAW;
	out.set(body, 1);
	return out.buffer;
}

/** Decompress stored content back to its original bytes. */
export function decodeContent(buf: ArrayBuffer): ArrayBuffer {
	const bytes = new Uint8Array(buf);
	const format = bytes[0];
	const body = bytes.subarray(1);
	if (format === FORMAT_DEFLATE) {
		// inflateSync returns a fresh Uint8Array; .buffer has the exact byteLength.
		return inflateSync(body).buffer;
	}
	if (format === FORMAT_RAW) {
		// .slice() copies the subarray into a standalone buffer so the returned
		// ArrayBuffer is not a 1-byte-offset view over the stored bytes.
		return body.slice().buffer;
	}
	throw new Error(`Unknown content codec format: ${format}`);
}
