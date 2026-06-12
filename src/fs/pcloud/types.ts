import type { FileEntity } from "../types";
import type { FileRecord } from "../../store/metadata-store";
import { AuthError } from "../errors";

/** pCloud-specific file record type alias (persisted in IndexedDB). */
export type PCloudFileRecord = FileRecord<PCloudEntry>;

/**
 * A pCloud file/folder metadata entry.
 *
 * `id` is the canonical join key across listfolder/stat/diff: `"d<folderid>"`
 * for folders and `"f<fileid>"` for files. `parentfolderid` is the *numeric*
 * folder id (not the `"d"`-prefixed `id`), so resolving a parent means looking
 * up `"d" + parentfolderid`.
 *
 * `hash` is pCloud's internal 64-bit content hash — stable when the content is
 * unchanged but NOT cryptographic and NOT reproducible from local content, so
 * it is surfaced as an `opaque` remoteChecksum (see {@link pcloudEntryToEntity}).
 *
 * Caveat: it arrives via JSON as a JS `number`, so values above 2^53 lose low
 * bits. This is stable per content (the same file always rounds the same way),
 * so temporal change detection is unaffected; the only theoretical impact is a
 * ~2^-53 chance that two *different* contents round to the same value — far below
 * other collision risks, and pCloud offers no string-typed hash to avoid it.
 */
export interface PCloudEntry {
	id: string;
	name: string;
	isfolder: boolean;
	parentfolderid?: number;
	created?: string;
	modified?: string;
	/** File only */
	fileid?: number;
	size?: number;
	hash?: number;
	contenttype?: string;
	/** Folder only */
	folderid?: number;
	/** Folder only, present in listfolder responses (stripped before caching). */
	contents?: PCloudEntry[];
}

/** Envelope fields common to every pCloud API JSON response. */
interface PCloudResult {
	result: number;
	error?: string;
}

export interface PCloudListFolderResponse extends PCloudResult {
	metadata: PCloudEntry;
}

export interface PCloudStatResponse extends PCloudResult {
	metadata: PCloudEntry;
}

export interface PCloudUploadResponse extends PCloudResult {
	metadata?: PCloudEntry[];
	fileids?: number[];
}

export interface PCloudFileLinkResponse extends PCloudResult {
	hosts: string[];
	path: string;
}

export interface PCloudFolderResponse extends PCloudResult {
	metadata: PCloudEntry;
}

export interface PCloudDeleteFolderResponse extends PCloudResult {
	deletedfiles?: number;
	deletedfolders?: number;
}

export interface PCloudDiffEntry {
	diffid: number;
	time?: string;
	event: string;
	metadata?: PCloudEntry;
}

export interface PCloudDiffResponse extends PCloudResult {
	diffid: number;
	entries: PCloudDiffEntry[];
}

export interface PCloudTokenResponse extends PCloudResult {
	access_token: string;
	token_type?: string;
	uid?: number;
	locationid?: number;
}

/**
 * pCloud `result` codes that mean "authentication is required / invalid".
 * These map to {@link AuthError} so the sync engine surfaces a reconnect prompt
 * instead of a generic failure. (1000 = log in required, 2000 = log in failed,
 * 2012 = invalid 'access_token', 2094/2095 = invalid/expired 'code', 4000 =
 * too many login tries.) The exact set is confirmed against the live API.
 */
const PCLOUD_AUTH_ERROR_CODES = new Set([1000, 2000, 2012, 2094, 2095, 4000]);

/**
 * pCloud result code: the called method is only available to a "full access" app.
 * A "Specific folder only" app gets this for account-wide methods like `diff`
 * (confirmed against the live API). Callers branch on it to disable the delta feed
 * and fall back to a full-scan reconcile — see `PCloudFs.getStartCursor`.
 */
export const PCLOUD_FULL_ACCESS_REQUIRED = 2096;

/**
 * A non-auth pCloud logical error (HTTP 200 + `result != 0`). Carries the numeric
 * `result` so callers can branch on a specific code (e.g. {@link PCLOUD_FULL_ACCESS_REQUIRED})
 * WITHOUT fragile message matching. Auth-class codes throw {@link AuthError} instead
 * (see {@link assertOk}).
 */
export class PCloudApiError extends Error {
	constructor(
		message: string,
		readonly result: number,
	) {
		super(message);
		this.name = "PCloudApiError";
	}
}

/**
 * Assert a pCloud response is logically OK. pCloud returns HTTP 200 even for
 * logical errors, signalling them via `result != 0`, so every call must check.
 *
 * @throws {AuthError} for authentication-class codes (401).
 * @throws {Error} for any other non-zero result.
 */
export function assertOk(json: unknown, op: string): asserts json is PCloudResult {
	if (!json || typeof json !== "object" || typeof (json as PCloudResult).result !== "number") {
		throw new Error(`pCloud API ${op} failed: malformed response`);
	}
	const result = (json as PCloudResult).result;
	if (result === 0) return;
	const error = typeof (json as PCloudResult).error === "string" ? (json as PCloudResult).error : "";
	const message = `pCloud API ${op} failed: ${result} ${error}`.trimEnd();
	if (PCLOUD_AUTH_ERROR_CODES.has(result)) {
		throw new AuthError(message, 401);
	}
	throw new PCloudApiError(message, result);
}

/** Parse a pCloud `modified`/`created` datetime to epoch ms (0 when absent/invalid). */
export function parsePCloudTime(value: string | undefined): number {
	if (!value) return 0;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? 0 : ms;
}

/** Return the folder id (as a string) of a folder entry. */
export function folderIdOf(entry: PCloudEntry): string {
	return String(entry.folderid ?? "");
}

/** Drop the recursive `contents` array so cached/persisted entries stay flat. */
export function withoutContents(entry: PCloudEntry): PCloudEntry {
	if (!entry.contents) return entry;
	const copy = { ...entry };
	delete copy.contents;
	return copy;
}

/**
 * Build a FileEntity from a cached pCloud entry (no download).
 *
 * `hash` is always `""` — computing the SHA-256 would require downloading the
 * content. The sync engine relies on `remoteChecksum` instead: pCloud's `hash`
 * is surfaced as `opaque` because it is a stable per-content value that rides
 * for free on listfolder/stat/diff but cannot be reproduced locally.
 */
export function pcloudEntryToEntity(path: string, entry: PCloudEntry): FileEntity {
	if (entry.isfolder) {
		return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
	}
	return {
		path,
		isDirectory: false,
		size: entry.size ?? 0,
		mtime: parsePCloudTime(entry.modified),
		hash: "",
		remoteChecksum: entry.hash != null ? { algo: "opaque", value: String(entry.hash) } : undefined,
		backendMeta: { pcloudId: entry.id },
	};
}
