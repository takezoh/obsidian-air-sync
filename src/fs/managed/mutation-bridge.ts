import type {
	CreateFileInput,
	DestinationAddress,
	ExpectedVersion,
	MoveInput,
	RemoteBackendAdapter,
	RemoteObject,
	UpdateFileInput,
} from "../../backend-api";
import { isRemoteDirectory } from "../../backend-api";
import { AbstractMetadataCache } from "../caching/metadata-cache";
import type { NormalizedMetadataCache } from "./normalized-metadata-cache";
import { validateRemoteObject } from "./remote-object-validation";

/** Which location form the adapter reports, hence which destination core builds. */
export type RemoteAddressing = "parent_id" | "provider_path";

export interface MutationBridgeOptions {
	adapter: RemoteBackendAdapter;
	cache: NormalizedMetadataCache;
	rootFolderId: string;
	/** The module's declared location form; inferred from observed objects when absent. */
	addressing?: RemoteAddressing;
}

/** Everything a write needs resolved under the cache mutex before the network call. */
export interface WritePlan {
	targetPath: string;
	existingId: string | undefined;
	expected: ExpectedVersion | undefined;
	destination: DestinationAddress;
}

/** One provider object a rename must move, and where to. */
export interface RenameSubject {
	readonly object: RemoteObject;
	readonly destination: DestinationAddress;
}

/**
 * Everything a rename needs resolved before the network call.
 *
 * `subjects` carries EVERY provider object the vault path is made of: a vault
 * folder two same-named provider folders compose moves as one, so renaming only
 * the representative would leave the other behind at the old name. A single file
 * (or a single provider folder) yields one subject. Each subject keeps its own
 * provider parent unless the rename also changes the vault parent, which is the
 * shared destination `reparent` records.
 */
export interface RenamePlan {
	oldPath: string;
	newPath: string;
	expectedId: string;
	wasFolder: boolean;
	subjects: RenameSubject[];
}

/**
 * Translate `IFileSystem` path operations into provider mutations on the narrow
 * adapter boundary.
 *
 * The bridge owns destination construction and the expected-identity/version
 * evidence a conditional mutation carries. It does NOT re-decide anything the
 * cache or Admission already decided: paths are read off the working view, a
 * destination already occupied is a no-clobber refusal, and an update carries the
 * version the cache currently holds. Provider errors are passed through unchanged
 * — the adapter's `BackendErrorShape` IS the error taxonomy core classifies.
 */
export class MutationBridge {
	private readonly adapter: RemoteBackendAdapter;
	private readonly cache: NormalizedMetadataCache;
	private readonly rootFolderId: string;
	private readonly addressingOverride: RemoteAddressing | undefined;

	constructor(options: MutationBridgeOptions) {
		this.adapter = options.adapter;
		this.cache = options.cache;
		this.rootFolderId = options.rootFolderId;
		this.addressingOverride = options.addressing;
	}

	/** The declared form, else the first form observed in the working view, else parent-id. */
	private addressing(): RemoteAddressing {
		if (this.addressingOverride !== undefined) return this.addressingOverride;
		for (const [, file] of this.cache.entries()) return file.location.addressing;
		return "parent_id";
	}

	private destination(parent: RemoteObject | null, name: string, parentPath: string): DestinationAddress {
		if (this.addressing() === "provider_path") {
			return {
				addressing: "provider_path",
				rootId: this.rootFolderId,
				path: parentPath === "" ? name : `${parentPath}/${name}`,
			};
		}
		return { addressing: "parent_id", parentId: parent?.id ?? null, name };
	}

	/**
	 * A destination that changes only the final segment, keeping the object's own
	 * provider parent. Used by the identity-addressed rename, whose subject the
	 * cache may not be holding: the object's current location is the only fact
	 * available, and it is the one the provider rename must preserve.
	 */
	destinationPreservingParent(object: RemoteObject, name: string): DestinationAddress {
		if (this.addressing() === "provider_path") {
			const current = object.location.addressing === "provider_path" ? object.location.path : "";
			const parentPath = AbstractMetadataCache.parentPath(current);
			return {
				addressing: "provider_path",
				rootId: this.rootFolderId,
				path: parentPath === "" ? name : `${parentPath}/${name}`,
			};
		}
		const parentId = object.location.addressing === "parent_id" ? object.location.parentId : null;
		return { addressing: "parent_id", parentId, name };
	}

