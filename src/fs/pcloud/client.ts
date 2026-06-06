import { requestUrl } from "obsidian";
import type { RequestUrlParam } from "obsidian";
import type { Logger } from "../../logging/logger";
import type {
	PCloudEntry,
	PCloudListFolderResponse,
	PCloudStatResponse,
	PCloudUploadResponse,
	PCloudFileLinkResponse,
	PCloudFolderResponse,
	PCloudDiffResponse,
} from "./types";
import { assertOk } from "./types";

type Params = Record<string, string | number | undefined>;

/**
 * Build a multipart/form-data body for `uploadfile` by hand.
 *
 * Obsidian's `requestUrl` does not support `FormData`, so the body is assembled
 * as raw bytes. The filename is carried in the part's Content-Disposition and
 * UTF-8 encoded (pCloud takes the filename "the way browsers send it"), which
 * preserves non-ASCII (e.g. Japanese) names.
 */
function buildMultipartBody(filename: string, content: ArrayBuffer): { body: ArrayBuffer; contentType: string } {
	const boundary = "----airsyncpcloud" + Date.now().toString(16);
	const encoder = new TextEncoder();
	const safeName = filename.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");
	const preamble = encoder.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
			`Content-Type: application/octet-stream\r\n\r\n`,
	);
	const postamble = encoder.encode(`\r\n--${boundary}--\r\n`);
	const body = new Uint8Array(preamble.length + content.byteLength + postamble.length);
	body.set(preamble, 0);
	body.set(new Uint8Array(content), preamble.length);
	body.set(postamble, preamble.length + content.byteLength);
	return { body: body.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Low-level pCloud HTTP JSON API client.
 *
 * Uses Obsidian's `requestUrl` (never `fetch`). Authentication is a long-lived
 * `auth=<token>` query param on every call; the API host (US `api.pcloud.com`
 * or EU `eapi.pcloud.com`) is read from `getApiHost` on every request, so the
 * region pinned at connect time is honored for the client's whole lifetime.
 * pCloud returns HTTP 200 even on logical errors, so every JSON response is
 * checked via {@link assertOk}.
 */
export class PCloudClient {
	constructor(
		private getToken: () => string,
		private getApiHost: () => string,
		private logger?: Logger,
	) {}

	private buildUrl(method: string, params: Params): string {
		const qs = new URLSearchParams();
		qs.set("auth", this.getToken());
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined) qs.set(k, String(v));
		}
		return `https://${this.getApiHost()}/${method}?${qs.toString()}`;
	}

	private wrap(op: string, err: unknown): Error {
		const msg = err instanceof Error ? err.message : String(err);
		this.logger?.error("pCloud API request failed", { operation: op, error: msg });
		return new Error(`pCloud API ${op} failed: ${msg}`);
	}

	/** Send a request, parse JSON, and assert `result === 0`. */
	private async send<T>(op: string, opts: RequestUrlParam): Promise<T> {
		let res: Awaited<ReturnType<typeof requestUrl>>;
		try {
			res = await requestUrl(opts);
		} catch (err) {
			throw this.wrap(op, err);
		}
		const json: unknown = res.json;
		assertOk(json, op);
		return json as T;
	}

	private get<T>(op: string, method: string, params: Params): Promise<T> {
		return this.send<T>(op, { url: this.buildUrl(method, params) });
	}

	/** List a folder's contents (optionally recursively). Returns the folder entry. */
	async listFolder(folderId: string, recursive = false): Promise<PCloudEntry> {
		const res = await this.get<PCloudListFolderResponse>("listFolder", "listfolder", {
			folderid: folderId,
			recursive: recursive ? 1 : undefined,
		});
		return res.metadata;
	}

	/** Get a single file's metadata by id. */
	async stat(fileId: string): Promise<PCloudEntry> {
		const res = await this.get<PCloudStatResponse>("stat", "stat", { fileid: fileId });
		return res.metadata;
	}

	/** Resolve a download link ({hosts, path}) for a file. */
	async getFileLink(fileId: string): Promise<PCloudFileLinkResponse> {
		return this.get<PCloudFileLinkResponse>("getFileLink", "getfilelink", { fileid: fileId });
	}

	/** Download file content (via getfilelink, then a GET to the content host). */
	async downloadFile(fileId: string): Promise<ArrayBuffer> {
		const link = await this.getFileLink(fileId);
		const host = link.hosts[0];
		if (!host) throw new Error("pCloud API downloadFile failed: no hosts in getfilelink response");
		try {
			const res = await requestUrl({ url: `https://${host}${link.path}` });
			return res.arrayBuffer;
		} catch (err) {
			throw this.wrap("downloadFile", err);
		}
	}

	/** Upload (create/overwrite) a file in a folder. `mtime` is epoch ms. */
	async uploadFile(folderId: string, name: string, content: ArrayBuffer, mtime: number): Promise<PCloudEntry> {
		const { body, contentType } = buildMultipartBody(name, content);
		const res = await this.send<PCloudUploadResponse>("uploadFile", {
			url: this.buildUrl("uploadfile", {
				folderid: folderId,
				mtime: Math.floor(mtime / 1000),
				nopartial: 1,
			}),
			method: "POST",
			headers: { "Content-Type": contentType },
			body,
		});
		const entry = res.metadata?.[0];
		if (!entry) throw new Error("pCloud API uploadFile failed: no metadata in response");
		return entry;
	}

	/** Create a subfolder (idempotent). Returns the folder entry. */
	async createFolderIfNotExists(parentFolderId: string, name: string): Promise<PCloudEntry> {
		const res = await this.get<PCloudFolderResponse>("createFolderIfNotExists", "createfolderifnotexists", {
			folderid: parentFolderId,
			name,
		});
		return res.metadata;
	}

	async deleteFile(fileId: string): Promise<void> {
		await this.get("deleteFile", "deletefile", { fileid: fileId });
	}

	async deleteFolderRecursive(folderId: string): Promise<void> {
		await this.get("deleteFolderRecursive", "deletefolderrecursive", { folderid: folderId });
	}

	/** Rename and/or move a file. Returns the updated entry. */
	async renameFile(fileId: string, toName?: string, toFolderId?: string): Promise<PCloudEntry> {
		const res = await this.get<PCloudFolderResponse>("renameFile", "renamefile", {
			fileid: fileId,
			toname: toName,
			tofolderid: toFolderId,
		});
		return res.metadata;
	}

	/** Rename and/or move a folder. Returns the updated entry. */
	async renameFolder(folderId: string, toName?: string, toFolderId?: string): Promise<PCloudEntry> {
		const res = await this.get<PCloudFolderResponse>("renameFolder", "renamefolder", {
			folderid: folderId,
			toname: toName,
			tofolderid: toFolderId,
		});
		return res.metadata;
	}

	/** Capture a baseline diff cursor (`diff?last=0` returns only the latest diffid). */
	async getDiffBaseline(): Promise<string> {
		const res = await this.get<PCloudDiffResponse>("getDiffBaseline", "diff", { last: 0 });
		return String(res.diffid);
	}

	/** Fetch account-wide change events since the given diff cursor. */
	async listDiff(diffId: string): Promise<PCloudDiffResponse> {
		return this.get<PCloudDiffResponse>("listDiff", "diff", { diffid: diffId });
	}
}
