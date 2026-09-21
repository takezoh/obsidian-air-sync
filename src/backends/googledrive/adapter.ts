import type {
	BackendErrorShape,
	CreateDirectoryInput,
	CreateFileInput,
	DeleteInput,
	DestinationAddress,
	ExpectedVersion,
	MoveInput,
	RemoteBackendAdapter,
	RemoteBackendCapabilities,
	RemoteChange,
	RemoteChangeResult,
	RemoteObject,
	UpdateFileInput,
	VersionBoundReadInput,
	VersionBoundReadResult,
} from "../../backend-api";
import { backendError } from "../../backend-api";
import { backendErrorFromStatus, failBackend, permanentErrorShape, retryAfterMsOf, toBackendError } from "../shared/error-shape";
import { AuthError } from "../../backend-api/error-classification";
import { LIST_PAGE_CAP } from "./client";
import type { GoogleDriveClient } from "./client";
import type { GoogleDriveChange, GoogleDriveFile } from "./types";
import { FOLDER_MIME, isGoogleDriveTrashed } from "./types";
import { normalizeGoogleDriveObject } from "./normalize-object";
import { inspectGoogleDriveFolder } from "./folder-usability";

/**
 * Google Drive {@link RemoteBackendAdapter} over the existing typed REST client.
 *
 * It reports provider facts and performs provider mutations only: identity
 * (Drive file id), topology (`parents[0]`, with the bound root preferred), content
 * (md5), and version evidence (`googledrive:v:<version>`). Cursor lifecycle,
 * the normalized cache, and checkpointing belong to core.
 *
 * Drive v3 exposes no provider-side precondition on `files.update`/`files.delete`
 * (verified against the discovery document: no version/revision parameter and no
 * documented `If-Match`), so the adapter declares those capabilities `false` and
 * compares before mutating. `read` binds bytes by re-observing `version` after the
 * download.
 *
 * A `changes.list` drain that reports a changed FOLDER may omit that folder's
 * unchanged descendants, so the adapter completes the delta by re-listing every
 * changed folder's subtree. That is provider fact completion, not scope state: the
 * subtree listing is the same authoritative `files.list` a cold scan uses, and the
 * resulting upserts are idempotent for ids already in the working view.
 */
export class GoogleDriveAdapter implements RemoteBackendAdapter {
	readonly capabilities: RemoteBackendCapabilities = {
		exclusiveCreate: false,
		conditionalContentUpdate: "none",
		conditionalMetadataMutation: false,
		versionBoundRead: "reobserve" as const,
	};
	private readonly client: GoogleDriveClient;
	private readonly rootId: string;

	constructor(client: GoogleDriveClient, rootId: string) {
		this.client = client;
		this.rootId = rootId;
	}

	async getStartCursor(): Promise<string> {
		return this.map(() => this.client.getChangesStartToken());
	}

	async listAll(): Promise<readonly RemoteObject[]> {
		const files = await this.map(() => this.client.listAllFiles(this.rootId));
		return files.map((file) => normalizeGoogleDriveObject(file, this.rootId));
	}

	async assertRootAlive(): Promise<void> {
		let inspection;
		try {
			inspection = await inspectGoogleDriveFolder(this.client, this.rootId);
		} catch (err) {
			throw toBackendError(this.translate(err));
		}
		if (inspection.usable) return;
		switch (inspection.problem) {
			case "trashed":
				failBackend("target_changed", "Bound Google Drive folder is in Trash");
				break;
			case "not_folder":
				failBackend("target_changed", "Bound Google Drive id does not name a folder");
				break;
			case "not_found":
				failBackend("not_found", "Bound Google Drive folder was not found");
				break;
			case "inaccessible":
				failBackend("permission", "Bound Google Drive folder is not accessible");
				break;
		}
	}

	async getChanges(cursor: string): Promise<RemoteChangeResult> {
		try {
			const changes: RemoteChange[] = [];
			const changedFolderIds = new Set<string>();
			let pageToken: string | undefined;
			let nextCursor = cursor;
			for (let guard = 0; ; guard++) {
				if (guard >= LIST_PAGE_CAP) {
					throw new Error("Google Drive changes pagination did not terminate");
				}
				const page = await this.client.listChanges(cursor, pageToken);
				collectChanges(page.changes, changes, changedFolderIds, this.rootId);
				if (page.newStartPageToken) nextCursor = page.newStartPageToken;
				pageToken = page.nextPageToken;
				if (!pageToken) break;
			}
			// A changed folder's unchanged descendants produce no change of their own;
			// complete them from the provider's own subtree listing.
			for (const folderId of changedFolderIds) {
				const descendants = await this.client.listAllFiles(folderId);
				for (const file of descendants) {
					changes.push({ kind: "upsert", object: normalizeGoogleDriveObject(file, this.rootId) });
				}
			}
			return { kind: "changes", nextCursor, changes };
		} catch (err) {
			if (isStatus(err, 410)) return { kind: "cursor_invalid" };
			throw toBackendError(this.translate(err));
		}
	}

