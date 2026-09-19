import type { FileEntity, PathAuthority } from "../types";
import type { Logger } from "../../logging/logger";
import { INTERNAL_METADATA_PATH } from "../remote-vault-contract";
import { resolveCachedPathAuthority, resolvePathAuthority, resolveStoredPathAuthority } from "./path-authority";
import { arbitrateAddress, mergesAsOneFolder, type AddressClaim } from "./address-arbitration";
import {
	assignClaimSet,
	type AddressDisplacement,
	type AddressDisplacementReason,
	type ResolvedClaim,
} from "./claim-set-assignment";

export type { AddressDisplacement } from "./claim-set-assignment";

export interface FileChangeResult {
	oldPath: string | undefined;
	newPath: string | undefined;
	wasFolder: boolean;
	oldDescendants: string[];
	/** The address this change took from another live id, when it took one. */
	displacement?: AddressDisplacement | null;
	/** The claim this change did NOT write, because another live id holds its address. */
	withheld?: WithheldClaim | null;
	/** Every loss this change caused beyond the one it names; see {@link FileChangeApplication}. */
	additionalLosses?: readonly WithheldClaim[];
	/** Each descendant that moved with the object and was seated, old path to new. */
	relocated?: readonly RelocatedEntry[];
	/**
	 * Whether a folder moved out of, or into, a path other folders share. The vault
	 * sees one folder there, so such a move is not that folder's rename — only the
	 * moved object's own contents went anywhere.
	 */
	acrossSharedPath?: boolean;
}

/** One descendant a folder move carried to a new address. */
export interface RelocatedEntry {
	readonly oldPath: string;
	readonly newPath: string;
	readonly isFolder: boolean;
}

/**
 * A claim a cache writer refused to write because another live id holds its
 * address. The claimant's own stale entry is vacated (the provider says it is no
 * longer there), and the whole fact is handed back so the caller can settle it
 * against the close of its evidence unit. Nothing about it is stored here.
 */
export interface WithheldClaim extends AddressDisplacement {
	/** The cache path the withheld claimant was removed from, if it held one. */
	readonly vacatedPath: string | null;
}

/** What one {@link AbstractMetadataCache.applyFileChange} did, and what it cost. */
export interface FileChangeApplication {
	/** The cache path the entry now occupies, or null when its claim was withheld. */
	readonly path: string | null;
	readonly displacement: AddressDisplacement | null;
	readonly withheld: WithheldClaim | null;
	/**
	 * Every loss this change caused beyond `displacement` and `withheld`, each naming
	 * its own object: the merged folders evicted along with a representative when a
	 * claimant takes a path they shared, and the descendants a move re-seated that
	 * lost their new addresses. None may go unnamed — an evicted object nobody names
	 * could never be repaired or re-announced.
	 */
	readonly additionalLosses: readonly WithheldClaim[];
	/** Each descendant a folder move carried along and seated, old path to new. */
	readonly relocated: readonly RelocatedEntry[];
}

/** One cached object captured before it moves: where it was, and what it was under. */
interface CapturedObject<TFile> {
	readonly id: string;
	readonly file: TFile;
	readonly oldPath: string;
	readonly authority: PathAuthority;
	/** The captured object it was found under; undefined for the root of the capture. */
	readonly under: string | undefined;
}

/**
 * Backend-agnostic in-memory metadata cache for an id-addressed remote backend.
 *
 * Owns the data structures and algorithms shared by every such backend: the
 * path↔id maps, folder tracking, the parent→children index, tree mutation
 * (rename/move/delete-subtree), and parent-chain path resolution. None of that
 * is Google Drive-specific — Google Drive's only contribution is *reading fields off its own
 * file shape* and *projecting a `FileEntity`*. Concrete backends subclass this
 * and supply those four extractors plus `toEntity`; the multi-parent (Google Drive)
 * vs single-parent (Dropbox/pCloud) difference is absorbed by `extractParentIds`
 * returning an array — one element for single-parent backends.
 *
 * A path holds exactly one object, with one exception: two provider-resolved
 * FOLDERS that derive the same path are one vault folder (the owner's rule — a vault
 * folder is only a path, and Air Sync keeps no record for one). The one with the
 * smallest id is the representative every path-level reader sees; the others are
 * held beside it in `mergedFolders`, and `idToPath` maps every one of them. Where a
 * path is shared, what lies beneath each folder is told apart by provider parentage
 * rather than by path prefix, so one folder moving or disappearing takes only its
 * own contents with it.
 */
