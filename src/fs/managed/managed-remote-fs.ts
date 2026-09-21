import type { RemoteBackendAdapter, RemoteObject } from "../../backend-api";
import { isRemoteDirectory } from "../../backend-api";
import type { FileEntity } from "../types";
import type { IdentityAddressedRename } from "../interface";
import type { Logger } from "../../logging/logger";
import type { MetadataStoreConfig } from "../../store/metadata-store";
import { MetadataStore } from "../../store/metadata-store";
import { CachingRemoteFs } from "../caching/remote-fs";
import type { IncrementalChangesResult } from "../caching/remote-fs";
import { INTERNAL_METADATA_PATH } from "../remote-vault-contract";
import { resolveDetachedIdPath } from "../priority-observation";
import { normalizeSyncPath, validateRename } from "../../utils/path";
import { sha256 } from "../../utils/hash";
import { NormalizedMetadataCache, toFileEntity } from "./normalized-metadata-cache";
import { validateRemoteObject, validateRemoteChanges } from "./remote-object-validation";
import { applyRemoteChanges } from "./delta-projection";
import { MutationBridge } from "./mutation-bridge";
import type { RemoteAddressing, RenamePlan, WritePlan } from "./mutation-bridge";

export interface ManagedRemoteFsOptions {
	adapter: RemoteBackendAdapter;
	/** Human-readable filesystem name (the canonical backend id at wiring time). */
	name: string;
	rootFolderId: string;
	/** Vault id the persistent checkpoint is keyed by, paired with `store`. */
	vaultId: string;
	/** IndexedDB database name/version for this target's metadata checkpoint. */
	store: MetadataStoreConfig;
	/**
	 * Pre-built checkpoint store. Core constructs one from `vaultId`/`store` when
	 * absent; the shared caching contract injects its own so the store instance (and
	 * its injected failures) is observably the same one the filesystem writes.
	 */
	metadataStore?: MetadataStore<RemoteObject>;
	logger?: Logger;
	/** The module's declared location form; inferred from observations when absent. */
	addressing?: RemoteAddressing;
}

/**
 * Clear a target's checkpoint store by its settings-derived key, without a live
 * filesystem (used by the disconnect/switch path when the backend never built an
 * FS). Best-effort: an orphaned store is keyed by the old target and is never
 * reused. The store construction stays here so core owns the single store-owner
 * inventory; callers do not reach for `MetadataStore` themselves.
 */
export async function clearManagedCheckpointStore(
	vaultId: string,
	store: MetadataStoreConfig,
): Promise<void> {
	const metadataStore = new MetadataStore<RemoteObject>(vaultId, store);
	try {
		await metadataStore.open();
		await metadataStore.clear();
		await metadataStore.close();
	} catch {
		/* non-fatal: an orphaned store is keyed by the old target and never reused */
	}
}

/**
 * Core-managed remote filesystem: `IFileSystem` + checkpoint lifecycle over a
 * `RemoteBackendAdapter`.
 *
 * It reuses `CachingRemoteFs` INSIDE core — the ADR explicitly allows that — and
 * supplies every backend seam by translating the normalized adapter contract. A
 * backend module never subclasses this or any core class; it only reports provider
 * facts and performs provider mutations. Everything above that boundary (the
 * normalized cache, topology/identity projection, cursor/checkpoint, priority
 * observation, mutation planning) is core's, so crash-safety is identical for
 * every backend.
 *
 * The persistent `MetadataStore<RemoteObject>` is constructed HERE rather than
 * handed in, because core owns the checkpoint; a module receives no store.
 */
export class ManagedRemoteFs extends CachingRemoteFs<RemoteObject> {
	readonly name: string;
	private readonly adapter: RemoteBackendAdapter;
	private readonly bridge: MutationBridge;
	protected declare cache: NormalizedMetadataCache;

