import type { BackendChecksumAlgorithm } from "../../backend-api";
import { dropboxContentHash, sha1, sha256 } from "../../utils/hash";
import { md5 } from "../../utils/md5";
import { quickXorHashBase64 } from "../../utils/quickxor";

/**
 * Core-standard checksum ids. These are reserved: a module may declare its own
 * `<module-id>:<algorithm>` ids but must not override a core algorithm, which
 * would silently change the meaning of already-persisted `SyncRecord` checksums.
 */
export const CORE_CHECKSUM_IDS = ["sha256", "sha1", "md5", "dropbox", "quickxor"] as const;

const CORE_IDS: ReadonlySet<string> = new Set(CORE_CHECKSUM_IDS);

/**
 * The single checksum resolution point. Core-standard and module-provided
 * algorithms live in one registry: `registry.has(id)` is the only
 * locally-computable test, and an unregistered algorithm fails closed — it is
 * never assumed computable from the mere fact that it is not `"opaque"`.
 */
export interface ChecksumRegistry {
	/** Whether a locally reproducible digest is registered for `id`. */
	has(id: string): boolean;
	/**
	 * Compute the digest for `id`.
	 * @throws when `id` is not registered (fail closed).
	 */
	compute(content: ArrayBuffer, id: string): Promise<string>;
	/** Register a module-provided algorithm. Core-standard ids are refused. */
	register(algorithm: BackendChecksumAlgorithm): void;
}

/** Build a fresh registry with the core algorithms pre-registered. */
export function createChecksumRegistry(): ChecksumRegistry {
	const algorithms = new Map<string, (content: ArrayBuffer) => Promise<string>>();
	algorithms.set("sha256", sha256);
	algorithms.set("sha1", sha1);
	algorithms.set("md5", (content) => Promise.resolve(md5(content)));
	algorithms.set("dropbox", dropboxContentHash);
	algorithms.set("quickxor", (content) => Promise.resolve(quickXorHashBase64(content)));

	return {
		has: (id) => algorithms.has(id),
		compute: (content, id) => {
			const digest = algorithms.get(id);
			if (!digest) {
				return Promise.reject(new Error(`Unsupported checksum algorithm: ${id}`));
			}
			return digest(content);
		},
		register: (algorithm) => {
			if (CORE_IDS.has(algorithm.id)) {
				throw new Error(`Checksum algorithm ${algorithm.id} is reserved by core`);
			}
			if (algorithms.has(algorithm.id)) {
				throw new Error(`Checksum algorithm ${algorithm.id} is already registered`);
			}
			algorithms.set(algorithm.id, (content) => algorithm.digest(content));
		},
	};
}