export abstract class AbstractMetadataCache<TFile> {
	/** Maps relative path → backend file metadata */
	private pathToFile = new Map<string, TFile>();
	/** Maps backend file ID → relative path */
	private idToPath = new Map<string, string>();
	/** Tracks which paths are folders */
	private folders = new Set<string>();
	/** Parent path → set of direct child paths (for O(k) child lookups) */
	private children = new Map<string, Set<string>>();
	/** Producer-qualified authority for each cached path spelling. */
	private pathAuthorities = new Map<string, PathAuthority>();
	/** Folder path → the other provider folders merged there, beside its representative. */
	private mergedFolders = new Map<string, Map<string, TFile>>();

	private rootFolderId: string;
	protected logger?: Logger;

	constructor(rootFolderId: string, logger?: Logger) {
		this.rootFolderId = rootFolderId;
		this.logger = logger;
	}

	// ── Per-backend seams (the only Google Drive/Dropbox/pCloud-specific parts) ──

	/** Stable backend id for this entry (Google Drive `file.id`, pCloud `"d…"/"f…"`, …). */
	protected abstract extractId(file: TFile): string;
	/**
	 * Parent ids of this entry. Multi-parent backends (Google Drive) return all of them;
	 * single-parent backends return a one-element array. Empty ⇒ a root-level item.
	 */
	protected abstract extractParentIds(file: TFile): string[];
	/** The entry's own name (its last path segment). */
	protected abstract extractName(file: TFile): string;
	/** Whether the entry is a folder, by the backend's own signal (mimeType, `.tag`, …). */
	protected abstract isFolderEntry(file: TFile): boolean;
	/** Project cached metadata into a `FileEntity` (no download; `hash` stays ""). */
	abstract toEntity(path: string, file: TFile): FileEntity;

	// ── Query methods ──

	getFile(path: string): TFile | undefined { return this.pathToFile.get(path); }
	hasFile(path: string): boolean { return this.pathToFile.has(path); }
	isFolder(path: string): boolean { return this.folders.has(path); }
	getPathById(id: string): string | undefined { return this.idToPath.get(id); }
	hasId(id: string): boolean { return this.idToPath.has(id); }
	getChildren(path: string): ReadonlySet<string> | undefined { return this.children.get(path); }
	getPathAuthority(path: string): PathAuthority { return resolveCachedPathAuthority(path, this.pathToFile, this.pathAuthorities); }
	getStoredPathAuthority(path: string): PathAuthority { return resolveStoredPathAuthority(path, this.pathAuthorities); }
	get size(): number { return this.pathToFile.size; }
	entries(): IterableIterator<[string, TFile]> { return this.pathToFile.entries(); }

	/** The backend id of the file currently cached at `path`, or undefined if none. */
	idAt(path: string): string | undefined {
		const file = this.pathToFile.get(path);
		return file === undefined ? undefined : this.extractId(file);
	}

	/** Snapshot the whole cache as an id→path map (used for a full-scan diff). */
	snapshotPathsById(): Map<string, string> {
		const byId = new Map<string, string>();
		for (const [path, file] of this.pathToFile) byId.set(this.extractId(file), path);
		for (const [path, merged] of this.mergedFolders) for (const id of merged.keys()) byId.set(id, path);
		return byId;
	}

	/**
	 * Every provider folder the vault folder at `path` is made of, representative
	 * first. A backend that renames or deletes the vault folder applies the operation
	 * to each one: they are one folder to the vault, so none may be left behind.
	 */
	foldersAt(path: string): TFile[] {
		if (!this.folders.has(path)) return [];
		return this.objectsAt(path).map(([, file]) => file);
	}

	/** The backend id of every object cached at `path`, representative first. */
	idsAt(path: string): string[] {
		return this.objectsAt(path).map(([id]) => id);
	}

	/** Every object cached at `path`: the representative, then any merged folders. */
	private objectsAt(path: string): [string, TFile][] {
		const representative = this.pathToFile.get(path);
		if (representative === undefined) return [];
		return [[this.extractId(representative), representative], ...(this.mergedFolders.get(path) ?? [])];
	}

	// ── Mutation methods ──

	/**
	 * Reserved backend paths (e.g. the metadata file) are never tracked by the
	 * cache, so they stay invisible to every cache-backed reader
	 * (list/stat/read/listDir/getChangedPaths). See fs/remote-vault-contract.ts.
	 */
	private isReserved(path: string): boolean {
		return path === INTERNAL_METADATA_PATH;
	}