	constructor(options: ManagedRemoteFsOptions) {
		const cache = new NormalizedMetadataCache(options.rootFolderId, options.logger);
		super(
			options.rootFolderId,
			cache,
			options.metadataStore ?? new MetadataStore<RemoteObject>(options.vaultId, options.store),
			options.logger,
		);
		this.name = options.name;
		this.adapter = options.adapter;
		this.bridge = new MutationBridge({
			adapter: options.adapter,
			cache,
			rootFolderId: options.rootFolderId,
			addressing: options.addressing,
		});
	}

	// ── Adapter seams (provider facts only) ──

	protected getStartCursor(): Promise<string> {
		return this.adapter.getStartCursor();
	}

	protected async fullList(): Promise<RemoteObject[]> {
		return (await this.adapter.listAll()).map(validateRemoteObject);
	}

	protected assertRootAlive(): Promise<void> {
		return this.adapter.assertRootAlive();
	}

	protected async fetchChanges(cursor: string): Promise<IncrementalChangesResult> {
		const result = await this.adapter.getChanges(cursor);
		if (result.kind === "cursor_invalid") {
			return { needsFullScan: true, changedPaths: new Set<string>() };
		}
		const projected = applyRemoteChanges(this.cache, validateRemoteChanges(result.changes));
		return {
			needsFullScan: false,
			newToken: result.nextCursor,
			changedPaths: projected.changedPaths,
			renamedPaths: projected.renamedPaths,
			contended: projected.contended,
		};
	}

	protected async downloadFile(fileId: string): Promise<ArrayBuffer> {
		const object = await this.fetchCurrentFile(fileId);
		if (object === null) throw new Error(`Remote object not found: ${fileId}`);
		const result = await this.adapter.read({ id: object.id, versionToken: object.versionToken ?? "" });
		switch (result.kind) {
			case "content":
				return result.content;
			case "target_changed":
				throw new Error(`Remote object changed during download: ${fileId}`);
			case "unverifiable":
				throw new Error(`Remote object could not be verified during download: ${fileId} (${result.reason})`);
			default: {
				const exhaustive: never = result;
				throw new Error(`Unhandled read result: ${String(exhaustive)}`);
			}
		}
	}

	protected async deleteRemote(fileId: string): Promise<void> {
		const path = this.cache.getPathById(fileId);
		const object = path === undefined ? undefined : this.cache.getFile(path);
		await this.adapter.delete(object?.versionToken === undefined
			? { id: fileId }
			: { id: fileId, expected: { id: fileId, versionToken: object.versionToken } });
	}

	protected async fetchCurrentFile(fileId: string): Promise<RemoteObject | null> {
		const object = await this.adapter.getById(fileId);
		return object === null ? null : validateRemoteObject(object);
	}

	protected async fetchCurrentPath(path: string): Promise<RemoteObject[] | null> {
		const objects = await this.adapter.getByPath(normalizeSyncPath(path));
		return objects.map(validateRemoteObject);
	}

	protected async resolveDetachedPath(file: RemoteObject): Promise<string | null> {
		if (file.location.addressing === "provider_path") return normalizeSyncPath(file.location.path);
		const rootId = this.rootFolderId;
		return resolveDetachedIdPath(file, rootId, (id) => this.fetchCurrentFile(id), {
			id: (entry) => entry.id,
			name: (entry) => entry.name,
			parents: (entry) => entry.location.addressing === "parent_id"
				? [entry.location.parentId ?? rootId]
				: [],
			isFolder: (entry) => isRemoteDirectory(entry),
		});
	}

	protected toDetachedEntity(path: string, file: RemoteObject): FileEntity {
		return toFileEntity(path, file, "actual_resolved", "");
	}

	protected detachedVersionToken(file: RemoteObject): string | null {
		return isRemoteDirectory(file) ? null : file.versionToken ?? null;
	}