	async getById(id: string): Promise<RemoteObject | null> {
		const file = await this.fetchFile(id);
		return file === null ? null : normalizeGoogleDriveObject(file, this.rootId);
	}

	async getByPath(path: string): Promise<readonly RemoteObject[]> {
		if (path === "") return [];
		let parentId = this.rootId;
		const segments = path.split("/");
		for (const [index, segment] of segments.entries()) {
			const candidates = await this.map(() => this.client.listChildrenByName(parentId, segment));
			if (index === segments.length - 1) {
				return candidates
					.filter((file) => !isGoogleDriveTrashed(file))
					.map((file) => normalizeGoogleDriveObject(file, this.rootId));
			}
			if (candidates.length !== 1 || candidates[0]!.mimeType !== FOLDER_MIME) return [];
			parentId = candidates[0]!.id;
		}
		return [];
	}

	async read(input: VersionBoundReadInput): Promise<VersionBoundReadResult> {
		const file = await this.fetchFile(input.id);
		if (file === null) return { kind: "target_changed" };
		const observed = normalizeGoogleDriveObject(file, this.rootId);
		if (observed.kind !== "file" || observed.versionToken === undefined) {
			return { kind: "unverifiable", reason: "Google Drive reported no version evidence" };
		}
		if (input.versionToken === "" || observed.versionToken !== input.versionToken) {
			return { kind: "target_changed" };
		}
		const content = await this.map(() => this.client.downloadFile(input.id));
		// Bind the bytes to the observed version: Drive has no revision-addressed
		// media read on this route, so re-observe the monotonic `version` and fail
		// closed if it advanced while the download ran.
		const after = await this.fetchFile(input.id);
		if (after === null) return { kind: "target_changed" };
		if (normalizeGoogleDriveObject(after, this.rootId).versionToken !== observed.versionToken) {
			return { kind: "target_changed" };
		}
		return { kind: "content", object: observed, content };
	}

	async createFile(input: CreateFileInput): Promise<RemoteObject> {
		const destination = requireParentId(input.destination);
		const file = await this.map(() =>
			this.client.uploadFile(
				destination.name,
				destination.parentId ?? this.rootId,
				input.content,
				"application/octet-stream",
				undefined,
				input.mtimeMs,
			),
		);
		return normalizeGoogleDriveObject(file, this.rootId);
	}

	async updateFile(input: UpdateFileInput): Promise<RemoteObject> {
		assertExpectedIdentity(input.expected, input.id);
		const current = await this.fetchFile(input.id);
		if (current === null) failBackend("not_found", `Google Drive file ${input.id} was not found`);
		const observed = normalizeGoogleDriveObject(current, this.rootId);
		if (observed.kind !== "file" || observed.versionToken === undefined) {
			failBackend("unverifiable", "Google Drive reported no version evidence for update");
		}
		if (!matches(input.expected, observed.versionToken)) {
			failBackend("target_changed", `Google Drive file ${input.id} changed before update`);
		}
		const file = await this.map(() =>
			this.client.uploadFile(
				observed.name,
				parentIdOf(observed, this.rootId),
				input.content,
				"application/octet-stream",
				input.id,
				input.mtimeMs,
			),
		);
		return normalizeGoogleDriveObject(file, this.rootId);
	}

	async createDirectory(input: CreateDirectoryInput): Promise<RemoteObject> {
		const destination = requireParentId(input.destination);
		const folder = await this.map(() =>
			this.client.createFolder(destination.name, destination.parentId ?? this.rootId),
		);
		return normalizeGoogleDriveObject(folder, this.rootId);
	}

	async move(input: MoveInput): Promise<RemoteObject> {
		assertExpectedIdentity(input.expected, input.id);
		const destination = requireParentId(input.destination);
		const current = await this.fetchFile(input.id);
		if (current === null) failBackend("not_found", `Google Drive file ${input.id} was not found`);
		const observed = normalizeGoogleDriveObject(current, this.rootId);
		assertExpectedEvidence(input.expected, observed.versionToken, `Google Drive file ${input.id}`, "move");
		const oldParents = current.parents ?? [];
		const newParentId = destination.parentId ?? this.rootId;
		const addParents = oldParents.includes(newParentId) ? undefined : newParentId;
		const removeParents = addParents === undefined ? undefined : oldParents.join(",");
		const metadata = current.name === destination.name ? {} : { name: destination.name };
		const file = await this.map(() =>
			this.client.updateFileMetadata(input.id, metadata, addParents, removeParents),
		);
		return normalizeGoogleDriveObject(file, this.rootId);
	}