	/**
	 * Add or update a file in the cache with full index maintenance.
	 *
	 * Returns the displacement when a different stable id was evicted from `path`,
	 * so no cache address is ever taken from a live object silently. It decides
	 * nothing: a contended *derived* address is arbitrated by the caller
	 * (`buildFromFiles`, `applyFileChange`) before it gets here.
	 */
	setFile(path: string, file: TFile, pathAuthority: PathAuthority = "requested_echo"): AddressDisplacement | null {
		if (this.isReserved(path)) return null;
		const id = this.extractId(file);
		const incomingIsFolder = this.isFolderEntry(file);
		const oldPath = this.idToPath.get(id);
		// Requested spelling is an addressing echo, not provider topology evidence.
		// It may refresh an existing identity, but it must never move that identity.
		if (pathAuthority === "requested_echo" && oldPath !== undefined && oldPath !== path) {
			path = oldPath;
			pathAuthority = this.getStoredPathAuthority(oldPath);
		}
		const claim: AddressClaim = { id, authority: pathAuthority, isFolder: incomingIsFolder };
		// A move out of a path merged folders share, or into one, moves this object's
		// own subtree and must arbitrate each descendant where it lands and name every
		// loss. That is `applyFileChange`'s job; a seat that decides nothing cannot do
		// it, and a path-prefix rewrite here would carry the other folders' contents.
		if (oldPath !== undefined && oldPath !== path && (this.isShared(oldPath) || this.mergesAt(path, claim))) {
			throw new Error(
				`Metadata cache cannot seat "${id}" at "${path}" from "${oldPath}": a move across a path ` +
					"merged folders share is applyFileChange's to make",
			);
		}
		const merged = this.mergedFolders.get(path);
		if (merged?.has(id)) {
			merged.set(id, file);
			return null;
		}
		if (oldPath === undefined && this.mergesAt(path, claim)) {
			this.merge(path, id, file);
			return null;
		}
		const occupant = this.pathToFile.get(path);
		const occupantId = occupant === undefined ? undefined : this.extractId(occupant);

		// Provider upserts may re-key a stable id without a preceding tombstone.
		// Keep the path and identity indexes bijective at their single mutation seam.
		// Never a shared path here: only provider-resolved folders share one, and every
		// writer that can reach them arbitrates before it gets here.
		const displacement = occupantId !== undefined && occupantId !== id
			? this.displaceOccupant(path, id, occupantId, "upsert_rekey", false)[0]
			: null;

		if (oldPath && oldPath !== path) {
			const wasFolder = this.folders.has(oldPath);
			if (wasFolder && !incomingIsFolder) {
				this.removeTree(oldPath);
			} else {
				this.removeFromIndex(oldPath);
				this.pathToFile.delete(oldPath);
				this.pathAuthorities.delete(oldPath);
				this.idToPath.delete(id);
				this.folders.delete(oldPath);
				if (wasFolder) this.rewriteChildPaths(oldPath, path);
			}
		} else if (oldPath === path && this.folders.has(path) && !incomingIsFolder) {
			this.removeTree(path);
		}

		this.pathToFile.set(path, file);
		this.pathAuthorities.set(path, pathAuthority);
		this.idToPath.set(id, path);
		if (incomingIsFolder) {
			this.folders.add(path);
		} else {
			this.folders.delete(path);
		}
		this.addToIndex(path);
		return displacement;
	}

	/** The claim the object cached at `path` makes on it, as the arbiter weighs one. */
	private claimAt(path: string, id: string): AddressClaim {
		return { id, authority: this.getStoredPathAuthority(path), isFolder: this.folders.has(path) };
	}

	/** Whether `claim` would be merged beside the folder already cached at `path`. */
	private mergesAt(path: string, claim: AddressClaim): boolean {
		const occupantId = this.idAt(path);
		return occupantId !== undefined && mergesAsOneFolder(this.claimAt(path, occupantId), claim);
	}

	/** Whether other folders share `path` with whatever is cached there. */
	private isShared(path: string): boolean {
		return this.mergedFolders.has(path);
	}

	/**
	 * Seat a provider-resolved folder beside the folder already at `path`. The smaller
	 * id is the representative, so which one path-level readers see never depends on
	 * the order the two arrived in.
	 */
	private merge(path: string, id: string, file: TFile): void {
		const representative = this.pathToFile.get(path)!;
		const merged = this.mergedFolders.get(path) ?? new Map<string, TFile>();
		if (id < this.extractId(representative)) {
			merged.set(this.extractId(representative), representative);
			this.pathToFile.set(path, file);
		} else {
			merged.set(id, file);
		}
		this.mergedFolders.set(path, merged);
		this.idToPath.set(id, path);
	}