	// ── Mutating ops (path op → adapter mutation via the bridge) ──

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		if (path === INTERNAL_METADATA_PATH) {
			throw new Error(`Refusing to write reserved backend path: ${path}`);
		}
		const { result: object } = await this.withCacheMutex({
			operationName: "write",
			resolve: () => this.bridge.planWrite(path),
			execute: (plan) => this.bridge.performWrite(plan, content, mtime),
			staleGuard: (plan: WritePlan) => ({ path: plan.targetPath, expectedId: plan.existingId }),
			update: (plan: WritePlan, written: RemoteObject) => this.applyWrite(plan, written),
		});
		const hash = await sha256(content);
		return toFileEntity(path, object, "requested_echo", hash);
	}

	async mkdir(path: string): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		if (path === INTERNAL_METADATA_PATH) {
			throw new Error(`Refusing to create reserved backend path: ${path}`);
		}
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const folder = await this.bridge.ensureFolder(path);
			if (folder === null) throw new Error(`Cannot create directory at the root: "${path}"`);
			const resolved = this.cache.getPathById(folder.id) ?? path;
			return toFileEntity(resolved, folder, "requested_echo", "");
		});
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		oldPath = normalizeSyncPath(oldPath);
		newPath = normalizeSyncPath(newPath);
		validateRename(oldPath, newPath);
		await this.withCacheMutex({
			operationName: "rename",
			resolve: () => this.bridge.planRename(oldPath, newPath),
			execute: (plan) => this.bridge.performRename(plan),
			staleGuard: (plan: RenamePlan) => ({ path: plan.oldPath, expectedId: plan.expectedId }),
			update: (plan: RenamePlan, moved: RemoteObject[]) => this.applyRename(plan, moved),
		});
	}

	/**
	 * Identity-addressed rename (see {@link IdentityAddressedRename}). The subject is
	 * addressed by its own provider id, so it works for an object the cache is
	 * deliberately not holding — exactly the withheld claimant a contended address
	 * repair has to move. Only the final segment changes; the object keeps the
	 * provider parent the adapter reports. Nothing is written to the cache in
	 * advance: the provider's answer is applied, and a destination a concurrent
	 * writer took is skipped rather than overwritten.
	 */
	readonly identityRename: IdentityAddressedRename = {
		renameById: (identityKey, newPath) => this.renameById(identityKey, newPath),
	};

	private async renameById(identityKey: string, newPath: string): Promise<void> {
		const target = normalizeSyncPath(newPath);
		const name = target.split("/").pop() ?? "";
		if (!identityKey || name === "" || name === "." || name === "..") {
			throw new Error(`Invalid identity-addressed rename target: "${newPath}"`);
		}
		await this.withCacheMutex({
			operationName: "renameById",
			// Nothing is resolved through the cache: the id is the address.
			resolve: () => ({ identityKey, name, target }),
			execute: (r) => this.bridge.performIdentityRename(r.identityKey, r.name),
			staleGuard: (r) => ({ path: r.target, expectedId: undefined }),
			update: (_r, object: RemoteObject) => {
				this.cache.applyFileChange(object);
			},
		});
	}

	private applyWrite(plan: WritePlan, object: RemoteObject): void {
		if (!this.cache.applyFileChange(object)) {
			this.cache.setFile(plan.targetPath, object, "requested_echo");
		}
	}

	private applyRename(plan: RenamePlan, moved: RemoteObject[]): void {
		// The shared stale guard only validates the SOURCE. A concurrent op could
		// have landed a different object at the destination during the network call
		// (run outside the mutex); skip rather than overwrite it. The cursor has
		// already advanced past our rename, so the next cycle re-detects it.
		const occupant = this.cache.getFile(plan.newPath);
		const movedIds = new Set(moved.map((object) => object.id));
		if (occupant && !movedIds.has(occupant.id)) {
			this.logger?.warn("Skipping stale cache update for rename", { path: plan.newPath });
			return;
		}
		this.cache.removeEntry(plan.oldPath);
		// Every provider folder that made up the vault folder arrives at the new path,
		// merging beside the first that seats it.
		for (const object of moved) {
			if (!this.cache.applyFileChange(object)) {
				this.cache.setFile(plan.newPath, object, "actual_resolved");
			}
		}
		if (plan.wasFolder) this.cache.rewriteChildPaths(plan.oldPath, plan.newPath);
	}
}
