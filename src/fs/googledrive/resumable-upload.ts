import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { Logger } from "../../logging/logger";
import { getHeader, headerKeys } from "../headers";
import type { GoogleDriveFile } from "./types";
import { assertGoogleDriveFile, buildUploadMetadata } from "./types";

const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,parents,md5Checksum";
export const RESUMABLE_THRESHOLD = 5 * 1024 * 1024; // 5MB

/** Dependencies injected by GoogleDriveClient */
export interface ResumableUploadDeps {
	getToken: (forceRefresh?: boolean) => Promise<string>;
	request: (
		operation: string,
		opts: RequestUrlParam
	) => Promise<RequestUrlResponse>;
	logger?: Logger;
}

/**
 * Handles large-file (>5MB) uploads to Google Drive via the resumable-upload
 * endpoint: open a session, then PUT the whole content in one request.
 *
 * The content is sent in a SINGLE PUT, never chunked: Obsidian's requestUrl
 * (Electron net module) cannot reliably handle the `308 Resume Incomplete`
 * responses chunking depends on (an empty body triggers JSON parse errors, and
 * manual Content-Length headers cause ERR_INVALID_ARGUMENT). A failed PUT is
 * simply retried as a fresh upload on the next sync cycle — Drive's resumable
 * session is only an envelope for the single PUT, not a byte-range resume.
 */
export class ResumableUploader {
	private deps: ResumableUploadDeps;

	constructor(deps: ResumableUploadDeps) {
		this.deps = deps;
	}

	/** Resumable-endpoint upload for large files (>5MB), sent as one PUT. */
	async upload(
		name: string,
		parentId: string,
		content: ArrayBuffer,
		mimeType = "application/octet-stream",
		existingFileId?: string,
		modifiedTime: number = Date.now()
	): Promise<GoogleDriveFile> {
		const token = await this.deps.getToken();
		const metadata = buildUploadMetadata(name, parentId, modifiedTime, existingFileId);

		// Initiate resumable upload
		const initUrl = existingFileId
			? `${UPLOAD_API}/files/${existingFileId}?uploadType=resumable&fields=${FILE_FIELDS}`
			: `${UPLOAD_API}/files?uploadType=resumable&fields=${FILE_FIELDS}`;
		const method = existingFileId ? "PATCH" : "POST";

		const initResponse = await this.deps.request("uploadFileResumable:init", {
			url: initUrl,
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=UTF-8",
				"X-Upload-Content-Type": mimeType,
				"X-Upload-Content-Length": String(content.byteLength),
			},
			body: JSON.stringify(metadata),
		});

		const uploadUrl = getHeader(initResponse.headers, "location");
		if (!uploadUrl) {
			const keys = headerKeys(initResponse.headers);
			const error = new Error(
				`Resumable upload: no upload URL in response (status ${initResponse.status}; headers: ${keys.length > 0 ? keys.join(", ") : "none"})`
			);
			Object.assign(error, {
				permanent: true,
				status: initResponse.status,
				headers: initResponse.headers,
			});
			throw error;
		}

		// Upload the entire content in a single PUT (see class doc for why not chunked).
		const uploadResponse = await this.deps.request("uploadFileResumable:upload", {
			url: uploadUrl,
			method: "PUT",
			headers: {
				"Content-Type": mimeType,
			},
			body: content.byteLength > 0 ? content : new ArrayBuffer(0),
		});
		const googleDriveFile: unknown = uploadResponse.json;
		assertGoogleDriveFile(googleDriveFile);
		return googleDriveFile;
	}
}
