import { requestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { Logger } from "../../logging/logger";
import type {
	OneDriveItem,
	OneDriveItemWithDownloadUrl,
	OneDriveDeltaResponse,
	OneDriveChildrenResponse,
} from "./types";
import { assertOk, GraphApiError, encodeRelPath } from "./types";
import { uploadSession, SIMPLE_UPLOAD_MAX } from "./upload-session";

const GRAPH_API = "https://graph.microsoft.com/v1.0";

/** Max in-place retries for a 429 (throttling). */
export const MAX_RATE_LIMIT_RETRIES = 4;

/** Cap a single 429 backoff so a large `Retry-After` can't freeze the sync for minutes. */
const MAX_RATE_LIMIT_DELAY_MS = 64_000;

/**
 * Hard cap on pagination drain loops (full delta and incremental delta). Reaching
 * it means the server isn't clearing its `@odata.nextLink`; we throw instead of
 * looping forever or silently truncating (a short listing would read as mass
 * deletion downstream).
 */
export const LIST_PAGE_CAP = 10_000;

/** Pauses execution; injectable so tests run instantly. */
export type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Backoff for a 429: honor `Retry-After` (seconds) when present, else exponential; always capped. */
function rateLimitDelayMs(res: RequestUrlResponse, attempt: number): number {
	const header = res.headers?.["retry-after"] ?? res.headers?.["Retry-After"];
	const retryAfter = header ? Number(header) : NaN;
	const raw = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
	return Math.min(raw, MAX_RATE_LIMIT_DELAY_MS);
}

/**
 * Low-level Microsoft Graph v1.0 client for OneDrive (App Folder scope).
 *
 * Uses Obsidian's `requestUrl` (never `fetch`) with `throw: false` so non-2xx
 * responses are inspected by {@link assertOk}. Items are addressed by their stable
 * driveItem id (`/me/drive/items/{id}`) or path-relative under a folder
 * (`/me/drive/items/{folderId}:/{path}:`). The bearer is a short-lived access
 * token; a 401 triggers one forced refresh-and-retry, and a 429 is retried with backoff.
 */
export class OneDriveClient {
	constructor(
		private getToken: (forceRefresh?: boolean) => Promise<string>,
		private logger?: Logger,
		private sleep: SleepFn = defaultSleep,
	) {}

	private wrapTransport(op: string, err: unknown): Error {
		const msg = err instanceof Error ? err.message : String(err);
		this.logger?.error("OneDrive API request failed", { operation: op, error: msg });
		return new Error(`OneDrive API ${op} failed: ${msg}`);
	}

	/**
	 * Inject the bearer, send with `throw:false`, then assertOk. Retries once on a
	 * 401 (forced token refresh) and up to {@link MAX_RATE_LIMIT_RETRIES} times on a
	 * 429 (backoff). Exposed as a bound method so the upload-session helper shares it.
	 */
	request = async (
		op: string,
		opts: RequestUrlParam,
		state: { auth401Retried: boolean; rateLimitRetries: number } = { auth401Retried: false, rateLimitRetries: 0 },
		skipAuth = false,
	): Promise<RequestUrlResponse> => {
		// `skipAuth` is for the resumable upload-session chunk PUTs: their `uploadUrl` is
		// already pre-authenticated (a SAS-style URL), and Graph requires the bearer be
		// OMITTED there. Every other call injects it (and can refresh+retry on a 401).
		let headers = opts.headers;
		if (!skipAuth) {
			const token = await this.getToken(state.auth401Retried);
			headers = { ...opts.headers, Authorization: `Bearer ${token}` };
		}
		let res: RequestUrlResponse;
		try {
			res = await requestUrl({ ...opts, throw: false, headers });
		} catch (err) {
			throw this.wrapTransport(op, err);
		}
		if (!skipAuth && res.status === 401 && !state.auth401Retried) {
			this.logger?.info("OneDrive API returned 401, refreshing token and retrying", { operation: op });
			return this.request(op, opts, { ...state, auth401Retried: true }, skipAuth);
		}
		if (res.status === 429 && state.rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
			const delay = rateLimitDelayMs(res, state.rateLimitRetries);
			this.logger?.info("OneDrive API returned 429, backing off and retrying", {
				operation: op,
				delayMs: delay,
				attempt: state.rateLimitRetries + 1,
			});
			await this.sleep(delay);
			return this.request(op, opts, { ...state, rateLimitRetries: state.rateLimitRetries + 1 }, skipAuth);
		}
		assertOk(res, op);
		return res;
	};

	/** Send a JSON request and return the parsed body. */
	private async json<T>(op: string, url: string, method: string, body?: unknown): Promise<T> {
		const res = await this.request(op, {
			url,
			method,
			headers: body === undefined ? {} : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return res.json as T;
	}

	/** Capture a baseline delta cursor without fetching items (`?token=latest`). */
	async getStartCursor(rootId: string): Promise<string> {
		const res = await this.json<OneDriveDeltaResponse>(
			"getStartCursor",
			`${GRAPH_API}/me/drive/items/${rootId}/delta?token=latest`,
			"GET",
		);
		return extractDeltaToken(res["@odata.deltaLink"]);
	}

	/**
	 * Drain a full delta enumeration of the subtree under `rootId` (no token),
	 * following `@odata.nextLink`. Returns every item EXCEPT the root itself and any
	 * `deleted` tombstone — the shape `buildFromFiles` expects.
	 */
	async fullList(rootId: string): Promise<OneDriveItem[]> {
		const items: OneDriveItem[] = [];
		let url: string | undefined = `${GRAPH_API}/me/drive/items/${rootId}/delta`;
		for (let guard = 0; url; guard++) {
			if (guard >= LIST_PAGE_CAP) {
				throw new Error(`fullList: pagination exceeded ${LIST_PAGE_CAP} pages (server not clearing nextLink?)`);
			}
			const res: OneDriveDeltaResponse = await this.json<OneDriveDeltaResponse>("fullList", url, "GET");
			for (const item of res.value) {
				if (item.id === rootId || item.deleted) continue;
				items.push(item);
			}
			url = res["@odata.nextLink"];
		}
		return items;
	}

	/** Fetch one page of a delta carrying `token` (or a follow-on nextLink). */
	fetchDelta(rootId: string, link: string): Promise<OneDriveDeltaResponse> {
		const url = link.startsWith("http")
			? link
			: `${GRAPH_API}/me/drive/items/${rootId}/delta?token=${encodeURIComponent(link)}`;
		return this.json<OneDriveDeltaResponse>("fetchDelta", url, "GET");
	}

	/** Get a single item's metadata by id (404 ⇒ GraphApiError, caller treats as gone). */
	getItem(id: string): Promise<OneDriveItem> {
		return this.json<OneDriveItem>("getItem", `${GRAPH_API}/me/drive/items/${id}`, "GET");
	}

	/** List immediate children of a folder by id (paginated; folders + files). */
	async listChildren(folderId: string): Promise<OneDriveItem[]> {
		const items: OneDriveItem[] = [];
		let url: string | undefined = `${GRAPH_API}/me/drive/items/${folderId}/children`;
		for (let guard = 0; url; guard++) {
			if (guard >= LIST_PAGE_CAP) {
				throw new Error(`listChildren: pagination exceeded ${LIST_PAGE_CAP} pages`);
			}
			const res: OneDriveChildrenResponse = await this.json<OneDriveChildrenResponse>("listChildren", url, "GET");
			items.push(...res.value);
			url = res["@odata.nextLink"];
		}
		return items;
	}

	/** List immediate folders directly under the App Folder root (paginated). */
	async listAppRootFolders(): Promise<OneDriveItem[]> {
		const folders: OneDriveItem[] = [];
		// Drain @odata.nextLink: Graph pages /children (~200/page), so a single GET
		// would silently truncate the folder list shown in the picker modal.
		let url: string | undefined = `${GRAPH_API}/me/drive/special/approot/children`;
		for (let guard = 0; url; guard++) {
			if (guard >= LIST_PAGE_CAP) {
				throw new Error(`listAppRootFolders: pagination exceeded ${LIST_PAGE_CAP} pages`);
			}
			const res: OneDriveChildrenResponse = await this.json<OneDriveChildrenResponse>("listAppRootFolders", url, "GET");
			for (const item of res.value) {
				if (item.folder) folders.push(item);
			}
			url = res["@odata.nextLink"];
		}
		return folders;
	}

	/** Get the App Folder root item (its id is the anchor for find-or-create). */
	getAppRoot(): Promise<OneDriveItem> {
		return this.json<OneDriveItem>("getAppRoot", `${GRAPH_API}/me/drive/special/approot`, "GET");
	}

	/**
	 * Download file content by id in two steps to avoid the `/content` redirect:
	 *  1. GET the item's `@microsoft.graph.downloadUrl` (a short-lived, pre-authenticated URL).
	 *  2. GET that URL with NO bearer (`skipAuth`) — it carries its own auth in the query.
	 *
	 * Why not GET `/content` directly: Graph answers it with a 302 to a CDN/SharePoint
	 * host, and Obsidian's `requestUrl` follows the redirect while re-sending
	 * `Authorization: Bearer <graph-token>`. That host rejects the foreign bearer with
	 * 401 (observed live), so the download must never carry it.
	 */
	async download(id: string): Promise<ArrayBuffer> {
		const item = await this.json<OneDriveItemWithDownloadUrl>(
			"download",
			`${GRAPH_API}/me/drive/items/${id}?select=id,@microsoft.graph.downloadUrl`,
			"GET",
		);
		const url = item["@microsoft.graph.downloadUrl"];
		if (!url) throw new Error(`OneDrive API download failed: item ${id} has no @microsoft.graph.downloadUrl`);
		const res = await this.request(
			"download",
			{ url, method: "GET" },
			{ auth401Retried: false, rateLimitRetries: 0 },
			true, // skipAuth: the pre-authenticated URL must not receive a graph bearer
		);
		return res.arrayBuffer;
	}

	/**
	 * Upload (create/overwrite) a file under `parentId` named `name`. Small files go
	 * via a simple PUT then a PATCH to preserve mtime; large files via a resumable
	 * upload session. `mtime` (epoch ms) becomes `fileSystemInfo.lastModifiedDateTime`.
	 */
	async upload(parentId: string, name: string, content: ArrayBuffer, mtime: number): Promise<OneDriveItem> {
		const lastModifiedDateTime = new Date(mtime).toISOString();
		if (content.byteLength >= SIMPLE_UPLOAD_MAX) {
			return uploadSession({ request: this.request, graphApi: GRAPH_API }, parentId, name, content, lastModifiedDateTime);
		}
		const url = `${GRAPH_API}/me/drive/items/${parentId}:/${encodeRelPath(name)}:/content`;
		const res = await this.request("upload", {
			url,
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream" },
			body: content,
		});
		const item = res.json as OneDriveItem;
		// Preserve the local mtime: a plain content PUT stamps the server's clock, so
		// PATCH fileSystemInfo afterwards (else every upload reads back as "changed").
		return this.patchMtime(item.id, lastModifiedDateTime);
	}

	/** PATCH an item's fileSystemInfo.lastModifiedDateTime and return the updated item. */
	private patchMtime(id: string, lastModifiedDateTime: string): Promise<OneDriveItem> {
		return this.json<OneDriveItem>("patchMtime", `${GRAPH_API}/me/drive/items/${id}`, "PATCH", {
			fileSystemInfo: { lastModifiedDateTime },
		});
	}

	/**
	 * Create a folder named `name` under `parentId` (idempotent: a 409 name conflict
	 * resolves to the existing child via a path-relative GET).
	 */
	async createFolder(parentId: string, name: string): Promise<OneDriveItem> {
		try {
			return await this.json<OneDriveItem>(
				"createFolder",
				`${GRAPH_API}/me/drive/items/${parentId}/children`,
				"POST",
				{ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
			);
		} catch (err) {
			if (err instanceof GraphApiError && err.status === 409) {
				return this.getChildByName(parentId, name);
			}
			throw err;
		}
	}

	/** Get an item by its name under a parent folder (path-relative addressing). */
	getChildByName(parentId: string, name: string): Promise<OneDriveItem> {
		return this.json<OneDriveItem>(
			"getChildByName",
			`${GRAPH_API}/me/drive/items/${parentId}:/${encodeRelPath(name)}:`,
			"GET",
		);
	}

	/** Rename and/or move an item (PATCH name and/or parentReference). */
	move(id: string, newName: string | undefined, newParentId: string | undefined): Promise<OneDriveItem> {
		const body: { name?: string; parentReference?: { id: string } } = {};
		if (newName !== undefined) body.name = newName;
		if (newParentId !== undefined) body.parentReference = { id: newParentId };
		return this.json<OneDriveItem>("move", `${GRAPH_API}/me/drive/items/${id}`, "PATCH", body);
	}

	/** Delete an item by id (idempotent: a 404 already-gone item is a no-op success). */
	async deleteItem(id: string): Promise<void> {
		try {
			await this.request("deleteItem", { url: `${GRAPH_API}/me/drive/items/${id}`, method: "DELETE" });
		} catch (err) {
			if (err instanceof GraphApiError && err.status === 404) return;
			throw err;
		}
	}
}

/** Extract the `token` query param from a delta `@odata.deltaLink`. */
export function extractDeltaToken(deltaLink: string | undefined): string {
	if (!deltaLink) throw new Error("OneDrive delta response missing @odata.deltaLink");
	const idx = deltaLink.indexOf("?");
	const query = idx === -1 ? "" : deltaLink.slice(idx + 1);
	const token = new URLSearchParams(query).get("token");
	if (!token) throw new Error("OneDrive deltaLink missing token param");
	return token;
}
