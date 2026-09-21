import type { RemoteObject } from "../../backend-api";
import { isRemoteDirectory } from "../../backend-api";
import type { FileEntity, PathAuthority } from "../types";
import type { Logger } from "../../logging/logger";
import { AbstractMetadataCache } from "../caching/metadata-cache";
import type { AddressDisplacement } from "../caching/metadata-cache";
import { validateRemoteObject } from "./remote-object-validation";

/**
 * Project one normalized remote object into the sync engine's `FileEntity`.
 *
 * `size` and `mtimeMs` absent on the adapter object mean UNKNOWN, but
 * `FileEntity` has no third state for either, so both use its documented
 * sentinels: `0` size for a directory or an unknown size, `0` mtime for an
 * unknown modification time. A directory is always size `0`. `hash` is supplied
 * by the caller (`""` from a cache read, the computed digest after a write,
 * which is the one place the bytes are already in hand).
 */
export function toFileEntity(
	path: string,
	file: RemoteObject,
	pathAuthority: PathAuthority,
	hash: string,
): FileEntity {
	const directory = file.kind === "directory";
	const entity: FileEntity = {
		path,
		pathAuthority,
		identityKey: file.id,
		isDirectory: directory,
		size: directory ? 0 : file.size ?? 0,
		mtime: file.mtimeMs ?? 0,
		hash: directory ? "" : hash,
	};
	if (file.kind === "file" && file.checksum) {
		entity.remoteChecksum = { algo: file.checksum.algorithm, value: file.checksum.value };
	}
	const backendMeta: Record<string, unknown> = { remoteId: file.id };
	if (file.versionToken !== undefined) backendMeta.versionToken = file.versionToken;
	entity.backendMeta = backendMeta;
	return entity;
}

/**
 * The normalized metadata cache: `AbstractMetadataCache<RemoteObject>` with the
 * four extractors plus `toEntity`, parameterized only by the normalized object.
 *
 * Addressing is the one place the two normalized location forms differ:
 *
 * - `parent_id` — the provider reported the parent id directly. `null` is the
 *   bound root, so the entry is root-level; otherwise the parent id is passed
 *   through unchanged.
 * - `provider_path` — the provider has no parent id to report and core must NOT
 *   fabricate one. The parent is resolved from the Core-maintained
 *   provider-path index built during the same complete snapshot (parent provider
 *   path → object id). An object whose parent path is not in that snapshot is
 *   dropped from the snapshot rather than seated at a bare-name root address,
 *   and a delta object whose parent is not in the working view resolves to no
 *   path, which the base treats as a move out of scope. Either way it fails
 *   closed instead of inventing topology.
 */
export class NormalizedMetadataCache extends AbstractMetadataCache<RemoteObject> {
	/** Provider-resolved path → object id, for `provider_path` topology only. */
	private providerPathById = new Map<string, string>();
	/** Object id → provider-resolved path, so the forward entry can be retired. */
	private idToProviderPath = new Map<string, string>();

	constructor(rootFolderId: string, logger?: Logger) {
		super(rootFolderId, logger);
	}

	private providerPathOf(file: RemoteObject): string | null {
		return file.location.addressing === "provider_path" ? file.location.path : null;
	}

	private indexFile(file: RemoteObject): void {
		const providerPath = this.providerPathOf(file);
		if (providerPath === null || providerPath === "") return;
		this.providerPathById.set(providerPath, file.id);
		this.idToProviderPath.set(file.id, providerPath);
	}

	private unindexId(id: string): void {
		const providerPath = this.idToProviderPath.get(id);
		if (providerPath === undefined) return;
		this.providerPathById.delete(providerPath);
		this.idToProviderPath.delete(id);
	}

	private clearProviderPathIndex(): void {
		this.providerPathById.clear();
		this.idToProviderPath.clear();
	}

	/**
	 * `undefined` for a `parent_id` entry (its parent is a real provider id).
	 * For `provider_path`, the id of the object whose provider path is the
	 * entry's parent path, or `null` when that parent cannot be resolved.
	 */
	private providerParentId(file: RemoteObject): string | null | undefined {
		if (file.location.addressing === "parent_id") return undefined;
		const parentPath = AbstractMetadataCache.parentPath(file.location.path);
		if (parentPath === "") return this.rootFolderId;
		return this.providerPathById.get(parentPath) ?? null;
	}

