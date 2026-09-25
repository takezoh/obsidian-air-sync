import type { RemoteBackendAdapter, RemoteObject, VersionBoundReadResult } from "../../backend-api";
import { isRemoteDirectory } from "../../backend-api";
import type { FileEntity } from "../types";
import type { IdentityAddressedRename } from "../interface";
import type { Logger } from "../../logging/logger";
import type { MetadataStoreConfig } from "../../store/metadata-store";
import { MetadataStore } from "../../store/metadata-store";
import { CachingRemoteFs } from "../caching/remote-fs";
import type { IncrementalChangesResult } from "../caching/remote-fs";
import type { DetachedReadOutcome } from "../caching/detached-priority";
import { INTERNAL_METADATA_PATH } from "../../backend-api/remote-vault-contract";
import { resolveDetachedIdPath } from "../priority-observation";
import { normalizeSyncPath, validateRename } from "../../utils/path";
import { sha256 } from "../../utils/hash";
import { NormalizedMetadataCache, toFileEntity } from "./normalized-metadata-cache";
import { validateRemoteObject, validateRemoteChanges } from "./remote-object-validation";
import { applyRemoteChanges, completeDelta } from "./delta-projection";
import { MutationBridge } from "./mutation-bridge";
import type { RenamePlan, WritePlan } from "./mutation-bridge";
import type {
	NamespaceReconciliation,
	NamespaceReconciliationCapability,
	NamespaceRepairFailure,
	NamespaceRepairPolicy,
} from "../caching/namespace-reconciliation";
import { groupRepairableContentions, namespaceRepairFor } from "../caching/namespace-reconciliation";
import { errorMessage } from "../../backend-api/error-classification";

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
		const cache = new NormalizedMetadataCache(
			options.rootFolderId,
			options.logger,
			options.adapter.addressing,
		);
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
		});
	}

	// ── Adapter seams (provider facts only) ──

	protected getStartCursor(): Promise<string> {
		return this.adapter.getStartCursor();
	}

	protected async fullList(): Promise<RemoteObject[]> {
		return (await this.adapter.listAll()).map((object) =>
			validateRemoteObject(object, this.adapter.addressing),
		);
	}

	protected assertRootAlive(): Promise<void> {
		return this.adapter.assertRootAlive();
	}

	protected async fetchChanges(cursor: string): Promise<IncrementalChangesResult> {
		const result = await this.adapter.getChanges(cursor);
		if (result.kind === "cursor_invalid") {
			return { needsFullScan: true, changedPaths: new Set<string>() };
		}
		// A route that can complete the delta mutates the working view before it can
		// discover that a completion read invalidated the cursor. Keep the pre-delta
		// view and the changes it already observed, so the full-scan fallback diffs
		// against the true pre-delta view and does not drop a content update the diff
		// cannot re-derive.
		const baselineView = this.adapter.listSubtreeById ? this.cache.snapshotPathsById() : undefined;
		const projected = applyRemoteChanges(
			this.cache,
			validateRemoteChanges(result.changes, this.adapter.addressing),
		);
		const listSubtreeById = this.adapter.listSubtreeById?.bind(this.adapter);
		const completed = await completeDelta(this.cache, projected, listSubtreeById, this.adapter.addressing);
		if (completed === "cursor_invalid") {
			return {
				needsFullScan: true,
				changedPaths: new Set<string>(),
				baselineView,
				observedChanges: projected.changedPaths,
			};
		}
		return {
			needsFullScan: false,
			newToken: result.nextCursor,
			changedPaths: completed.changedPaths,
			renamedPaths: completed.renamedPaths,
			contended: completed.contended,
		};
	}

	protected async downloadFile(fileId: string): Promise<ArrayBuffer> {
		const result = await this.readVersionBound(fileId);
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

	/** Priority reads surface the adapter's typed outcome instead of throwing on a mid-read change. */
	protected async downloadForPriority(fileId: string): Promise<DetachedReadOutcome> {
		const result = await this.readVersionBound(fileId);
		return result.kind === "content"
			? { kind: "content", content: result.content }
			: { kind: result.kind };
	}

	private async readVersionBound(fileId: string): Promise<VersionBoundReadResult> {
		const object = await this.fetchCurrentFile(fileId);
		if (object === null) return { kind: "unverifiable", reason: "object not found" };
		const result = await this.adapter.read({ id: object.id, versionToken: object.versionToken ?? "" });
		return result.kind === "content"
			? { ...result, object: validateRemoteObject(result.object, this.adapter.addressing) }
			: result;
	}

	protected async deleteRemote(fileId: string): Promise<void> {
		// Resolve by id, not by the representative at its path: a vault folder several
		// provider folders make up shares one path, and each member has its own version.
		const object = this.cache.objectById(fileId);
		await this.adapter.delete({
			id: fileId,
			expected: { id: fileId, versionToken: object?.versionToken ?? "" },
		});
	}

	protected async fetchCurrentFile(fileId: string): Promise<RemoteObject | null> {
		const object = await this.adapter.getById(fileId);
		return object === null ? null : validateRemoteObject(object, this.adapter.addressing);
	}

	protected async fetchCurrentPath(path: string): Promise<RemoteObject[] | null> {
		const objects = await this.adapter.getByPath(normalizeSyncPath(path));
		return objects.map((object) => validateRemoteObject(object, this.adapter.addressing));
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
		renameById: (identityKey, admittedPath, newPath) => this.renameById(identityKey, admittedPath, newPath),
	};

	/**
	 * Namespace reconciliation (see {@link NamespaceReconciliationCapability}). The
	 * filesystem, not the sync engine, repairs a derived address two live provider
	 * objects claim: it renames the non-keeper on the backend and reports whether the
	 * working view changed. The sync engine supplies only the keeper decision and the
	 * scope filter, per call; nothing here reads or stores sync state.
	 */
	readonly namespaceReconciliation: NamespaceReconciliationCapability = {
		reconcileNamespace: (policy) => this.reconcileNamespace(policy),
	};

	private async renameById(identityKey: string, admittedPath: string, newPath: string): Promise<void> {
		const target = normalizeSyncPath(newPath);
		const admitted = normalizeSyncPath(admittedPath);
		const name = target.split("/").pop() ?? "";
		if (!identityKey || name === "" || name === "." || name === "..") {
			throw new Error(`Invalid identity-addressed rename target: "${newPath}"`);
		}
		await this.withCacheMutex({
			operationName: "renameById",
			// Nothing is resolved through the cache: the id is the address.
			resolve: () => ({ identityKey, name, target, admitted }),
			execute: async (r) => {
				// Re-observe at execution and require the object still be addressed where
				// Admission saw it. A post-Admission move must fail closed rather than let
				// the fresh observation justify renaming an object at another location.
				const current = await this.fetchCurrentFile(r.identityKey);
				if (current === null) throw new Error(`Remote object not found: ${r.identityKey}`);
				// One re-observation of the object itself, and nothing more: this is the
				// permitted provider read (NFR-RECON-003). The admitted address is checked
				// against the working view's own projection from that object (its name and
				// its immediate parent's cached path), never by walking the provider parent
				// chain — a deeper path must not cost a read per ancestor, and a walk that
				// failed would mask the original precondition error.
				const resolved = this.cache.resolvePathFromCache(current);
				if (resolved === null || normalizeSyncPath(resolved) !== r.admitted) {
					const observed = resolved === null ? "unresolved" : normalizeSyncPath(resolved);
					throw new Error(
						`Remote object ${r.identityKey} is no longer addressed by the admitted path ${r.admitted} (observed ${observed})`,
					);
				}
				return this.bridge.performIdentityRename(current, r.name);
			},
			staleGuard: (r) => ({ path: r.target, expectedId: undefined }),
			update: (_r, object: RemoteObject) => {
				this.cache.applyFileChange(object);
			},
		});
	}

	/**
	 * Settle every repairable contention the working view was built with, then report
	 * whether the provider namespace changed.
	 *
	 * The contentions are taken under the cache mutex, but each rename is issued on its
	 * own (the identity rename acquires the mutex itself, so holding it across the loop
	 * would deadlock). The sync engine is serialized per cycle, so nothing else mutates
	 * the view between the take and the renames. A rename updates the derived cache from
	 * the provider's answer; the caller discards the working view on `changed`, and the
	 * next cycle re-reads the settled facts.
	 */
	private async reconcileNamespace(policy: NamespaceRepairPolicy): Promise<NamespaceReconciliation> {
		// Build the working view first, so the contentions are known and the delta handed
		// back lets change collection read this same, already-settled view.
		const delta = await this.getChangedPaths();
		const contentions = await this.cacheMutex.run(() => this.takeWorkingViewContentions());
		// Group by contended address first and keep only addresses whose every claimant is
		// provider-resolved and in scope; per-fact filtering would let a mixed address
		// mutate the provider from an incomplete topology.
		const byPath = groupRepairableContentions(contentions, policy);
		if (byPath.size === 0) return { kind: "settled", delta };
		// At most one rename per contended address per cycle: when three or more ids
		// claim one address, the remaining losers are settled by later cycles. The pick is
		// the smallest withheld id, so it is a function of the claim set and stable across
		// retries. The keeper is decided once per address over its whole claimant set.
		const failures: NamespaceRepairFailure[] = [];
		let changed = false;
		for (const [path, facts] of [...byPath].sort(([left], [right]) => (left < right ? -1 : 1))) {
			const fact = [...facts].sort((left, right) =>
				left.withheldId < right.withheldId ? -1 : left.withheldId > right.withheldId ? 1 : 0)[0]!;
			const claimantIds = [...new Set(facts.flatMap((item) => [item.admittedId, item.withheldId]))];
			const keeper = await policy.keeper(path, claimantIds);
			const repair = namespaceRepairFor(fact, keeper);
			try {
				await this.identityRename.renameById(repair.identityKey, repair.path, repair.target);
				changed = true;
			} catch (err) {
				failures.push({ ...repair, message: errorMessage(err), error: err });
			}
		}
		if (failures.length > 0) return { kind: "failed", failures };
		return changed ? { kind: "changed" } : { kind: "settled", delta };
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
