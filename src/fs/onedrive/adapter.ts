import type {
	BackendErrorShape,
	CreateDirectoryInput,
	CreateFileInput,
	DeleteInput,
	DestinationAddress,
	ExpectedVersion,
	MoveInput,
	RemoteBackendAdapter,
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
import type { OneDriveClient } from "./client";
import type { OneDriveItem } from "./types";
import { GraphApiError, isFolderEntry } from "./types";
import { normalizeOneDriveObject } from "./normalize-object";

/**
 * OneDrive {@link RemoteBackendAdapter} over the existing Microsoft Graph client.
 *
 * Identity is the driveItem id; topology is `parentReference.id`; content is the
 * QuickXorHash; version evidence is `onedrive:<cTag|eTag>`. Cursor lifecycle, the
 * normalized cache, and checkpointing belong to core.
 */
export class OneDriveAdapter implements RemoteBackendAdapter {
	private readonly client: OneDriveClient;
	private readonly rootId: string;

	constructor(client: OneDriveClient, rootId: string) {
		this.client = client;
		this.rootId = rootId;
	}

	async getStartCursor(): Promise<string> {
		return this.map(() => this.client.getStartCursor(this.rootId));
	}

	async listAll(): Promise<readonly RemoteObject[]> {
		const items = await this.map(() => this.client.fullList(this.rootId));
		return items.filter((item) => item.id !== this.rootId && !item.deleted).map(normalizeOneDriveObject);
	}

	async assertRootAlive(): Promise<void> {
		try {
			await this.client.getItem(this.rootId);
		} catch (err) {
			if (err instanceof GraphApiError && err.status === 404) {
				failBackend("target_changed", `Bound OneDrive folder was deleted (id: ${this.rootId})`);
			}
			throw toBackendError(translateOneDriveError(err));
		}
	}

	async getChanges(cursor: string): Promise<RemoteChangeResult> {
		try {
			const changes: RemoteChange[] = [];
			let link: string | undefined = cursor;
			let nextCursor: string | undefined;
			for (let guard = 0; link; guard++) {
				if (guard >= LIST_PAGE_CAP) throw new Error("OneDrive delta pagination did not terminate");
				const page = await this.client.fetchDelta(this.rootId, link);
				for (const item of page.value) {
					if (item.id === this.rootId) continue;
					if (item.deleted) changes.push({ kind: "delete", id: item.id });
					else changes.push({ kind: "upsert", object: normalizeOneDriveObject(item) });
				}
				link = page["@odata.nextLink"];
				nextCursor = page["@odata.deltaLink"] ?? nextCursor;
			}
			if (!nextCursor) throw new Error("OneDrive delta terminated without a deltaLink");
			return { kind: "changes", nextCursor, changes };
		} catch (err) {
			if (err instanceof GraphApiError && err.status === 410) return { kind: "cursor_invalid" };
			throw toBackendError(translateOneDriveError(err));
		}
	}

	async getById(id: string): Promise<RemoteObject | null> {
		const item = await this.fetchItem(id);
		return item === null ? null : normalizeOneDriveObject(item);
	}

	async getByPath(path: string): Promise<readonly RemoteObject[]> {
		if (path === "") return [];
		let parentId = this.rootId;
		const segments = path.split("/");
		for (const [index, segment] of segments.entries()) {
			let item: OneDriveItem;
			try {
				item = await this.client.getChildByName(parentId, segment);
			} catch (err) {
				if (err instanceof GraphApiError && err.status === 404) return [];
				throw toBackendError(translateOneDriveError(err));
			}
			if (index === segments.length - 1) return [normalizeOneDriveObject(item)];
			if (!isFolderEntry(item)) return [];
			parentId = item.id;
		}
		return [];
	}

	async read(input: VersionBoundReadInput): Promise<VersionBoundReadResult> {
		const item = await this.fetchItem(input.id);
		if (item === null) return { kind: "target_changed" };
		const observed = normalizeOneDriveObject(item);
		if (observed.kind !== "file" || observed.versionToken === undefined) {
			return { kind: "unverifiable", reason: "OneDrive reported no version evidence" };
		}
		if (input.versionToken === "" || observed.versionToken !== input.versionToken) {
			return { kind: "target_changed" };
		}
		const content = await this.map(() => this.client.download(input.id));
		return { kind: "content", object: observed, content };
	}

	async createFile(input: CreateFileInput): Promise<RemoteObject> {
		const destination = requireParentId(input.destination);
		const item = await this.map(() =>
			this.client.upload(destination.parentId ?? this.rootId, destination.name, input.content, input.mtimeMs),
		);
		return normalizeOneDriveObject(item);
	}

	async updateFile(input: UpdateFileInput): Promise<RemoteObject> {
		const current = await this.fetchItem(input.id);
		if (current === null) failBackend("not_found", `OneDrive item ${input.id} was not found`);
		const observed = normalizeOneDriveObject(current);
		if (observed.kind !== "file" || observed.versionToken === undefined) {
			failBackend("unverifiable", "OneDrive reported no version evidence for update");
		}
		if (!matches(input.expected, observed.versionToken)) {
			failBackend("target_changed", `OneDrive item ${input.id} changed before update`);
		}
		const item = await this.map(() =>
			this.client.upload(parentIdOf(observed, this.rootId), observed.name, input.content, input.mtimeMs),
		);
		return normalizeOneDriveObject(item);
	}

	async createDirectory(input: CreateDirectoryInput): Promise<RemoteObject> {
		const destination = requireParentId(input.destination);
		const item = await this.map(() =>
			this.client.createFolder(destination.parentId ?? this.rootId, destination.name),
		);
		return normalizeOneDriveObject(item);
	}

	async move(input: MoveInput): Promise<RemoteObject> {
		const destination = requireParentId(input.destination);
		const current = await this.fetchItem(input.id);
		if (current === null) failBackend("not_found", `OneDrive item ${input.id} was not found`);
		const observed = normalizeOneDriveObject(current);
		// A directory's cTag/eTag tracks its CHILDREN too, so it is not a content
		// version and must not gate a move — the legacy path sent no precondition for
		// folders. Only a file's version is meaningful here.
		if (input.expected && observed.kind === "file" && observed.versionToken !== undefined && !matches(input.expected, observed.versionToken)) {
			failBackend("target_changed", `OneDrive item ${input.id} changed before move`);
		}
		const newParentId = destination.parentId ?? this.rootId;
		const parentChanged = parentIdOf(observed, this.rootId) !== newParentId;
		const name = current.name === destination.name ? undefined : destination.name;
		const item = await this.map(() =>
			this.client.move(input.id, name, parentChanged ? newParentId : undefined),
		);
		return normalizeOneDriveObject(item);
	}

	async delete(input: DeleteInput): Promise<void> {
		const current = await this.fetchItem(input.id);
		if (current === null) return;
		const observed = normalizeOneDriveObject(current);
		// See move(): a directory's tag is not a content version.
		if (input.expected && observed.kind === "file" && observed.versionToken !== undefined && !matches(input.expected, observed.versionToken)) {
			failBackend("target_changed", `OneDrive item ${input.id} changed before delete`);
		}
		await this.map(() => this.client.deleteItem(input.id));
	}

	private async fetchItem(id: string): Promise<OneDriveItem | null> {
		try {
			const item = await this.client.getItem(id);
			return item.deleted ? null : item;
		} catch (err) {
			if (err instanceof GraphApiError && err.status === 404) return null;
			throw toBackendError(translateOneDriveError(err));
		}
	}

	private async map<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (err) {
			throw toBackendError(translateOneDriveError(err));
		}
	}
}

function requireParentId(destination: DestinationAddress): { parentId: string | null; name: string } {
	if (destination.addressing !== "parent_id") {
		failBackend("permanent", "OneDrive adapter requires parent_id addressing");
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

/** Map a raw OneDrive client failure to the public error taxonomy. */
export function translateOneDriveError(err: unknown): BackendErrorShape {
	if (isBackendError(err)) return err;
	const message = err instanceof Error ? err.message : "OneDrive request failed";
	const permanent = permanentErrorShape(err, message);
	if (permanent) return permanent;
	if (err instanceof AuthError) return backendError("auth", message);
	if (err instanceof GraphApiError) {
		const retryAfterMs = retryAfterMsOf(err);
		return backendErrorFromStatus(
			err.status,
			message,
			{ 409: "target_changed", 410: "cursor_invalid" },
			retryAfterMs,
		);
	}
	return backendError("transient", message);
}

function isBackendError(err: unknown): err is BackendErrorShape {
	return !!err && typeof err === "object" && typeof (err as { kind?: unknown }).kind === "string";
}
