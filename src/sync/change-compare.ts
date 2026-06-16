import type { FileEntity } from "../fs/types";
import type { SyncRecord } from "./types";
import { checksumsEqual } from "./content-identity";

/**
 * Temporal change detection — has a file changed since the last sync? (ADR 0005.)
 *
 * The local and remote sides are ASYMMETRIC in how a content fingerprint is obtained,
 * and that asymmetry — not a preference for speed — is what shapes the ordering:
 *
 *  - LOCAL has no free fingerprint. `FileEntity.hash` (sha256) is populated only by
 *    `LocalFs.stat()`, which READS the whole file; `LocalFs.list()` deliberately leaves
 *    it "" to stay I/O-free. So {@link hasChanged} uses the hash when it is already on
 *    hand (the HOT/stat path, dirty files only) and otherwise falls back to mtime+size —
 *    the cheap signal from a hash-less listing — so a full-vault scan never reads every file.
 *  - REMOTE has a free fingerprint. Cached remote entries always carry `hash === ""`;
 *    the content fingerprint is `remoteChecksum` (md5 / quickXor / Dropbox content-hash),
 *    which the backend returns in listing metadata at NO extra cost. So
 *    {@link hasRemoteChanged} leans on `remoteChecksum`, not `hash`.
 */

/**
 * Has a LOCAL file changed since the last sync?
 *
 * A content hash, WHEN BOTH SIDES HAVE ONE, is authoritative: it reports a
 * same-content/bumped-mtime touch as unchanged and a same-mtime+size edit as changed.
 * Locally a hash costs I/O (see the module note), so it is present only on the stat
 * path; the hash-less list path falls back to mtime+size, and a file with neither a
 * hash nor a usable mtime is conservatively treated as changed.
 */
export function hasChanged(file: FileEntity, record: SyncRecord): boolean {
	// Authoritative when both sides carry a hash (the local stat path computed one).
	if (file.hash && record.hash) {
		return file.hash !== record.hash;
	}
	// No hash on hand (the list path omits it to avoid reading content): the cheap
	// metadata signal is the discriminator.
	if (file.mtime > 0 && record.localMtime > 0) {
		return file.mtime !== record.localMtime || file.size !== record.localSize;
	}
	// Neither a hash nor a usable mtime — can't tell, so assume changed.
	return true;
}

/**
 * Has a REMOTE file changed since the last sync?
 *
 * The remote's content fingerprint is `remoteChecksum` (server-provided, free in listing
 * metadata), never the local-style `hash` — which is always "" for cached remote entries.
 * Signal order: mtime+size agree ⇒ unchanged; if they differ, trust the checksum when
 * both sides expose the SAME algo, else conservatively assume changed. The `hash`
 * comparison is kept only as defensive symmetry for a caller that supplies one (in
 * practice it never fires, since remote `hash` is "").
 *
 * A metadata-only touch (mtime drifts, content identical) lands on the "differ" path and
 * is correctly reported UNCHANGED *because* the checksum is compared there — the property
 * the remote change-detection contract pins.
 */
export function hasRemoteChanged(file: FileEntity, record: SyncRecord): boolean {
	// Compare the backend checksum only when both sides have one of the SAME algorithm:
	// a backend uses one algo per vault, so a mismatch (or a missing side) means "not
	// comparable" → undefined, and we fall through to mtime / conservative.
	const fc = file.remoteChecksum;
	const rc = record.remoteChecksum;
	const checksumChanged =
		fc !== undefined && rc !== undefined && fc.algo === rc.algo
			? !checksumsEqual(fc, rc)
			: undefined;

	if (file.mtime > 0 && record.remoteMtime > 0) {
		if (file.mtime === record.remoteMtime && file.size === record.remoteSize) {
			// mtime AND size agree → nothing suggests a change. (The hash check is inert
			// for real remote entries, whose hash is ""; kept for a hash-supplying caller.)
			if (file.hash && record.hash) return file.hash !== record.hash;
			return false;
		}
		// mtime/size differ → the free checksum decides when comparable, else conservative.
		return checksumChanged ?? true;
	}

	// No usable mtime → fall back to the checksum, then a supplied hash, then conservative.
	if (checksumChanged !== undefined) return checksumChanged;
	if (file.hash && record.hash) return file.hash !== record.hash;
	return true;
}
