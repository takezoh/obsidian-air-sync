import type { FileEntity, RemoteChecksum } from "../types";
import { AuthError } from "../errors";

/**
 * A Microsoft Graph `driveItem` (the subset Air Sync uses).
 *
 * OneDrive is id-addressed: every item carries a stable `id`, and references its
 * parent by id (`parentReference.id`) — exactly like Google Drive's `parents[]`.
 * That is what lets the shared id-chain path resolver in {@link AbstractMetadataCache}
 * drive OneDrive unchanged (a single-element parent array).
 *
 * Personal OneDrive provides `file.hashes.quickXorHash` (Microsoft's QuickXorHash,
 * base64) — and NOT sha1Hash/sha256Hash, which are Business/SharePoint only. It is
 * reproducible from local content (see utils/quickxor), so it powers cross-side
 * dedup. A `deleted` facet marks a tombstone in a delta response (item is gone).
 */
export interface OneDriveItem {
	id: string;
	name: string;
	size?: number;
	parentReference?: { id?: string; path?: string };
	file?: { hashes?: { sha1Hash?: string; quickXorHash?: string; sha256Hash?: string } };
	folder?: { childCount?: number };
	fileSystemInfo?: { lastModifiedDateTime?: string };
	lastModifiedDateTime?: string;
	deleted?: { state?: string };
}

/**
 * A driveItem GET that also carries `@microsoft.graph.downloadUrl` — a short-lived,
 * pre-authenticated content URL Graph returns by default for file items. Downloads
 * fetch this and GET it WITHOUT a bearer (see {@link OneDriveClient.download}), which
 * sidesteps the `/content` 302 redirect that would otherwise forward a stale
 * `Authorization` header to the CDN host and 401.
 */
export interface OneDriveItemWithDownloadUrl extends OneDriveItem {
	"@microsoft.graph.downloadUrl"?: string;
}

/** A page of a `/delta` enumeration. */
export interface OneDriveDeltaResponse {
	value: OneDriveItem[];
	"@odata.nextLink"?: string;
	"@odata.deltaLink"?: string;
}

/** A page of a `/children` listing. */
export interface OneDriveChildrenResponse {
	value: OneDriveItem[];
	"@odata.nextLink"?: string;
}

/** Microsoft identity-platform token response (consumers authority). */
export interface MicrosoftTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type?: string;
}

/**
 * Validate a Microsoft token-endpoint response before storing it. A missing or
 * non-numeric `expires_in` would otherwise make `accessTokenExpiry = NaN`, so the
 * skew guard `now < expiry - 60s` is ALWAYS false → a token refresh on every
 * single request. Reject such a response loudly instead.
 */
export function assertMicrosoftTokenResponse(json: unknown): asserts json is MicrosoftTokenResponse {
	const obj = json as Record<string, unknown> | null;
	if (
		!obj ||
		typeof obj !== "object" ||
		typeof obj.access_token !== "string" ||
		typeof obj.expires_in !== "number" ||
		!Number.isFinite(obj.expires_in) ||
		obj.expires_in <= 0
	) {
		throw new Error("Invalid Microsoft token response: missing or invalid access_token / expires_in");
	}
}

/** Shape of a Microsoft Graph JSON error body. */
interface GraphErrorBody {
	error?: { code?: string; message?: string; innerError?: unknown };
}

/**
 * A Microsoft Graph API error that is NOT authentication-class. Carries the HTTP
 * status and the Graph error `code` so callers can branch on endpoint-specific
 * codes (e.g. a delta 410 resync, a 409 name conflict). Auth-class failures throw
 * {@link AuthError} instead.
 */
export class GraphApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
		this.name = "GraphApiError";
	}
}

/**
 * Graph error `code` values (or a 401 status) that mean "authentication is
 * required / invalid" → mapped to {@link AuthError} so the sync engine surfaces a
 * reconnect prompt and the client refreshes/retries once.
 */
const AUTH_ERROR_CODES = new Set([
	"InvalidAuthenticationToken",
	"unauthenticated",
	"AuthenticationError",
	"tokenExpired",
]);