	/**
	 * Ensure every segment of `path` exists as a provider directory, returning the
	 * deepest one (`null` for the bound root). Idempotent: a cached directory is
	 * reused; a missing one is created through the adapter and seated by provider
	 * resolution (never an invented id).
	 */
	async ensureFolder(path: string): Promise<RemoteObject | null> {
		const target = path;
		if (target === "") return null;
		const existing = this.cache.getFile(target);
		if (existing) {
			if (!isRemoteDirectory(existing)) {
				throw new Error(`Cannot create directory "${target}": "${target}" is a file`);
			}
			return existing;
		}
		const parts = target.split("/");
		let currentPath = "";
		let current: RemoteObject | null = null;
		for (const part of parts) {
			const requested = currentPath === "" ? part : `${currentPath}/${part}`;
			const cached = this.cache.getFile(requested);
			if (cached) {
				if (!isRemoteDirectory(cached)) {
					throw new Error(`Cannot create directory "${target}": "${requested}" is a file`);
				}
				current = cached;
				currentPath = requested;
				continue;
			}
			const destination = this.destination(current, part, currentPath);
			const created = validateRemoteObject(await this.adapter.createDirectory({ destination }));
			const applied = this.cache.applyFileChange(created);
			currentPath = applied ? requested : this.cache.getPathById(created.id) ?? requested;
			if (!applied) this.cache.setFile(currentPath, created, "requested_echo");
			current = created;
		}
		return current;
	}

	async planWrite(path: string): Promise<WritePlan> {
		const name = path.split("/").pop() ?? "";
		if (name === "" || name === "." || name === "..") {
			throw new Error(`Invalid file path: "${path}"`);
		}
		const parentPath = AbstractMetadataCache.parentPath(path);
		const parent = await this.ensureFolder(parentPath);
		const actualParentPath = parent === null ? "" : this.cache.getPathById(parent.id) ?? parentPath;
		const targetPath = actualParentPath === "" ? name : `${actualParentPath}/${name}`;
		if (this.cache.isFolder(targetPath)) {
			throw new Error(`Cannot write file: "${targetPath}" is an existing directory`);
		}
		const existing = this.cache.getFile(targetPath);
		return {
			targetPath,
			existingId: existing?.id,
			expected: existing === undefined ? undefined : this.expectedOf(existing),
			destination: this.destination(parent, name, actualParentPath),
		};
	}

	async performWrite(plan: WritePlan, content: ArrayBuffer, mtimeMs: number): Promise<RemoteObject> {
		const input: CreateFileInput | UpdateFileInput = plan.existingId !== undefined && plan.expected !== undefined
			? { id: plan.existingId, expected: plan.expected, content, mtimeMs }
			: { destination: plan.destination, content, mtimeMs };
		const object = plan.existingId !== undefined && plan.expected !== undefined
			? await this.adapter.updateFile(input as UpdateFileInput)
			: await this.adapter.createFile(input as CreateFileInput);
		return validateRemoteObject(object);
	}

	async planRename(oldPath: string, newPath: string): Promise<RenamePlan> {
		const object = this.cache.getFile(oldPath);
		if (!object) throw new Error(`File not found: ${oldPath}`);
		if (this.cache.hasFile(newPath)) throw new Error(`Destination already exists: ${newPath}`);
		const name = newPath.split("/").pop() ?? "";
		if (name === "" || name === "." || name === "..") {
			throw new Error(`Invalid rename target: "${newPath}"`);
		}
		const parentPath = AbstractMetadataCache.parentPath(newPath);
		const parent = await this.ensureFolder(parentPath);
		const actualParentPath = parent === null ? "" : this.cache.getPathById(parent.id) ?? parentPath;
		const wasFolder = isRemoteDirectory(object);
		// A vault folder several provider folders make up moves as one: every one of
		// them is moved, each out of its own parent. A file (or a single folder) is
		// the one subject. Reparenting applies the same destination to all.
		const objects = wasFolder ? this.cache.foldersAt(oldPath) : [object];
		const reparenting = actualParentPath !== AbstractMetadataCache.parentPath(oldPath);
		const subjects: RenameSubject[] = objects.map((subject) => ({
			object: subject,
			destination: reparenting
				? this.destination(parent, name, actualParentPath)
				: this.destinationPreservingParent(subject, name),
		}));
		return { oldPath, newPath, expectedId: object.id, wasFolder, subjects };
	}

	async performRename(plan: RenamePlan): Promise<RemoteObject[]> {
		const moved: RemoteObject[] = [];
		for (const subject of plan.subjects) {
			const input: MoveInput = {
				id: subject.object.id,
				expected: this.expectedOf(subject.object),
				destination: subject.destination,
			};
			moved.push(validateRemoteObject(await this.adapter.move(input)));
		}
		return moved;
	}

	/**
	 * Identity-addressed rename: the subject is located by its own provider id, so
	 * it works for an object the cache is unwilling to name (a withheld contended
	 * claimant). Like every mutation, the provider's answer is validated before the
	 * caller may write it to the cache.
	 */
	async performIdentityRename(identityKey: string, name: string): Promise<RemoteObject> {
		const current = await this.adapter.getById(identityKey);
		if (current === null) throw new Error(`Remote object not found: ${identityKey}`);
		const object = validateRemoteObject(current);
		const input: MoveInput = {
			id: identityKey,
			destination: this.destinationPreservingParent(object, name),
		};
		return validateRemoteObject(await this.adapter.move(input));
	}

	private expectedOf(object: RemoteObject): ExpectedVersion {
		return { id: object.id, versionToken: object.versionToken ?? "" };
	}
}
