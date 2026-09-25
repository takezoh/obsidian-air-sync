const HEX_DIGITS = "0123456789abcdef";

function hexDigit(value: number): string {
	return HEX_DIGITS.charAt(value & 0x0f);
}

/** Convert a digest ArrayBuffer to a lowercase hex string. */
function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		if (byte === undefined) continue;
		hex += hexDigit(byte >> 4) + hexDigit(byte);
	}
	return hex;
}

/** Compute SHA-256 hex digest using Web Crypto API */
export async function sha256(data: ArrayBuffer): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", data));
}

/** Compute SHA-1 hex digest using Web Crypto API */
export async function sha1(data: ArrayBuffer): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-1", data));
}

/** Dropbox content-hash block size: 4 MiB (4 * 1024 * 1024 bytes). */
const DROPBOX_BLOCK_SIZE = 4 * 1024 * 1024;

/**
 * Compute Dropbox's `content_hash` (hex) for the given content.
 *
 * Algorithm (per the Dropbox content-hash reference): split the file into 4 MiB
 * blocks, SHA-256 each block, concatenate the raw block digests, then SHA-256
 * the concatenation. An empty file hashes the empty concatenation — i.e. it
 * equals `sha256("")`. Reproducible locally, so it drives cross-side dedup.
 */
export async function dropboxContentHash(data: ArrayBuffer): Promise<string> {
	const bytes = new Uint8Array(data);
	const blockDigests: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.length; offset += DROPBOX_BLOCK_SIZE) {
		const block = bytes.subarray(offset, Math.min(offset + DROPBOX_BLOCK_SIZE, bytes.length));
		blockDigests.push(new Uint8Array(await crypto.subtle.digest("SHA-256", block)));
	}
	const concat = new Uint8Array(blockDigests.reduce((n, d) => n + d.length, 0));
	let pos = 0;
	for (const d of blockDigests) {
		concat.set(d, pos);
		pos += d.length;
	}
	return toHex(await crypto.subtle.digest("SHA-256", concat));
}
