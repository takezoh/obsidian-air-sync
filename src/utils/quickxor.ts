/**
 * Microsoft's QuickXorHash — the ONLY content hash a personal OneDrive (consumer
 * Graph) returns for a driveItem. It exposes neither `sha1Hash` nor `sha256Hash`
 * (those appear on OneDrive for Business / SharePoint), so without computing
 * quickXorHash locally the OneDrive backend has no locally-reproducible checksum
 * and cross-side content dedup (change-detector's `enrichHashesForInitialMatch`)
 * can never fire — every pre-existing identical file would re-conflict on first
 * sync. Implemented here so `digest(content, "quickxor")` matches Graph's value.
 *
 * QuickXorHash is a 160-bit hash: each input byte is XORed into a rotating bit
 * offset that advances by 11 bits per byte position, then the total length is
 * folded into the tail. Microsoft's reference keeps three 64-bit cells (64+64+32),
 * but the cells concatenate, byte-aligned and little-endian, into the same 160-bit
 * space — and the cell-spanning / last-cell-wrap cases all reduce to XORing a byte
 * continuously into a 160-bit RING at offset `(i*11) mod 160`. We implement that
 * ring directly on a 20-byte buffer (no BigInt — the project targets ES6). Output
 * is base64, exactly as Graph reports it. Verified against live Graph values in
 * `quickxor.test.ts`.
 */

const WIDTH_IN_BITS = 160;
const SHIFT = 11;
const OUT_BYTES = WIDTH_IN_BITS / 8; // 20

/** Base64-encode raw bytes (Web `btoa`; available in browser, mobile, and Node 20+). */
function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin);
}

/**
 * XOR an 8-bit value into the little-endian 160-bit ring `rgb` starting at bit
 * `bitPos`, wrapping around at 160 bits. Global bit g maps to `rgb[g>>3]` bit `g&7`.
 */
function xorByteAtBit(rgb: Uint8Array, value: number, bitPos: number): void {
	for (let k = 0; k < 8; k++) {
		if ((value >> k) & 1) {
			const pos = (bitPos + k) % WIDTH_IN_BITS;
			const i = pos >> 3;
			rgb[i] = rgb[i]! ^ (1 << (pos & 7));
		}
	}
}

/**
 * Compute the QuickXorHash of `data` and return it base64-encoded (Graph's wire
 * form). Byte i is XORed at bit offset `(i*11) mod 160`; bytes 160 apart share an
 * offset (the reference's "fold"), which the ring XOR handles for free.
 */
export function quickXorHashBase64(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);
	const rgb = new Uint8Array(OUT_BYTES);

	let bitPos = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] !== 0) xorByteAtBit(rgb, bytes[i]!, bitPos);
		bitPos += SHIFT;
		if (bitPos >= WIDTH_IN_BITS) bitPos -= WIDTH_IN_BITS;
	}

	// XOR the total length (Int64 little-endian) into the trailing 8 bytes.
	let len = bytes.length;
	const lengthStart = OUT_BYTES - 8; // 12
	for (let k = 0; k < 8; k++) {
		const j = lengthStart + k;
		rgb[j] = rgb[j]! ^ (len & 0xff);
		len = Math.floor(len / 256);
	}

	return bytesToBase64(rgb);
}
