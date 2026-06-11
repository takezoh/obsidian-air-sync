import { deflateSync as rawDeflateSync, inflateSync as rawInflateSync } from "fflate";

// fflate 0.8.x declares these as returning `Uint8Array<ArrayBuffer>` (the
// generic Uint8Array form). The community submission bot lints on a toolchain
// where that generic does not resolve, so the return type degrades to `any`
// and the typed-lint rules flag every downstream use. Pin the signatures to a
// plain, always-resolvable `Uint8Array` so the codec stays type-safe in every
// environment; the cast through `unknown` launders the unresolved type.
type ByteCodec = (data: Uint8Array) => Uint8Array;
const deflateSync = rawDeflateSync as unknown as ByteCodec;
const inflateSync = rawInflateSync as unknown as ByteCodec;

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
		// fflate returns a fresh, offset-0, exactly-sized Uint8Array, so its
		// `.buffer` is safe to hand back directly (zero-copy). The cast only
		// re-narrows ArrayBufferLike → ArrayBuffer, lost when ByteCodec pins the
		// return to a plain Uint8Array.
		return inflateSync(body).buffer as ArrayBuffer;
	}
	if (format === FORMAT_RAW) {
		// .slice() copies the subarray into a standalone buffer so the returned
		// ArrayBuffer is not a 1-byte-offset view over the stored bytes.
		return body.slice().buffer;
	}
	throw new Error(`Unknown content codec format: ${format}`);
}
