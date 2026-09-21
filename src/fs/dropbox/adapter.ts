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
import { backendErrorFromStatus, failBackend, permanentErrorShape, retryAfterMsOf, toBackendError } from "../modules/error-shape";
import { AuthError } from "../errors";
import { LIST_PAGE_CAP } from "./client";
import type { DropboxClient } from "./client";
import type { DropboxEntry } from "./types";
import { DropboxApiError, isDropboxResetError } from "./types";
import { normalizeDropboxObject } from "./normalize-object";

const REV_PREFIX = "dropbox:";

/**
 * Dropbox {@link RemoteBackendAdapter} over the existing HTTP client.
 *
 * Dropbox is path-addressed: objects are located by the vault's stable folder id
 * plus a provider-resolved relative path. The adapter re-anchors that path from the
 * folder id on every operation (a remote move/rename is tracked for free) and reports
 * a delta tombstone as a path-addressed change, never a fabricated id.
 *
 * Provider preconditions: `upload` with `mode:add` refuses an occupied destination
 * and `mode:update(rev)` (with `strict_conflict`) only overwrites the exact revision;
 * `download` accepts the revision. `move_v2`/`delete_v2` carry no revision
 * precondition, so conditionalMetadataMutation is `false`.
 */
export class DropboxAdapter implements RemoteBackendAdapter {
	readonly capabilities: RemoteBackendCapabilities = {
		exclusiveCreate: true,
		conditionalContentUpdate: "all",
		conditionalMetadataMutation: false,
		versionBoundRead: "revision" as const,
	};
	private readonly client: DropboxClient;
	private readonly rootId: string;
	private rootPath = "";

	constructor(client: DropboxClient, rootId: string) {
		this.client = client;
		this.rootId = rootId;
	}

	async getStartCursor(): Promise<string> {
		await this.refreshRootPath();
		return this.map(() => this.client.getLatestCursor(this.rootId, true));
	}

	async listAll(): Promise<readonly RemoteObject[]> {
		await this.refreshRootPath();
		const entries = await this.map(() => this.client.listFolderAll(this.rootId, true));
		const objects: RemoteObject[] = [];
		for (const entry of entries) {
			const relative = this.relativize(entry.path_display);
			// `relative === ""` is the bound root folder itself, which `list_folder`
			// includes; only its descendants are vault objects.
			if (relative === null || relative === "" || entry[".tag"] === "deleted") continue;
			objects.push(normalizeDropboxObject(entry, this.rootId, relative));
		}
		return objects;
	}

	async assertRootAlive(): Promise<void> {
		await this.refreshRootPath();
	}

	async getChanges(cursor: string): Promise<RemoteChangeResult> {
		try {
			await this.refreshRootPath();
			const changes: RemoteChange[] = [];
			let page = await this.client.listFolderContinue(cursor);
			for (let guard = 0; ; guard++) {
				if (guard >= LIST_PAGE_CAP) throw new Error("Dropbox delta pagination did not terminate");
				for (const entry of page.entries) {
					const relative = this.relativize(entry.path_display);
					if (relative === null) continue;
					if (entry[".tag"] === "deleted") {
						changes.push({ kind: "delete", path: relative, pathAuthority: "provider_resolved" });
					} else {
						changes.push({ kind: "upsert", object: normalizeDropboxObject(entry, this.rootId, relative) });
					}
				}
				if (!page.has_more) return { kind: "changes", nextCursor: page.cursor, changes };
				page = await this.client.listFolderContinue(page.cursor);
			}
		} catch (err) {
			if (isDropboxResetError(err)) return { kind: "cursor_invalid" };
			throw toBackendError(translateDropboxError(err));
		}
	}

	async getById(id: string): Promise<RemoteObject | null> {
		await this.refreshRootPath();
		const entry = await this.fetchEntry(id);
		if (entry === null) return null;
		const relative = this.relativize(entry.path_display);
		return relative === null ? null : normalizeDropboxObject(entry, this.rootId, relative);
	}

	async getByPath(path: string): Promise<readonly RemoteObject[]> {
		if (path === "") return [];
		const entry = await this.fetchEntry(this.addr(path));
		if (entry === null) return [];
		return [normalizeDropboxObject(entry, this.rootId, path)];
	}

	async read(input: VersionBoundReadInput): Promise<VersionBoundReadResult> {
		await this.refreshRootPath();
		const entry = await this.fetchEntry(input.id);
		if (entry === null) return { kind: "target_changed" };
		const relative = this.relativize(entry.path_display);
		if (relative === null) return { kind: "target_changed" };
		const observed = normalizeDropboxObject(entry, this.rootId, relative);
		if (observed.kind !== "file" || observed.versionToken === undefined) {
			return { kind: "unverifiable", reason: "Dropbox reported no version evidence" };
		}
		if (input.versionToken === "" || observed.versionToken !== input.versionToken) {
			return { kind: "target_changed" };
		}
		const content = await this.map(() => this.client.download(input.id, revOf(input.versionToken)));
		return { kind: "content", object: observed, content };
	}

