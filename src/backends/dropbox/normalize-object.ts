import type { RemoteObject, RemoteLocation } from "../../backend-api";
import type { DropboxEntry } from "./types";
import { isFolderEntry } from "./types";

/**
 * Project a Dropbox entry onto the normalized {@link RemoteObject}.
 *
 * Dropbox is path-addressed: `id` (`id:…`) is stable across a move, but the tree
 * position is the provider-resolved vault-relative `path` with a stable `rootId`.
 * `pathAuthority` is `provider_resolved` because the adapter relativizes Dropbox's
 * own `path_display`. A deleted tombstone never reaches here (it is reported as a
 * path-addressed change instead). An entry without a stable id is a protocol
 * failure for an upsert; the adapter fails closed rather than minting a path id.
 */
export function normalizeDropboxObject(entry: DropboxEntry, rootId: string, path: string): RemoteObject {
	if (!entry.id) {
		throw new Error(`Dropbox entry "${path}" has no stable id`);
	}
	const location: RemoteLocation = { addressing: "provider_path", rootId, path };
	const base = {
		id: entry.id,
		name: entry.name,
		location,
		pathAuthority: "provider_resolved" as const,
		mtimeMs: parseDropboxTime(entry.server_modified ?? entry.client_modified),
	};

	if (isFolderEntry(entry)) {
		return { ...base, kind: "directory" };
	}
	return {
		...base,
		kind: "file",
		size: entry.size,
		checksum: entry.content_hash ? { algorithm: "dropbox", value: entry.content_hash } : undefined,
		versionToken: versionTokenOf(entry),
	};
}

function parseDropboxTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : ms;
}

function versionTokenOf(entry: DropboxEntry): string | undefined {
	if (!entry.rev || !entry.content_hash || !Number.isFinite(entry.size)) return undefined;
	return `dropbox:${entry.rev}`;
}
