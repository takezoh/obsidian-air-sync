import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { OneDriveItem } from "./types";
import { encodeRelPath } from "./types";

/** Files at/above this size use a resumable upload session; smaller use a simple PUT. */
export const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;

/** Graph requires each non-final chunk to be a multiple of 320 KiB. */
const CHUNK_SIZE = 10 * 320 * 1024; // 3.2 MiB — a multiple of 320 KiB, under the 4 MiB simple cap.

interface SessionCtx {
	request: (
		op: string,
		opts: RequestUrlParam,
		state?: { auth401Retried: boolean; rateLimitRetries: number },
		skipAuth?: boolean,
	) => Promise<RequestUrlResponse>;
	graphApi: string;
}

interface CreateSessionResponse {
	uploadUrl: string;
}

/**
 * Upload a large file via a Microsoft Graph resumable upload session: create the
 * session (which carries the conflict behaviour + the preserved mtime), then PUT
 * the content in 320 KiB-aligned chunks with `Content-Range` headers. The final
 * chunk's response carries the completed driveItem.
 *
 * The session PUTs go to an absolute `uploadUrl` that is already pre-authenticated
 * (a SAS-style URL); Graph requires the bearer be OMITTED there, so the chunk PUTs
 * pass `skipAuth` — yet still flow through the shared `request` for 429 backoff and
 * transport wrapping. The createUploadSession POST itself is a normal Graph call (auth).
 */
export async function uploadSession(
	ctx: SessionCtx,
	parentId: string,
	name: string,
	content: ArrayBuffer,
	lastModifiedDateTime: string,
): Promise<OneDriveItem> {
	const createRes = await ctx.request("createUploadSession", {
		url: `${ctx.graphApi}/me/drive/items/${parentId}:/${encodeRelPath(name)}:/createUploadSession`,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			item: { "@microsoft.graph.conflictBehavior": "replace", fileSystemInfo: { lastModifiedDateTime } },
		}),
	});
	const { uploadUrl } = createRes.json as CreateSessionResponse;
	if (!uploadUrl) throw new Error("OneDrive createUploadSession returned no uploadUrl");

	const total = content.byteLength;
	let last: RequestUrlResponse | undefined;
	for (let start = 0; start < total; start += CHUNK_SIZE) {
		const end = Math.min(start + CHUNK_SIZE, total);
		last = await ctx.request(
			"uploadChunk",
			{
				url: uploadUrl,
				method: "PUT",
				// NO manual Content-Length: Obsidian's requestUrl (Electron net) derives it
				// from the body, and a hand-set one makes net throw ERR_INVALID_ARGUMENT
				// (same lesson as googledrive/resumable-upload.ts). Content-Range is required
				// by Graph and is fine.
				headers: {
					"Content-Range": `bytes ${start}-${end - 1}/${total}`,
				},
				body: content.slice(start, end),
			},
			undefined,
			true,
		);
	}
	if (!last) throw new Error("OneDrive upload session produced no final response (empty content?)");
	// The completed driveItem only comes back on the final chunk (200/201). A 202
	// (server still expecting bytes) or any id-less 2xx body would otherwise be cast
	// to an OneDriveItem and cache-keyed by an undefined id — fail loudly instead.
	const item = last.json as OneDriveItem;
	if (!item?.id) {
		throw new Error(`OneDrive upload session did not complete: no driveItem id in the final response for "${name}"`);
	}
	return item;
}