	/**
	 * The object `rootId` and everything beneath it, shallow-first.
	 *
	 * Beneath a path held by one object, that is every descendant by path. Beneath a
	 * path several merged folders share, a child belongs to whichever of them is its
	 * provider parent, so a capture of one folder never takes another's contents. Once
	 * every object at a path is in the capture, all of that path's children are too.
	 */
	private capture(rootId: string): CapturedObject<TFile>[] {
		const rootPath = this.idToPath.get(rootId);
		if (rootPath === undefined) return [];
		const rootFile = this.objectsAt(rootPath).find(([id]) => id === rootId)?.[1];
		if (rootFile === undefined) return [];
		const out: CapturedObject<TFile>[] = [{
			id: rootId, file: rootFile, oldPath: rootPath,
			authority: this.getStoredPathAuthority(rootPath), under: undefined,
		}];
		const taken = new Set([rootId]);
		const expanded = new Set<string>();
		for (let i = 0; i < out.length; i++) {
			const path = out[i]!.oldPath;
			if (expanded.has(path) || !this.folders.has(path)) continue;
			expanded.add(path);
			const here = this.objectsAt(path);
			const owners = here.filter(([id]) => taken.has(id)).map(([id]) => id);
			const whole = owners.length === here.length;
			for (const child of this.children.get(path) ?? []) {
				for (const [id, file] of this.objectsAt(child)) {
					if (taken.has(id)) continue;
					const parent = this.findRelevantParentId(this.extractParentIds(file), this.idToPath);
					const under = parent !== undefined && owners.includes(parent) ? parent : whole ? owners[0] : undefined;
					if (under === undefined) continue;
					taken.add(id);
					out.push({ id, file, oldPath: child, authority: this.getStoredPathAuthority(child), under });
				}
			}
		}
		return out;
	}

	/** Remove each captured object from the cache, promoting a merged folder wherever one remains. */
	private detachAll(captured: readonly CapturedObject<TFile>[]): void {
		for (const item of [...captured].reverse()) {
			const merged = this.mergedFolders.get(item.oldPath);
			this.idToPath.delete(item.id);
			if (merged?.delete(item.id)) {
				if (merged.size === 0) this.mergedFolders.delete(item.oldPath);
				continue;
			}
			if (merged !== undefined) {
				const next = [...merged.keys()].sort()[0]!;
				this.pathToFile.set(item.oldPath, merged.get(next)!);
				merged.delete(next);
				if (merged.size === 0) this.mergedFolders.delete(item.oldPath);
				continue;
			}
			this.removeFromIndex(item.oldPath);
			this.pathToFile.delete(item.oldPath);
			this.pathAuthorities.delete(item.oldPath);
			this.folders.delete(item.oldPath);
			if (this.children.get(item.oldPath)?.size === 0) this.children.delete(item.oldPath);
		}
	}

	/**
	 * Remove one object and its own subtree, leaving any folder it shared a path with
	 * — and that folder's contents — in place. Returns every path the removed objects
	 * occupied, so a caller can report each one as changed.
	 */
	removeObject(id: string): string[] {
		const captured = this.capture(id);
		this.detachAll(captured);
		return [...new Set(captured.map((item) => item.oldPath))];
	}

	/** The paths beneath one object's own subtree — its descendants, not a shared path's. */
	subtreePaths(id: string): string[] {
		return [...new Set(this.capture(id).slice(1).map((item) => item.oldPath))];
	}

	/**
	 * Evict the live occupant of a contended address and say what that cost — one
	 * fact per object evicted. The representative's comes first; every folder merged
	 * beside it follows with its own subtree, exactly as a full scan withholds each of
	 * them separately, so the facts do not depend on which route reached the address.
	 */
	private displaceOccupant(
		path: string,
		admittedId: string,
		withheldId: string,
		reason: AddressDisplacementReason,
		owesRemediation: boolean,
	): [AddressDisplacement, ...AddressDisplacement[]] {
		const merged = [...(this.mergedFolders.get(path)?.keys() ?? [])].map((memberId): AddressDisplacement => ({
			path, admittedId, withheldId: memberId,
			displacedPaths: this.subtreePaths(memberId).sort(), reason, owesRemediation,
		}));
		const theirs = new Set(merged.flatMap((fact) => fact.displacedPaths));
		const displacedPaths = this.collectDescendants(path).filter((descendant) => !theirs.has(descendant)).sort();
		this.removeTree(path);
		const representative = this.announce({ path, admittedId, withheldId, displacedPaths, reason, owesRemediation });
		return [representative, ...merged.map((fact) => this.announce(fact))];
	}

	/** One warn per contended address, then hand the fact to the caller. Nothing is stored. */
	private announce<T extends AddressDisplacement>(fact: T): T {
		this.logger?.warn("Contended cache address", {
			path: fact.path,
			admittedId: fact.admittedId,
			withheldId: fact.withheldId,
			displacedPaths: fact.displacedPaths,
			reason: fact.reason,
		});
		return fact;
	}