/**
 * Assert a Graph HTTP response is OK. Obsidian's `requestUrl` is called with
 * `throw: false`, so non-2xx responses reach here for inspection of the status
 * and JSON error `code`.
 *
 * @throws {AuthError} for 401 / auth-class codes.
 * @throws {GraphApiError} for any other non-2xx (409 conflicts, 410 resync, 429
 *   rate limits, 5xx), preserving the status and error `code`.
 */
export function assertOk(res: { status: number; json?: unknown; text?: string }, op: string): void {
	if (res.status >= 200 && res.status < 300) return;
	let body: GraphErrorBody | undefined;
	try {
		body = res.json as GraphErrorBody | undefined;
	} catch {
		body = undefined;
	}
	const code = body?.error?.code ?? "";
	const detail = body?.error?.message ?? (typeof res.text === "string" ? res.text : "");
	const suffix = code || detail;
	const message = suffix
		? `OneDrive API ${op} failed: ${res.status} ${suffix}`
		: `OneDrive API ${op} failed: ${res.status}`;
	if (res.status === 401 || AUTH_ERROR_CODES.has(code)) {
		throw new AuthError(message, 401);
	}
	throw new GraphApiError(message, res.status, code);
}

/** Whether an error is a Graph 410 Gone (delta cursor expired → resync required). */
export function isGraphResyncError(err: unknown): boolean {
	return err instanceof GraphApiError && err.status === 410;
}

/** True for a folder item. */
export function isFolderEntry(item: OneDriveItem): boolean {
	return !!item.folder;
}

/**
 * Map a driveItem's hashes to a typed RemoteChecksum. Personal OneDrive (the only
 * supported account type) returns ONLY `quickXorHash` — Microsoft dropped `sha1Hash`
 * for consumer accounts (verified against the live API) — so prefer it; it is locally
 * reproducible via {@link ../../utils/quickxor}, so it drives cross-side dedup just
 * like Google Drive's md5. `sha256Hash`/`sha1Hash` are kept as fallbacks for the
 * Business/SharePoint shape (lowercased, since Graph reports those uppercase while a
 * local digest is lowercase). Returns undefined when none is present (e.g. a folder).
 */
export function toRemoteChecksum(item: OneDriveItem): RemoteChecksum | undefined {
	const hashes = item.file?.hashes;
	if (hashes?.quickXorHash) return { algo: "quickxor", value: hashes.quickXorHash };
	if (hashes?.sha256Hash) return { algo: "sha256", value: hashes.sha256Hash.toLowerCase() };
	if (hashes?.sha1Hash) return { algo: "sha1", value: hashes.sha1Hash.toLowerCase() };
	return undefined;
}

/** Parse a Graph ISO8601 timestamp to epoch ms (0 if absent/invalid). */
export function parseGraphTime(value: string | undefined): number {
	if (!value) return 0;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? 0 : ms;
}

/** Percent-encode a vault-relative path for Graph's `:/path:` addressing (preserve `/`). */
export function encodeRelPath(relPath: string): string {
	return relPath.split("/").map(encodeURIComponent).join("/");
}

/** The mtime source for an item: fileSystemInfo first, then the item's own time. */
export function itemMtime(item: OneDriveItem): number {
	return parseGraphTime(item.fileSystemInfo?.lastModifiedDateTime ?? item.lastModifiedDateTime);
}

/**
 * Build a FileEntity from a cached driveItem (no download).
 *
 * `hash` is always `""` — the sync engine relies on `remoteChecksum` (the
 * `quickXorHash`, locally reproducible) for temporal change detection and cross-side
 * dedup. `mtime` uses `fileSystemInfo.lastModifiedDateTime` (the preserved local
 * time), falling back to the server `lastModifiedDateTime`.
 */
export function oneDriveItemToEntity(path: string, item: OneDriveItem): FileEntity {
	if (isFolderEntry(item)) {
		return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
	}
	return {
		path,
		isDirectory: false,
		size: item.size ?? 0,
		mtime: itemMtime(item),
		hash: "",
		remoteChecksum: toRemoteChecksum(item),
		backendMeta: { oneDriveId: item.id },
	};
}
