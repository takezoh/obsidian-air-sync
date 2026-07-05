import type { FileEntity } from "../types";
import { AuthError } from "../errors";

/**
 * A Dropbox file/folder metadata entry (the subset Air Sync uses).
 *
 * Dropbox is path-addressed: `path_display` preserves the user's casing while
 * `path_lower` is the case-folded form used for matching (Dropbox is
 * case-insensitive). `id` (`"id:…"`) is stable across rename/move — it is the
 * join key for coalescing a `deleted`+`file` pair back into a rename.
 *
 * `content_hash` is Dropbox's 4 MiB-block SHA-256 tree (see `ChecksumAlgo`
 * `"dropbox"`). It is reproducible from local content, so it is surfaced as a
 * locally-computable `remoteChecksum` that drives cross-side dedup.
 *
 * A `"deleted"` entry only carries `name`/`path_*` — never cached, only used to
 * remove a subtree during incremental sync.
 */
export interface DropboxEntry {
	".tag": "file" | "folder" | "deleted";
	id?: string;
	name: string;
	path_lower: string;
	path_display: string;
	/** File only */
	rev?: string;
	size?: number;
	client_modified?: string;
	server_modified?: string;
	content_hash?: string;
}

export interface DropboxListFolderResponse {
	entries: DropboxEntry[];
	cursor: string;
	has_more: boolean;
}

export interface DropboxLatestCursorResponse {
	cursor: string;
}

export interface DropboxMetadataResponse {
	metadata: DropboxEntry;
}

export interface DropboxTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type?: string;
}

/**
 * Validate a Dropbox token-endpoint response before storing it. A missing or
 * non-numeric `expires_in` would otherwise make `accessTokenExpiry = NaN`, so the
 * skew guard `now < expiry - 60s` is ALWAYS false → a token refresh on every
 * single request. Reject such a response loudly instead.
 */
export function assertDropboxTokenResponse(json: unknown): asserts json is DropboxTokenResponse {
	const obj = json as Record<string, unknown> | null;
	if (
		!obj ||
		typeof obj !== "object" ||
		typeof obj.access_token !== "string" ||
		typeof obj.expires_in !== "number" ||
		!Number.isFinite(obj.expires_in) ||
		obj.expires_in <= 0
	) {
		throw new Error("Invalid Dropbox token response: missing or invalid access_token / expires_in");
	}
}

/** Shape of a Dropbox JSON error body (RPC and content endpoints share it). */
interface DropboxErrorBody {
	error_summary?: string;
	error?: { ".tag"?: string };
}

/**
 * A Dropbox API error that is NOT authentication-class. Carries the HTTP status
 * and the `error_summary` so callers can branch on endpoint-specific tags
 * (e.g. `createFolder` swallows `path/conflict`, incremental sync detects
 * `reset`). Auth-class failures throw {@link AuthError} instead.
 */
export class DropboxApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly summary: string,
	) {
		super(message);
		this.name = "DropboxApiError";
	}
}

/**
 * Dropbox `.tag` values (or 401 status) that mean "authentication is required /
 * invalid" → mapped to {@link AuthError} so the sync engine surfaces a reconnect
 * prompt and the client refreshes/retries once.
 */
const AUTH_ERROR_TAGS = new Set([
	"invalid_access_token",
	"expired_access_token",
	"user_suspended",
	"missing_scope",
	"route_access_denied",
]);

/**
 * Assert a Dropbox HTTP response is OK. Obsidian's `requestUrl` is called with
 * `throw: false`, so non-2xx responses reach here for inspection of the status
 * and JSON `.tag`.
 *
 * @throws {AuthError} for 401 / auth-class tags.
 * @throws {DropboxApiError} for any other non-2xx (409 endpoint errors, 429
 *   rate limits, 5xx), preserving the status and `error_summary`.
 */
export function assertOk(res: { status: number; json?: unknown; text?: string }, op: string): void {
	if (res.status >= 200 && res.status < 300) return;
	let body: DropboxErrorBody | undefined;
	try {
		body = res.json as DropboxErrorBody | undefined;
	} catch {
		body = undefined;
	}
	const summary = body?.error_summary ?? (typeof res.text === "string" ? res.text : "");
	const tag = body?.error?.[".tag"] ?? summary.split("/")[0] ?? "";
	const detail = summary || tag;
	const message = detail
		? `Dropbox API ${op} failed: ${res.status} ${detail}`
		: `Dropbox API ${op} failed: ${res.status}`;
	if (res.status === 401 || AUTH_ERROR_TAGS.has(tag)) {
		throw new AuthError(message, 401);
	}
	throw new DropboxApiError(message, res.status, summary);
}

/** Whether an error is a Dropbox cursor-`reset` (incremental state must be rebuilt). */
export function isDropboxResetError(err: unknown): boolean {
	return err instanceof DropboxApiError && err.summary.startsWith("reset");
}

/** True for a folder entry. */
export function isFolderEntry(entry: DropboxEntry): boolean {
	return entry[".tag"] === "folder";
}

/** Parse a Dropbox `server_modified`/`client_modified` time to epoch ms (0 if absent). */
export function parseDropboxTime(value: string | undefined): number {
	if (!value) return 0;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Build a FileEntity from a cached Dropbox entry (no download).
 *
 * `hash` is always `""` — the sync engine relies on `remoteChecksum`
 * (`content_hash`, a locally-computable 4 MiB SHA-256 tree) for temporal change
 * detection and cross-side dedup. `mtime` uses `server_modified` (the canonical
 * remote timestamp), falling back to `client_modified`.
 */
export function dropboxEntryToEntity(path: string, entry: DropboxEntry): FileEntity {
	if (isFolderEntry(entry)) {
		return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
	}
	return {
		path,
		isDirectory: false,
		size: entry.size ?? 0,
		mtime: parseDropboxTime(entry.server_modified ?? entry.client_modified),
		hash: "",
		remoteChecksum: entry.content_hash ? { algo: "dropbox", value: entry.content_hash } : undefined,
		backendMeta: { dropboxId: entry.id, rev: entry.rev },
	};
}