	/** Remove every object at `path` from pathToFile/idToPath/folders and the children index */
	removeEntry(path: string): void {
		const file = this.pathToFile.get(path);
		if (file) this.idToPath.delete(this.extractId(file));
		for (const id of this.mergedFolders.get(path)?.keys() ?? []) this.idToPath.delete(id);
		this.mergedFolders.delete(path);
		this.removeFromIndex(path);
		this.pathToFile.delete(path);
		this.pathAuthorities.delete(path);
		this.folders.delete(path);
	}

	/**
	 * Bulk-load files into the cache. Does NOT clear — callers clear() first when
	 * rebuilding. Returns whatever `setFile` displaced on the way in.
	 */
	bulkLoad(items: Iterable<[string, TFile, PathAuthority?]>): readonly AddressDisplacement[] {
		const records = [...items];
		const seenIds = new Map<string, string>();
		for (const [path, file] of records) {
			if (this.isReserved(path)) continue;
			const id = this.extractId(file);
			const priorPath = seenIds.get(id);
			if (priorPath !== undefined) {
				throw new Error(
					`Metadata cache contains duplicate stable id "${id}" at "${priorPath}" and "${path}"`,
				);
			}
			seenIds.set(id, path);
		}
		const displacements: AddressDisplacement[] = [];
		for (const [path, file, pathAuthority = "requested_echo"] of records) {
			const displacement = this.setFile(path, file, pathAuthority);
			if (displacement) displacements.push(displacement);
		}
		return displacements;
	}

	/**
	 * Return a snapshot of all records for persistence. A merged folder path is one
	 * record carrying its other folders, because the store is keyed by path.
	 */
	exportRecords(): { path: string; file: TFile; isFolder: boolean; pathAuthority: PathAuthority; merged?: TFile[] }[] {
		return [...this.pathToFile.entries()].map(([path, file]) => {
			const merged = this.mergedFolders.get(path);
			return {
				path,
				file,
				isFolder: this.folders.has(path),
				pathAuthority: this.getStoredPathAuthority(path),
				...(merged ? { merged: [...merged.values()] } : {}),
			};
		});
	}

	/** Extract the parent path from a full path ("" for root-level items) */
	static parentPath(path: string): string {
		const i = path.lastIndexOf("/");
		return i === -1 ? "" : path.substring(0, i);
	}

	/** Clear all cached data */
	clear(): void {
		this.pathToFile.clear();
		this.idToPath.clear();
		this.folders.clear();
		this.children.clear();
		this.pathAuthorities.clear();
		this.mergedFolders.clear();
	}

	/** Add a path to the children index */
	private addToIndex(path: string): void {
		const parent = AbstractMetadataCache.parentPath(path);
		let set = this.children.get(parent);
		if (!set) { set = new Set(); this.children.set(parent, set); }
		set.add(path);
	}

	/** Remove a path from the children index */
	private removeFromIndex(path: string): void {
		const parent = AbstractMetadataCache.parentPath(path);
		const set = this.children.get(parent);
		if (set) { set.delete(path); if (set.size === 0) this.children.delete(parent); }
	}

