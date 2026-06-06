import type { FileEntity } from "../fs/types";
import type { SyncRecord } from "./types";

/**
 * Check if a local file has changed since the last sync.
 * Priority: mtime+size (fast, no I/O) → content hash → conservative.
 */
export function hasChanged(file: FileEntity, record: SyncRecord): boolean {
	// Prefer mtime+size comparison (avoids content read)
	if (file.mtime > 0 && record.localMtime > 0) {
		if (file.mtime !== record.localMtime || file.size !== record.localSize) {
			// mtime/size differ — verify hash before concluding changed
			if (file.hash && record.hash) {
				return file.hash !== record.hash;
			}
			return true;
		}
		// mtime+size match — verify hash if both available (catches same-size edits)
		if (file.hash && record.hash) {
			return file.hash !== record.hash;
		}
		return false;
	}
	// Fall back to hash comparison if available
	if (file.hash && record.hash) {
		return file.hash !== record.hash;
	}
	// Conservative: treat as changed if we can't determine
	return true;
}

/**
 * Check if a remote file has changed since the last sync.
 * Priority: mtime+size (fast) → remoteChecksum (backend-provided checksum,
 * reliable when mtime is missing or unreliable) → content hash → conservative.
 */
export function hasRemoteChanged(file: FileEntity, record: SyncRecord): boolean {
	const fileChecksum = file.remoteChecksum?.value;
	const recordChecksum = record.remoteChecksum?.value;

	if (file.mtime > 0 && record.remoteMtime > 0) {
		if (file.mtime === record.remoteMtime && file.size === record.remoteSize) {
			// mtime+size match — verify hash if both available (catches same-size edits)
			if (file.hash && record.hash) {
				return file.hash !== record.hash;
			}
			return false;
		}
		// mtime/size differ — check checksum before concluding changed
		if (fileChecksum && recordChecksum) {
			return fileChecksum !== recordChecksum;
		}
		return true;
	}
	// Use backend-provided checksum when available (e.g. Drive md5, pCloud content hash)
	if (fileChecksum && recordChecksum) {
		return fileChecksum !== recordChecksum;
	}
	if (file.hash && record.hash) {
		return file.hash !== record.hash;
	}
	return true;
}
