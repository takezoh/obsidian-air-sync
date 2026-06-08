import type { FileEntity, RemoteChecksum } from "../fs/types";

/**
 * Content-identity primitives — the single source of truth for "do these two
 * sides hold the same bytes?".
 *
 * The rule everywhere is **same-algorithm-only**: a local SHA-256 hash and a
 * remote md5 are not comparable, so any cross-algorithm pair is "cannot prove
 * identity" (the caller tie-breaks) rather than a definitive verdict. This
 * conservatism lives here once; callers (the decision engine's no-baseline
 * match, the conflict resolver's tie-break, the change detector's temporal
 * compare) must not re-implement it.
 */

/**
 * Reduce an entity to a comparable `{algo, value}` content key, or `null` if it
 * has none. A populated `hash` is SHA-256; a remote backend that returns
 * `hash: ""` exposes its `remoteChecksum` (e.g. Drive md5) instead.
 */
export function contentKey(e: FileEntity): RemoteChecksum | null {
	if (e.hash) return { algo: "sha256", value: e.hash };
	if (e.remoteChecksum) return e.remoteChecksum;
	return null;
}

/**
 * Whether two backend checksums provably match — same algorithm AND same value.
 * A cross-algorithm pair is never equal here (see module note).
 */
export function checksumsEqual(a: RemoteChecksum, b: RemoteChecksum): boolean {
	return a.algo === b.algo && a.value === b.value;
}

/**
 * Returns true when two `FileEntity` objects provably represent identical
 * content. Reduces each to its content key and compares same-algorithm only —
 * if either side has no key, or the algorithms differ, returns false (the caller
 * then tie-breaks) rather than risk a cross-algorithm verdict.
 */
export function sameContent(a: FileEntity, b: FileEntity): boolean {
	const ka = contentKey(a);
	const kb = contentKey(b);
	return ka !== null && kb !== null && checksumsEqual(ka, kb);
}