	/** Collect all descendant paths via the children index */
	collectDescendants(path: string): string[] {
		const result: string[] = [];
		const stack = [path];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			const kids = this.children.get(cur);
			if (kids) for (const c of kids) { result.push(c); stack.push(c); }
		}
		return result;
	}

	/**
	 * Find the parent ID that belongs to the sync root tree.
	 * Prefers rootFolderId, then falls back to any parent known in knownIds.
	 */
	findRelevantParentId(
		parents: string[],
		knownIds: { has(id: string): boolean }
	): string | undefined {
		if (parents.includes(this.rootFolderId)) return this.rootFolderId;
		for (const pid of parents) {
			if (knownIds.has(pid)) return pid;
		}
		return undefined;
	}

	/**
	 * Build the cache from a flat list of files (as returned by a full list).
	 *
	 * Resolves every path with memoization, then assigns the *complete* claim set
	 * to addresses in one pass: contended paths are arbitrated and the loss is
	 * propagated down resolved parent-id ancestry, so the contents do not depend on
	 * the order the provider happened to list the objects in. Only survivors are
	 * bulk-loaded; every loss is returned rather than performed silently.
	 */
	buildFromFiles(files: TFile[]): readonly AddressDisplacement[] {
		const byId = new Map<string, TFile>();
		for (const file of files) {
			byId.set(this.extractId(file), file);
		}

		const resolvedPaths = new Map<string, string>();
		const resolvedAuthorities = new Map<string, PathAuthority>();
		const claims: ResolvedClaim<TFile>[] = [];
		for (const file of files) {
			const path = this.resolveFilePathCached(file, byId, resolvedPaths, new Set());
			const authority = resolvePathAuthority(file, {
				rootFolderId: this.rootFolderId,
				byId,
				extractId: (entry) => this.extractId(entry),
				extractParentIds: (entry) => this.extractParentIds(entry),
				resolved: resolvedAuthorities,
			}, new Set());
			// Reserved paths are never tracked, so they never contend for one.
			if (this.isReserved(path)) continue;
			claims.push({
				id: this.extractId(file),
				file,
				path,
				authority,
				parentId: this.resolvedParentId(file, byId),
				isFolder: this.isFolderEntry(file),
			});
		}

		const { admitted, displacements } = assignClaimSet(claims);
		for (const displacement of displacements) this.announce(displacement);
		const evicted = this.bulkLoad(admitted.map((claim): [string, TFile, PathAuthority] =>
			[claim.path, claim.file, claim.authority]));
		return [...displacements, ...evicted];
	}

	/**
	 * The parent id the path resolver went through for this file — undefined for a
	 * root-level entry, an unknown parent, or a bare-name fallback. This is the edge
	 * a displacement propagates along: provider topology, not a string prefix, which
	 * would also catch an unrelated object that merely spells its way under the name.
	 */
	private resolvedParentId(file: TFile, byId: ReadonlyMap<string, TFile>): string | undefined {
		const parents = this.extractParentIds(file);
		if (parents.length === 0) return undefined;
		const parentId = this.findRelevantParentId(parents, byId);
		if (!parentId || parentId === this.rootFolderId || parentId === this.extractId(file)) {
			return undefined;
		}
		return byId.has(parentId) ? parentId : undefined;
	}

	/** Resolve a file's relative path using the existing cache */
	resolvePathFromCache(file: TFile): string | null {
		const parents = this.extractParentIds(file);
		if (parents.length === 0) return null;

		const parentId = this.findRelevantParentId(parents, this.idToPath);
		if (!parentId) return null;
		if (parentId === this.rootFolderId) return this.extractName(file);

		const parentPath = this.idToPath.get(parentId);
		if (!parentPath) return null;
		return `${parentPath}/${this.extractName(file)}`;
	}

	/**
	 * Resolve a file's path with memoization.
	 * Already-resolved ancestor paths are reused, cutting complexity from O(n×d) to O(n).
	 */
	resolveFilePathCached(
		file: TFile,
		byId: Map<string, TFile>,
		resolvedPaths: Map<string, string>,
		visiting: Set<string>
	): string {
		const id = this.extractId(file);
		const name = this.extractName(file);
		const cached = resolvedPaths.get(id);
		if (cached !== undefined) return cached;

		if (visiting.has(id)) {
			this.logger?.warn("Circular parent reference detected, truncating path", { fileName: name, fileId: id });
			resolvedPaths.set(id, name);
			return name;
		}

		const parents = this.extractParentIds(file);
		if (parents.length === 0) {
			resolvedPaths.set(id, name);
			return name;
		}

		const parentId = this.findRelevantParentId(parents, byId);
		if (!parentId || parentId === this.rootFolderId || parentId === id) {
			if (parentId === id) {
				this.logger?.warn("Circular parent reference detected, truncating path", { fileName: name, fileId: id });
			}
			resolvedPaths.set(id, name);
			return name;
		}

		const parent = byId.get(parentId);
		if (!parent) {
			resolvedPaths.set(id, name);
			return name;
		}

		visiting.add(id);
		const parentPath = this.resolveFilePathCached(parent, byId, resolvedPaths, visiting);
		visiting.delete(id);

		const fullPath = `${parentPath}/${name}`;
		resolvedPaths.set(id, fullPath);
		return fullPath;
	}

	/** Rewrite all cached child paths when a folder is renamed/moved */
	rewriteChildPaths(oldPath: string, newPath: string): void {
		const oldPrefix = oldPath + "/";
		const descendants = this.collectDescendants(oldPath);
		for (const childPath of descendants) {
			const childFile = this.pathToFile.get(childPath);
			if (!childFile) continue;
			const childAuthority = resolveStoredPathAuthority(childPath, this.pathAuthorities);
			const newChildPath = newPath + "/" + childPath.substring(oldPrefix.length);
			this.removeFromIndex(childPath);
			this.pathToFile.delete(childPath);
			this.pathAuthorities.delete(childPath);
			this.pathToFile.set(newChildPath, childFile);
			this.pathAuthorities.set(newChildPath, childAuthority);
			this.idToPath.set(this.extractId(childFile), newChildPath);
			this.addToIndex(newChildPath);
			if (this.folders.delete(childPath)) {
				this.folders.add(newChildPath);
			}
			const merged = this.mergedFolders.get(childPath);
			if (merged !== undefined) {
				this.mergedFolders.delete(childPath);
				this.mergedFolders.set(newChildPath, merged);
				for (const id of merged.keys()) this.idToPath.set(id, newChildPath);
			}
		}
	}

	/** Remove an entry and all its descendants from the cache */
	removeTree(path: string): void {
		// Collect descendants before mutating; removeEntry only touches the parent's
		// child-set, not `path`'s own children entry, so the snapshot stays complete.
		const descendants = this.collectDescendants(path);
		this.removeEntry(path);
		for (const p of descendants) {
			this.removeEntry(p);
		}
		// Drop `path`'s own children-index entry (removeEntry only clears its membership
		// in the parent's set).
		this.children.delete(path);
	}

	/**
	 * Apply a file change and return move/rename information.
	 * Captures the old path before cache mutation for move detection.
	 */
	applyFileChangeDetectMove(file: TFile): FileChangeResult {
		const id = this.extractId(file);
		const oldPath = this.getPathById(id);
		const wasFolder = oldPath ? this.isFolder(oldPath) : false;
		// The object's own descendants: under a path merged folders share, the other
		// folders' contents stay where they are and are not part of this move.
		const oldDescendants = (oldPath && wasFolder) ? this.subtreePaths(id) : [];
		const leftShared = oldPath !== undefined && this.isShared(oldPath);
		const applied = this.applyFileChange(file);
		const newPath = this.getPathById(id);
		const joinedShared = newPath !== undefined && this.isShared(newPath);
		return {
			oldPath,
			newPath,
			wasFolder,
			oldDescendants,
			displacement: applied?.displacement ?? null,
			withheld: applied?.withheld ?? null,
			additionalLosses: applied?.additionalLosses ?? [],
			relocated: applied?.relocated ?? [],
			acrossSharedPath: wasFolder && oldPath !== newPath && (leftShared || joinedShared),
		};
	}

	/**
	 * Apply a single file change to the metadata cache.
	 *
	 * Returns null on exactly the cases that returned null before arbitration
	 * existed — an unresolvable path and the reserved metadata path — so a caller's
	 * "place it at the requested path instead" fallback still fires only for those.
	 */
	applyFileChange(file: TFile): FileChangeApplication | null {
		const id = this.extractId(file);
		const path = this.resolvePathFromCache(file);
		const oldPath = this.idToPath.get(id);

		// Can't resolve path (moved outside root or parent unknown), or the path is
		// the backend's own metadata file, which is never tracked. Either way, drop
		// a stale cache entry if one exists — this object's, and nothing that merely
		// shares its path.
		if (!path || this.isReserved(path)) {
			if (oldPath) this.removeObject(id);
			return null;
		}

		// A move takes the object's own subtree out whole before anything is decided at
		// the destination, so every seat below is an arrival — and a folder moving into
		// an address other folders share brings children that may meet theirs.
		const moving = oldPath !== undefined && oldPath !== path ? this.capture(id) : [];
		this.detachAll(moving);
		const vacated = moving[0]?.oldPath ?? null;
		// The delta names this entry and its parent id directly, so the entry's own
		// spelling is provider-resolved. getPathAuthority() still projects any
		// unresolved ancestor over it until that ancestor is confirmed.
		const root = this.seatArbitrated(path, id, file, "actual_resolved");
		if (root.withheld) {
			const displaced = moving.slice(1).map((item) => item.oldPath);
			return {
				path: null, displacement: null, additionalLosses: [], relocated: [],
				withheld: this.announce({ ...root.withheld, displacedPaths: [...new Set(displaced)].sort(), vacatedPath: vacated }),
			};
		}
		if (vacated === null || !this.isFolderEntry(file)) {
			return { path, displacement: root.displacement, withheld: null, additionalLosses: root.evictedMerged, relocated: [] };
		}
		const { losses, relocated } = this.reseat(moving.slice(1), vacated, path);
		return {
			path, displacement: root.displacement, withheld: null,
			additionalLosses: [...root.evictedMerged, ...losses], relocated,
		};
	}

	/**
	 * Seat one arriving object at `path`, arbitrated against whatever holds it now.
	 *
	 * A derived address held by a different live id is a contention, not a
	 * last-write-wins upsert: the same rule decides it in every arrival order. A
	 * withheld arrival is returned unannounced, because only the caller knows what
	 * went with it.
	 */
	private seatArbitrated(
		path: string, id: string, file: TFile, authority: PathAuthority,
	): {
		displacement: AddressDisplacement | null;
		/** Folders that shared `path` with the evicted representative, each a loss of its own. */
		evictedMerged: WithheldClaim[];
		withheld: Omit<WithheldClaim, "displacedPaths" | "vacatedPath"> | null;
	} {
		const occupantId = this.idAt(path);
		const verdict = occupantId === undefined || occupantId === id ? null : arbitrateAddress(
			path, this.claimAt(path, occupantId), { id, authority, isFolder: this.isFolderEntry(file) },
		);
		if (verdict?.outcome === "admit_incumbent") {
			return { displacement: null, evictedMerged: [], withheld: {
				path, admittedId: verdict.admittedId, withheldId: id,
				reason: verdict.reason, owesRemediation: verdict.withheldOwesRemediation,
			} };
		}
		const [displacement = null, ...merged] = verdict?.outcome === "admit_claimant" ? this.displaceOccupant(
			path, id, verdict.withheldId, verdict.reason, verdict.withheldOwesRemediation,
		) : [];
		this.setFile(path, file, authority);
		return {
			displacement, withheld: null,
			evictedMerged: merged.map((fact) => ({ ...fact, vacatedPath: fact.path })),
		};
	}

	/**
	 * Re-seat a moved folder's captured descendants under its new path, shallow-first,
	 * each arbitrated against whatever already lives at its new address. A descendant
	 * that loses takes its own subtree with it, exactly as a withheld claimant always
	 * has; every loss — withheld here, or an occupant evicted — is returned as a fact.
	 */
	private reseat(
		descendants: readonly CapturedObject<TFile>[], fromPath: string, toPath: string,
	): { losses: WithheldClaim[]; relocated: RelocatedEntry[] } {
		const relocated: RelocatedEntry[] = [];
		const evicted: WithheldClaim[] = [];
		const lost = new Map<string, { claim: Omit<WithheldClaim, "displacedPaths" | "vacatedPath">; vacatedPath: string; displaced: string[] }>();
		const causeOf = new Map<string, string>();
		for (const item of descendants) {
			const cause = item.under === undefined ? undefined : causeOf.get(item.under);
			if (cause !== undefined) {
				lost.get(cause)!.displaced.push(item.oldPath);
				causeOf.set(item.id, cause);
				continue;
			}
			const target = toPath + item.oldPath.slice(fromPath.length);
			const seat = this.seatArbitrated(target, item.id, item.file, item.authority);
			if (seat.withheld) {
				lost.set(item.id, { claim: seat.withheld, vacatedPath: item.oldPath, displaced: [] });
				causeOf.set(item.id, item.id);
				continue;
			}
			if (seat.displacement) evicted.push({ ...seat.displacement, vacatedPath: seat.displacement.path });
			evicted.push(...seat.evictedMerged);
			relocated.push({ oldPath: item.oldPath, newPath: target, isFolder: this.isFolderEntry(item.file) });
		}
		const withheld = [...lost.values()].map(({ claim, vacatedPath, displaced }) => this.announce({
			...claim, displacedPaths: [...new Set(displaced)].sort(), vacatedPath,
		}));
		return { losses: [...withheld, ...evicted], relocated };
	}
}