	protected extractId(file: RemoteObject): string {
		return file.id;
	}

	protected extractParentIds(file: RemoteObject): string[] {
		if (file.location.addressing === "parent_id") {
			return file.location.parentId === null ? [] : [file.location.parentId];
		}
		const parentId = this.providerParentId(file);
		return parentId === undefined || parentId === null ? [] : [parentId];
	}

	protected extractName(file: RemoteObject): string {
		return file.name;
	}

	protected isFolderEntry(file: RemoteObject): boolean {
		return isRemoteDirectory(file);
	}

	toEntity(path: string, file: RemoteObject): FileEntity {
		return toFileEntity(path, file, this.getPathAuthority(path), "");
	}

	override setFile(
		path: string,
		file: RemoteObject,
		pathAuthority?: PathAuthority,
	): AddressDisplacement | null {
		const priorProviderPath = this.idToProviderPath.get(file.id);
		const result = super.setFile(path, file, pathAuthority);
		if (priorProviderPath !== undefined && priorProviderPath !== this.providerPathOf(file)) {
			this.unindexId(file.id);
		}
		this.indexFile(file);
		return result;
	}

	/**
	 * Validate every record before it enters the cache. This is the single seam
	 * shared by a fresh full scan and a restored IndexedDB checkpoint, so a
	 * committed generation written in an unrecognized encoding fails here rather
	 * than seating provider-native fields as if they were normalized objects. A
	 * malformed record throws {@link RemoteObjectValidationError}; the caller that
	 * restores a checkpoint treats that as no usable checkpoint and re-scans.
	 */
	override bulkLoad(items: Iterable<[string, RemoteObject, PathAuthority?]>): readonly AddressDisplacement[] {
		const validated: [string, RemoteObject, PathAuthority?][] = [];
		for (const [path, file, authority] of items) {
			validated.push([path, validateRemoteObject(file), authority]);
		}
		return super.bulkLoad(validated);
	}

	override removeEntry(path: string): void {
		for (const id of this.idsAt(path)) this.unindexId(id);
		super.removeEntry(path);
	}

	override clear(): void {
		this.clearProviderPathIndex();
		super.clear();
	}

	/**
	 * `provider_path` entries resolve directly from the provider's own path; the
	 * parent is only needed to DISPROVE that the entry belongs in the working view.
	 * An unknown parent is no path (`null`), which the base treats as a move out of
	 * scope, never a bare-name seat at the root.
	 */
	override resolvePathFromCache(file: RemoteObject): string | null {
		if (file.location.addressing === "parent_id") {
			// A bound-root entry has no parent id at all (`[]`), which the base's
			// parent-chain resolver reads as unresolvable. The bound root IS its
			// parent, so the entry's own name is the resolved path.
			if (file.location.parentId === null) return file.name;
			return super.resolvePathFromCache(file);
		}
		const parentPath = AbstractMetadataCache.parentPath(file.location.path);
		if (parentPath === "") return file.name;
		const parentId = this.providerPathById.get(parentPath);
		if (parentId === undefined || !this.hasId(parentId)) return null;
		return file.location.path;
	}

	/**
	 * Build the provider-path index from the WHOLE incoming snapshot first, so a
	 * child's parent resolves regardless of array order, then hand the base only the
	 * entries whose parent chain reaches the bound root. Dropping an unresolvable
	 * entry is the fail-closed choice: seating it at its bare name would invent a
	 * root-level path the provider never resolved.
	 */
	override buildFromFiles(files: RemoteObject[]): readonly AddressDisplacement[] {
		this.clearProviderPathIndex();
		for (const file of files) this.indexFile(file);
		const trackable = files.filter((file) => this.isTrackable(file));
		return super.buildFromFiles(trackable);
	}

	private isTrackable(file: RemoteObject): boolean {
		if (file.location.addressing === "parent_id") return true;
		return this.parentChainReachesRoot(file.location.path);
	}

	private parentChainReachesRoot(providerPath: string): boolean {
		let current = AbstractMetadataCache.parentPath(providerPath);
		const visited = new Set<string>();
		while (current !== "") {
			if (!this.providerPathById.has(current) || visited.has(current)) return false;
			visited.add(current);
			current = AbstractMetadataCache.parentPath(current);
		}
		return true;
	}
}