	async delete(input: DeleteInput): Promise<void> {
		assertExpectedIdentity(input.expected, input.id);
		const current = await this.fetchFile(input.id);
		if (current === null) return;
		const observed = normalizeGoogleDriveObject(current, this.rootId);
		assertExpectedEvidence(input.expected, observed.versionToken, `Google Drive file ${input.id}`, "delete");
		await this.map(() => this.client.deleteFile(input.id));
	}

	private async fetchFile(id: string): Promise<GoogleDriveFile | null> {
		try {
			const file = await this.client.getFile(id);
			return isGoogleDriveTrashed(file) ? null : file;
		} catch (err) {
			if (isStatus(err, 404)) return null;
			throw toBackendError(this.translate(err));
		}
	}

	/** Run a client call, translating a provider failure into the public taxonomy. */
	private async map<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (err) {
			throw toBackendError(this.translate(err));
		}
	}

	private translate(err: unknown): BackendErrorShape {
		return translateGoogleDriveError(err);
	}
}

function collectChanges(
	changes: readonly GoogleDriveChange[],
	out: RemoteChange[],
	changedFolders: Set<string>,
	rootId: string,
): void {
	for (const change of changes) {
		if (change.removed || isGoogleDriveTrashed(change.file)) {
			out.push({ kind: "delete", id: change.fileId });
			continue;
		}
		if (!change.file) continue;
		out.push({ kind: "upsert", object: normalizeGoogleDriveObject(change.file, rootId) });
		if (change.file.mimeType === FOLDER_MIME) changedFolders.add(change.file.id);
	}
}

function requireParentId(destination: DestinationAddress): { parentId: string | null; name: string } {
	if (destination.addressing !== "parent_id") {
		failBackend("permanent", "Google Drive adapter requires parent_id addressing");
	}
	return destination;
}

function parentIdOf(object: RemoteObject, rootId: string): string {
	if (object.location.addressing !== "parent_id") return rootId;
	return object.location.parentId ?? rootId;
}

function matches(expected: ExpectedVersion, observedToken: string): boolean {
	return expected.versionToken === observedToken;
}

/** A caller's expected version must name the object it is mutating. */
function assertExpectedIdentity(expected: ExpectedVersion, id: string): void {
	if (expected.id !== id) {
		failBackend("target_changed", `Expected version names ${expected.id}, not ${id}`);
	}
}

/**
 * Fail closed before a provider mutation when core holds a real version expectation
 * (`expected.versionToken !== ""`) that the current observation cannot re-prove. An
 * empty expected token means core has no version to enforce (e.g. a folder), so the
 * comparison is skipped as before.
 */
function assertExpectedEvidence(
	expected: ExpectedVersion,
	observedToken: string | undefined,
	subject: string,
	operation: string,
): void {
	// The provider has no metadata precondition here, so an empty expected token means
	// core holds no version to enforce; a real token that cannot be re-proven still
	// fails closed before any provider mutation.
	if (expected.versionToken === "") return;
	if (observedToken === undefined) {
		failBackend("unverifiable", `${subject} has no version evidence for ${operation}`);
	}
	if (!matches(expected, observedToken)) {
		failBackend("target_changed", `${subject} changed before ${operation}`);
	}
}

function isStatus(err: unknown, status: number): boolean {
	return !!err && typeof err === "object" && (err as { status?: unknown }).status === status;
}

/** Map a raw Google Drive client failure to the public error taxonomy. */
export function translateGoogleDriveError(err: unknown): BackendErrorShape {
	if (isBackendError(err)) return err;
	const message = err instanceof Error ? err.message : "Google Drive request failed";
	const permanent = permanentErrorShape(err, message);
	if (permanent) return permanent;
	if (err instanceof AuthError) return backendError("auth", message);
	const rawStatus = (err as { status?: unknown } | null)?.status;
	const status = typeof rawStatus === "number" ? rawStatus : 0;
	const retryAfterMs = retryAfterMsOf(err);
	switch (status) {
		case 403:
			return isRateLimit(err)
				? backendError("rate_limit", message, { retryAfterMs })
				: backendError("permission", message);
		default:
			return backendErrorFromStatus(status, message, { 410: "cursor_invalid" }, retryAfterMs);
	}
}

function isBackendError(err: unknown): err is BackendErrorShape {
	return !!err && typeof err === "object" && typeof (err as { kind?: unknown }).kind === "string";
}

/** Google Drive overloads 403 for both permission and rate limit; only the reason tells them apart. */
function isRateLimit(err: unknown): boolean {
	const raw = err as { json?: { error?: { errors?: readonly { reason?: string }[] } } };
	const reasons = raw?.json?.error?.errors ?? [];
	return reasons.some((entry) =>
		entry.reason === "rateLimitExceeded"
		|| entry.reason === "userRateLimitExceeded"
		|| entry.reason === "dailyLimitExceeded",
	);
}
