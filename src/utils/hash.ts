import type { ChecksumAlgo } from "../fs/types";
import { md5 } from "./md5";

/** Convert a digest ArrayBuffer to a lowercase hex string. */
function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i]!.toString(16).padStart(2, "0");
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

/** Whether a checksum algorithm can be reproduced from local file content. */
export function isLocallyComputable(algo: ChecksumAlgo): boolean {
	return algo !== "opaque";
}

/**
 * Compute the content digest for a locally-computable algorithm.
 *
 * @throws for `"opaque"` — backend-internal checksums cannot be reproduced locally.
 */
export async function digest(data: ArrayBuffer, algo: ChecksumAlgo): Promise<string> {
	switch (algo) {
		case "md5":
			return md5(data);
		case "sha1":
			return sha1(data);
		case "sha256":
			return sha256(data);
		case "opaque":
			throw new Error("Cannot compute an opaque checksum locally");
	}
}