	async createFile(input: CreateFileInput): Promise<RemoteObject> {
		const destination = requirePath(input.destination);
		// `add` refuses an occupied destination, so a concurrent create cannot be
		// silently overwritten; Dropbox reports the conflict as a 409.
		const entry = await this.map(() =>
			this.client.upload(this.addr(destination.path), input.content, input.mtimeMs, "add"),
		);
		return normalizeDropboxObject(entry, this.rootId, destination.path);
	}

	async updateFile(input: UpdateFileInput): Promise<RemoteObject> {
		assertExpectedIdentity(input.expected, input.id);
		await this.refreshRootPath();
		const current = await this.fetchEntry(input.id);
		if (current === null) failBackend("not_found", `Dropbox entry ${input.id} was not found`);
		const relative = this.relativize(current.path_display);
		if (relative === null) failBackend("target_changed", `Dropbox entry ${input.id} left the bound root`);
		const observed = normalizeDropboxObject(current, this.rootId, relative);
		if (observed.kind !== "file" || observed.versionToken === undefined) {
			failBackend("unverifiable", "Dropbox reported no version evidence for update");
		}
		if (!matches(input.expected, observed.versionToken)) {
			failBackend("target_changed", `Dropbox entry ${input.id} changed before update`);
		}
		const observedRev = revOf(observed.versionToken);
		// Carry the revision to Dropbox itself: `update(rev)` overwrites only the
		// exact revision, and `strict_conflict` refuses even identical contents.
		const entry = await this.map(() =>
			this.client.upload(
				this.addr(relative),
				input.content,
				input.mtimeMs,
				{ ".tag": "update", update: observedRev },
				true,
			),
		);
		return normalizeDropboxObject(entry, this.rootId, relative);
	}

	async createDirectory(input: CreateDirectoryInput): Promise<RemoteObject> {
		const destination = requirePath(input.destination);
		const entry = await this.map(() => this.client.createFolder(this.addr(destination.path)));
		return normalizeDropboxObject(entry, this.rootId, destination.path);
	}

	async move(input: MoveInput): Promise<RemoteObject> {
		assertExpectedIdentity(input.expected, input.id);
		const destination = requirePath(input.destination);
		await this.refreshRootPath();
		const current = await this.fetchEntry(input.id);
		if (current === null) failBackend("not_found", `Dropbox entry ${input.id} was not found`);
		const relative = this.relativize(current.path_display);
		if (relative === null) failBackend("target_changed", `Dropbox entry ${input.id} left the bound root`);
		const observed = normalizeDropboxObject(current, this.rootId, relative);
		assertExpectedEvidence(input.expected, observed.versionToken, `Dropbox entry ${input.id}`, "move");
		// Dropbox's `move_v2` does not perform a case-only rename, so a lower/upper
		// spelling change runs as two moves through a deterministic intermediate
		// sibling path. This is provider mechanism and lives on the adapter.
		const entry = isCaseOnlyPathChange(relative, destination.path)
			? await this.moveCaseOnly(input.id, relative, destination.path)
			: await this.map(() => this.client.move(this.addr(relative), this.addr(destination.path)));
		return normalizeDropboxObject(entry, this.rootId, destination.path);
	}

