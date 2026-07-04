import { requestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { Logger } from "../../logging/logger";
import { getHeader } from "../headers";
import type {
	DropboxEntry,
	DropboxListFolderResponse,
	DropboxLatestCursorResponse,
	DropboxMetadataResponse,
} from "./types";
import { assertOk, DropboxApiError } from "./types";

const RPC_API = "https://api.dropboxapi.com/2";
const CONTENT_API = "https://content.dropboxapi.com/2";

/**
 * Max in-place retries for a 429. Dropbox's `too_many_write_operations` is
 * transient lock contention during concurrent writes (e.g. a bulk first sync),
 * so a short backoff usually clears it without failing the whole sync cycle.
 */
export const MAX_RATE_LIMIT_RETRIES = 4;

/** Cap a single 429 backoff so a large `Retry-After` can't freeze the sync for minutes. */
const MAX_RATE_LIMIT_DELAY_MS = 64_000;

/**
 * Hard cap on pagination drain loops (full list and delta). Reaching it means the
 * server isn't clearing `has_more`; we throw instead of looping forever or
 * silently truncating (a short listing would read as mass deletion downstream).
 */
export const LIST_PAGE_CAP = 10_000;

/** Pauses execution; injectable so tests run instantly. */
export type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Backoff for a 429: honor `Retry-After` (seconds) when present, else exponential; always capped. */
function rateLimitDelayMs(res: RequestUrlResponse, attempt: number): number {
	const header = getHeader(res.headers, "retry-after");
	const retryAfter = header ? Number(header) : NaN;
	const raw = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
	return Math.min(raw, MAX_RATE_LIMIT_DELAY_MS); // exponential is 0.5/1/2/4s; cap guards Retry-After
}

/**
 * Escape a JSON string so it is HTTP-header-safe for `Dropbox-API-Arg`.
 *
 * Dropbox requires the arg header to be ASCII; every code unit ≥ 0x7F (and DEL)
 * is `\uXXXX`-escaped. Iterating UTF-16 code units escapes each half of a
 * surrogate pair, which is exactly what Dropbox expects — this is what makes
 * non-ASCII (e.g. Japanese) paths work.
 */
function toApiArgHeader(arg: unknown): string {
	const json = JSON.stringify(arg);
	let out = "";
	for (let i = 0; i < json.length; i++) {
		const code = json.charCodeAt(i);
		out += code >= 0x7f ? "\\u" + code.toString(16).padStart(4, "0") : json[i];
	}
	return out;
}

/** Format epoch ms as a Dropbox `client_modified` timestamp (second precision, UTC). */
function toDropboxTimestamp(mtime: number): string {
	return new Date(mtime).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Low-level Dropbox HTTP API v2 client.
 *
 * Uses Obsidian's `requestUrl` (never `fetch`) with `throw: false` so non-2xx
 * responses are inspected by {@link assertOk}. RPC calls hit
 * `api.dropboxapi.com/2` (JSON in/out); content calls hit
 * `content.dropboxapi.com/2` (octet-stream body + `Dropbox-API-Arg` header).
 * The bearer is a short-lived access token; a 401 triggers one forced
 * refresh-and-retry via `getToken(true)`, and a 429 is retried with backoff.
 */
export class DropboxClient {
	constructor(
		private getToken: (forceRefresh?: boolean) => Promise<string>,
		private logger?: Logger,
		private sleep: SleepFn = defaultSleep,
	) {}

	private wrapTransport(op: string, err: unknown): Error {
		const msg = err instanceof Error ? err.message : String(err);
		this.logger?.error("Dropbox API request failed", { operation: op, error: msg });
		return new Error(`Dropbox API ${op} failed: ${msg}`);
	}

	/**
	 * Inject the bearer, send with `throw:false`, then assertOk. Retries once on a
	 * 401 (forced token refresh) and up to {@link MAX_RATE_LIMIT_RETRIES} times on a
	 * 429 (backoff), so transient write-lock contention doesn't fail the cycle.
	 */
	private async request(
		op: string,
		opts: RequestUrlParam,
		state: { auth401Retried: boolean; rateLimitRetries: number } = { auth401Retried: false, rateLimitRetries: 0 },
	): Promise<RequestUrlResponse> {
		const token = await this.getToken(state.auth401Retried);
		let res: RequestUrlResponse;
		try {
			res = await requestUrl({
				...opts,
				throw: false,
				headers: { ...opts.headers, Authorization: `Bearer ${token}` },
			});
		} catch (err) {
			throw this.wrapTransport(op, err);
		}
		if (res.status === 401 && !state.auth401Retried) {
			this.logger?.info("Dropbox API returned 401, refreshing token and retrying", { operation: op });
			return this.request(op, opts, { ...state, auth401Retried: true });
		}
		if (res.status === 429 && state.rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
			const delay = rateLimitDelayMs(res, state.rateLimitRetries);
			this.logger?.info("Dropbox API returned 429, backing off and retrying", {
				operation: op,
				delayMs: delay,
				attempt: state.rateLimitRetries + 1,
			});
			await this.sleep(delay);
			return this.request(op, opts, { ...state, rateLimitRetries: state.rateLimitRetries + 1 });
		}
		assertOk(res, op);
		return res;
	}

	/** Send a JSON RPC request and return the parsed body. */
	private async rpc<T>(op: string, endpoint: string, body: unknown): Promise<T> {
		const res = await this.request(op, {
			url: `${RPC_API}/${endpoint}`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return res.json as T;
	}

	/** List a folder (one page). `path` accepts `""`, `/abs/path`, or `id:<folderid>`. */
	listFolder(path: string, recursive: boolean): Promise<DropboxListFolderResponse> {
		return this.rpc<DropboxListFolderResponse>("listFolder", "files/list_folder", {
			path,
			recursive,
			include_deleted: false,
		});
	}

	/** Fetch the next page of a `list_folder` traversal or delta. */
	listFolderContinue(cursor: string): Promise<DropboxListFolderResponse> {
		return this.rpc<DropboxListFolderResponse>("listFolderContinue", "files/list_folder/continue", { cursor });
	}

	/** List a folder recursively, draining all pages into a flat entry array. */
	async listFolderAll(path: string, recursive: boolean): Promise<DropboxEntry[]> {
		const entries: DropboxEntry[] = [];
		let res = await this.listFolder(path, recursive);
		entries.push(...res.entries);
		// Bound the drain: a server that never clears has_more would loop forever.
		// Throw on the cap rather than silently truncating — a short full listing
		// would otherwise read as a mass remote deletion in the cold reconcile.
		for (let guard = 0; res.has_more; guard++) {
			if (guard >= LIST_PAGE_CAP) {
				throw new Error(`listFolderAll: pagination exceeded ${LIST_PAGE_CAP} pages (server not clearing has_more?)`);
			}
			res = await this.listFolderContinue(res.cursor);
			entries.push(...res.entries);
		}
		return entries;
	}

	/**
	 * List the immediate folders directly under the App Folder root, for the in-app
	 * folder picker. The App Folder scope already namespaces the app, so `""` is the
	 * app-folder root; `listFolderAll` drains all pages (so a large folder list isn't
	 * silently truncated in the modal).
	 */
	async listAppRootFolders(): Promise<DropboxEntry[]> {
		const entries = await this.listFolderAll("", false);
		return entries.filter((e) => e[".tag"] === "folder");
	}

	/** Capture a baseline delta cursor without fetching entries (root via `id:` for stability). */
	async getLatestCursor(path: string, recursive: boolean): Promise<string> {
		const res = await this.rpc<DropboxLatestCursorResponse>(
			"getLatestCursor",
			"files/list_folder/get_latest_cursor",
			{ path, recursive, include_deleted: false },
		);
		return res.cursor;
	}

	/** Get a single entry's metadata by path (root path is not supported by Dropbox). */
	async getMetadata(path: string): Promise<DropboxEntry> {
		return this.rpc<DropboxEntry>("getMetadata", "files/get_metadata", { path });
	}

	/** Download file content. Metadata rides in the `Dropbox-API-Result` header (unused here). */
	async download(path: string): Promise<ArrayBuffer> {
		const res = await this.request("download", {
			url: `${CONTENT_API}/files/download`,
			method: "POST",
			headers: { "Dropbox-API-Arg": toApiArgHeader({ path }) },
		});
		return res.arrayBuffer;
	}

	/** Upload (create/overwrite) a file. `mtime` (epoch ms) becomes `client_modified`. */
	async upload(path: string, content: ArrayBuffer, mtime: number): Promise<DropboxEntry> {
		const res = await this.request("upload", {
			url: `${CONTENT_API}/files/upload`,
			method: "POST",
			headers: {
				"Dropbox-API-Arg": toApiArgHeader({
					path,
					mode: "overwrite",
					autorename: false,
					mute: false,
					client_modified: toDropboxTimestamp(mtime),
				}),
				"Content-Type": "application/octet-stream",
			},
			body: content,
		});
		// `upload` returns a bare FileMetadata with no `.tag` discriminator (unlike
		// list_folder's tagged union), so stamp it for consistent typing downstream.
		return { ...(res.json as DropboxEntry), ".tag": "file" };
	}

	/** Create a folder (idempotent: an existing folder's `path/conflict` is swallowed). */
	async createFolder(path: string): Promise<DropboxEntry> {
		try {
			const res = await this.rpc<DropboxMetadataResponse>("createFolder", "files/create_folder_v2", {
				path,
				autorename: false,
			});
			// `create_folder_v2` returns a bare FolderMetadata with NO `.tag` field
			// (it is a concrete struct, not the tagged Metadata union). Without this
			// stamp the cache would treat the new folder as a file (isFolderEntry
			// checks `.tag === "folder"`), breaking every subsequent write into it.
			return { ...res.metadata, ".tag": "folder" };
		} catch (err) {
			if (err instanceof DropboxApiError && err.summary.startsWith("path/conflict")) {
				return this.getMetadata(path);
			}
			throw err;
		}
	}

	/** Delete a path and everything under it (idempotent: an already-gone path is a no-op). */
	async deletePath(path: string): Promise<void> {
		try {
			await this.rpc("deletePath", "files/delete_v2", { path });
		} catch (err) {
			// IFileSystem.delete is documented idempotent. Dropbox returns 409
			// path_lookup/not_found when the path is already gone (e.g. concurrently
			// deleted on the remote) — treat that as success, not a failure.
			if (err instanceof DropboxApiError && err.summary.includes("not_found")) return;
			throw err;
		}
	}

	/** Rename/move a path in a single call (`move_v2`). */
	async move(fromPath: string, toPath: string): Promise<DropboxEntry> {
		const res = await this.rpc<DropboxMetadataResponse>("move", "files/move_v2", {
			from_path: fromPath,
			to_path: toPath,
			autorename: false,
		});
		return res.metadata;
	}
}