/**
 * The identity a cache's own `FileEntity` projection gives whatever is cached at
 * `path` — the single source every rename producer reads when it fills a
 * `RenamePair.identityKey`.
 *
 * Total: exactly `cache.toEntity(path, file).identityKey` when an entry is cached at
 * `path`, and `undefined` when none is. It never throws, holds no state, and keeps
 * nothing that outlives the call.
 *
 * A free function over the already-public `toEntity`/`getFile` rather than a member,
 * so no backend subclass gains an obligation and the value can only ever come from
 * the projection. In particular it never reads `extractId`, `idAt`, `getPathById` or
 * `snapshotPathsById`: those answer "how do I address this entry?" and are total by
 * design (Dropbox's falls back to `path_lower`), whereas the projection answers "what
 * is this object's provider identity?" and legitimately has none for an id-less entry.
 * Mixing the two would leak a cache-internal address across the `IFileSystem` boundary.
 *
 * `file` defaults to the entry cached at `path`; a caller that already holds it (a
 * `cache.entries()` walk) passes it to skip the re-lookup.
 */
export function projectedIdentityKey<TFile>(
	cache: AbstractMetadataCache<TFile>,
	path: string,
	file: TFile | undefined = cache.getFile(path),
): string | undefined {
	return file === undefined ? undefined : cache.toEntity(path, file).identityKey;
}