	/** A case-only rename settled with an intermediate sibling path (see `DropboxFs`). */
	private async moveCaseOnly(identity: string, oldPath: string, newPath: string): Promise<DropboxEntry> {
		const tempPath = caseRenameTempPath(oldPath, identity);
		const existingTemp = await this.fetchEntry(this.addr(tempPath));
		if (existingTemp) {
			failBackend("target_changed", `Dropbox case-only rename temporary path is occupied: ${tempPath}`);
		}
		const destination = await this.fetchEntry(this.addr(newPath));
		if (destination && (destination.id !== identity || this.relativize(destination.path_display) === newPath)) {
			failBackend("target_changed", `Dropbox case-only rename destination is occupied: ${newPath}`);
		}

		try {
			await this.map(() => this.client.move(this.addr(oldPath), this.addr(tempPath)));
		} catch (err) {
			const settled = await this.caseRenameEndpoint(identity, oldPath, newPath, tempPath);
			if (settled?.path === newPath) return settled.entry;
			if (settled?.path !== tempPath) throw err;
		}

		try {
			return await this.map(() => this.client.move(this.addr(tempPath), this.addr(newPath)));
		} catch (err) {
			const settled = await this.caseRenameEndpoint(identity, oldPath, newPath, tempPath);
			if (settled?.path === newPath) return settled.entry;
			if (settled?.path === oldPath) throw err;
			if (settled?.path !== tempPath) {
				throw new Error("Dropbox case-only rename endpoint is indeterminate", { cause: err });
			}
			try {
				await this.map(() => this.client.move(this.addr(tempPath), this.addr(oldPath)));
			} catch (rollbackErr) {
				const afterRollback = await this.caseRenameEndpoint(identity, oldPath, newPath, tempPath);
				if (afterRollback?.path === oldPath) throw err;
				throw new Error(
					`Dropbox case-only rename failed and rollback failed: ` +
						`${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
					{ cause: err },
				);
			}
			const restored = await this.caseRenameEndpoint(identity, oldPath, newPath, tempPath);
			if (restored?.path !== oldPath) {
				throw new Error("Dropbox case-only rename rollback could not be verified", { cause: err });
			}
			throw err;
		}
	}

	private async caseRenameEndpoint(
		identity: string,
		...paths: string[]
	): Promise<{ path: string; entry: DropboxEntry } | null> {
		for (const path of paths) {
			const entry = await this.fetchEntry(this.addr(path));
			if (entry?.id === identity && this.relativize(entry.path_display) === path) {
				return { path, entry };
			}
		}
		return null;
	}

	async delete(input: DeleteInput): Promise<void> {
		assertExpectedIdentity(input.expected, input.id);
		await this.refreshRootPath();
		const current = await this.fetchEntry(input.id);
		if (current === null) return;
		const relative = this.relativize(current.path_display);
		if (relative === null) return;
		const observed = normalizeDropboxObject(current, this.rootId, relative);
		assertExpectedEvidence(input.expected, observed.versionToken, `Dropbox entry ${input.id}`, "delete");
		await this.map(() => this.client.deletePath(this.addr(relative)));
	}

	private addr(relativePath: string): string {
		return relativePath ? `${this.rootId}/${relativePath}` : this.rootId;
	}

	private relativize(absolute: string | undefined): string | null {
		if (!absolute) return null;
		const root = this.rootPath.replace(/\/$/, "");
		if (absolute === root) return "";
		return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : null;
	}

	private async refreshRootPath(): Promise<void> {
		const meta = await this.map(() => this.client.getMetadata(this.rootId));
		if (!meta.path_display) {
			failBackend("target_changed", `Bound Dropbox folder ${this.rootId} has no path`);
		}
		this.rootPath = meta.path_display;
	}

	private async fetchEntry(reference: string): Promise<DropboxEntry | null> {
		try {
			const entry = await this.client.getMetadata(reference);
			return entry[".tag"] === "deleted" ? null : entry;
		} catch (err) {
			if (err instanceof DropboxApiError && err.summary.includes("not_found")) return null;
			throw toBackendError(translateDropboxError(err));
		}
	}

	private async map<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (err) {
			throw toBackendError(translateDropboxError(err));
		}
	}
}

function requirePath(destination: DestinationAddress): { rootId: string; path: string } {
	if (destination.addressing !== "provider_path") {
		failBackend("permanent", "Dropbox adapter requires provider_path addressing");
	}
	return destination;
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
 * empty expected token means core has no version to enforce (e.g. a folder with no
 * provider version evidence), so the comparison is skipped as before.
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

/** The Dropbox revision encoded in a `dropbox:<rev>` version token. */
function revOf(versionToken: string): string {
	return versionToken.startsWith(REV_PREFIX) ? versionToken.slice(REV_PREFIX.length) : versionToken;
}

function isCaseOnlyPathChange(oldPath: string, newPath: string): boolean {
	return oldPath !== newPath && oldPath.toLowerCase() === newPath.toLowerCase();
}

/** Deterministic only to make collision checks stable within one invocation. */
function caseRenameTempPath(path: string, identity: string): string {
	let hash = 0x811c9dc5;
	for (const char of identity) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	const lastSlash = path.lastIndexOf("/");
	const parent = lastSlash === -1 ? "" : path.slice(0, lastSlash);
	const name = `.airsync-case-rename-${(hash >>> 0).toString(16).padStart(8, "0")}`;
	return parent ? `${parent}/${name}` : name;
}

/** Map a raw Dropbox client failure to the public error taxonomy. */
export function translateDropboxError(err: unknown): BackendErrorShape {
	if (isBackendError(err)) return err;
	const message = err instanceof Error ? err.message : "Dropbox request failed";
	const permanent = permanentErrorShape(err, message);
	if (permanent) return permanent;
	if (err instanceof AuthError) return backendError("auth", message);
	if (err instanceof DropboxApiError) {
		const retryAfterMs = retryAfterMsOf(err);
		if (isDropboxResetError(err)) return backendError("cursor_invalid", message);
		if (err.summary.includes("not_found")) return backendError("not_found", message);
		if (err.summary.includes("too_many_write_operations") || err.status === 429) {
			return backendError("rate_limit", message, { retryAfterMs });
		}
		return backendErrorFromStatus(err.status, message, { 409: "target_changed" }, retryAfterMs);
	}
	return backendError("transient", message);
}

function isBackendError(err: unknown): err is BackendErrorShape {
	return !!err && typeof err === "object" && typeof (err as { kind?: unknown }).kind === "string";
}
