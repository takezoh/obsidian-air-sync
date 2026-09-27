import { TFile, TFolder } from "../../platform/obsidian";
import type { App } from "../../platform/obsidian";
import type { IFileSystem } from "../interface";
import type { FileEntity } from "../types";
import { normalizeSyncPath, validateRename, isDotPrefixed } from "../../utils/path";
import { DiskSurface } from "./disk-surface";
import { VaultSurface } from "./vault-surface";

/**
 * `IFileSystem` over an Obsidian vault, composed from two authorities:
 *
 * - **Disk authority** (`DiskSurface`, the raw `DataAdapter`): current existence,
 *   actual casing, direct-child occupancy, and mutation of paths the Vault index
 *   cannot represent (dot-prefixed). It sees everything on disk.
 * - **Vault authority** (`VaultSurface`, the indexed `Vault`/`FileManager` API):
 *   mutation of representable paths, so Obsidian's index and change events stay
 *   coherent, and the normal-path half of the discovery snapshot.
 *
 * This class owns only the composition: the authority rule, parent-directory
 * creation across regimes, and a cross-regime rename. Each method states which
 * authority it uses; nothing here reads the raw `vault`/`adapter` directly.
 */
export class LocalFs implements IFileSystem {
	readonly name = "local";
	private readonly disk: DiskSurface;
	private readonly indexed: VaultSurface;

	constructor(app: App, getDotPaths: () => string[] = () => []) {
		this.indexed = new VaultSurface(app);
		this.disk = new DiskSurface(
			app.vault,
			(p) => this.mkdirRecursive(p),
			getDotPaths,
		);
	}

	/**
	 * Discovery snapshot: the vault index for representable paths, plus a recursive
	 * disk scan of the configured dot roots. The disk authority is consulted only to
	 * resolve a case-collision alias the index may have retained. This view is scoped
	 * to the vault's concept of its contents; it is not the occupancy authority.
	 *
	 * The index snapshot can under-report before the workspace layout is ready. That
	 * gate is the orchestrator's (the timing authority), not this low-level adapter's,
	 * so new callers MUST be in a layout-ready-gated context.
	 */
	async list(): Promise<FileEntity[]> {
		const entities = await this.removeStaleCaseAliases(this.indexed.snapshot());
		await this.disk.scanRoots(entities);
		return entities;
	}

	/**
	 * A case-only rename can briefly leave both spellings in Obsidian's index even
	 * though the adapter has one entry. Resolve only those collisions against disk;
	 * the normal listing path remains I/O-free, and genuinely distinct case-sensitive
	 * paths remain distinct because each resolves to itself.
	 */
	private async removeStaleCaseAliases(entities: FileEntity[]): Promise<FileEntity[]> {
		const groups = new Map<string, FileEntity[]>();
		for (const entity of entities) {
			const key = entity.path.toLowerCase();
			const group = groups.get(key) ?? [];
			group.push(entity);
			groups.set(key, group);
		}
		const collisions = [...groups.values()].filter((group) =>
			new Set(group.map((entity) => entity.path)).size > 1);
		if (collisions.length === 0) return entities;

		const candidatePaths = collisions.flatMap((group) =>
			[...new Set(group.map((entity) => entity.path))]);
		const resolved = await this.disk.resolveActualPaths(candidatePaths);
		const stalePaths = new Set<string>();
		for (const group of collisions) {
			const pathsByActual = new Map<string, string[]>();
			for (const path of new Set(group.map((entity) => entity.path))) {
				const actualPath = resolved.get(path);
				if (!actualPath) throw new Error(`Cannot resolve local path casing: ${path}`);
				const aliases = pathsByActual.get(actualPath) ?? [];
				aliases.push(path);
				pathsByActual.set(actualPath, aliases);
			}
			for (const [actualPath, aliases] of pathsByActual) {
				if (aliases.length === 1) continue;
				if (!aliases.includes(actualPath)) {
					throw new Error(`Vault index omits resolved local path casing: ${actualPath}`);
				}
				for (const alias of aliases) {
					if (alias !== actualPath) stalePaths.add(alias);
				}
			}
		}
		return entities.filter((entity) => !stalePaths.has(entity.path));
	}

	/** Authoritative absence and actual casing: the disk authority, for every path. */
	async stat(path: string): Promise<FileEntity | null> {
		return this.disk.stat(normalizeSyncPath(path));
	}

	/** Authoritative direct-child occupancy: the disk authority, for every path. */
	async hasChildren(path: string): Promise<boolean> {
		return this.disk.hasChildren(normalizeSyncPath(path));
	}

	async read(path: string): Promise<ArrayBuffer> {
		path = normalizeSyncPath(path);
		const file = this.indexed.entry(path);
		if (!file && isDotPrefixed(path)) return this.disk.read(path);
		if (!file) throw new Error(`File not found: ${path}`);
		if (!(file instanceof TFile)) throw new Error(`Not a file (is a directory): ${path}`);
		return this.indexed.readBinary(file);
	}

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		if (isDotPrefixed(path)) {
			// Hidden paths can't go through the indexed Vault API: createBinary
			// returns null (no TFile in the index) or throws "File already exists".
			// Write via the disk authority, which overwrites and is index-independent.
			return this.disk.write(path, content, mtime);
		}
		const existing = this.indexed.entry(path);
		if (existing instanceof TFolder) {
			throw new Error(`Cannot write file: "${path}" is an existing directory`);
		}
		if (existing instanceof TFile) return this.indexed.overwrite(existing, content, mtime);
		const parentPath = path.substring(0, path.lastIndexOf("/"));
		if (parentPath) await this.mkdirRecursive(parentPath);
		return this.indexed.create(path, content, mtime);
	}

	async mkdir(path: string): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		await this.mkdirRecursive(path);
		return { path, pathAuthority: "requested_echo", isDirectory: true, size: 0, mtime: 0, hash: "" };
	}

	async delete(path: string): Promise<void> {
		path = normalizeSyncPath(path);
		if (isDotPrefixed(path)) return this.disk.delete(path);
		const file = this.indexed.entry(path);
		if (file) await this.indexed.trash(file);
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		oldPath = normalizeSyncPath(oldPath);
		newPath = normalizeSyncPath(newPath);
		validateRename(oldPath, newPath);
		const oldHidden = isDotPrefixed(oldPath);
		const newHidden = isDotPrefixed(newPath);
		if (oldHidden && newHidden) {
			// Both hidden: the disk authority moves them natively (index-independent).
			return this.disk.rename(oldPath, newPath);
		}
		if (oldHidden !== newHidden) {
			// Cross-regime move (hidden ↔ normal). Routing the whole rename through
			// one authority leaves the other side's vault index stale, so decompose
			// into regime-aware read/write/delete (each routes by isDotPrefixed).
			return this.renameAcrossRegime(oldPath, newPath);
		}
		// Both normal: native, index-aware Vault rename.
		const file = this.indexed.entry(oldPath);
		if (!file) throw new Error(`File not found: ${oldPath}`);
		if (this.indexed.entry(newPath)) throw new Error(`Destination already exists: ${newPath}`);
		const parentPath = newPath.substring(0, newPath.lastIndexOf("/"));
		if (parentPath) await this.mkdirRecursive(parentPath);
		await this.indexed.rename(file, newPath);
	}

	/**
	 * Move a file across the hidden/normal boundary via regime-aware ops so the
	 * Vault index stays coherent on the non-hidden side (read/write/delete each
	 * route by isDotPrefixed). Directories don't move across this boundary in
	 * practice and are rejected rather than left half-applied with a stale index.
	 */
	private async renameAcrossRegime(oldPath: string, newPath: string): Promise<void> {
		const stat = await this.stat(oldPath);
		if (!stat) throw new Error(`File not found: ${oldPath}`);
		if (stat.isDirectory) {
			throw new Error(
				`Cannot rename a directory across the hidden/normal boundary: ${oldPath} -> ${newPath}`,
			);
		}
		// Match the contract enforced by the other rename branches (and relied on by
		// the rename optimizer): never clobber an existing destination.
		if (await this.stat(newPath)) {
			throw new Error(`Destination already exists: ${newPath}`);
		}
		const content = await this.read(oldPath);
		await this.write(newPath, content, stat.mtime);
		await this.delete(oldPath);
	}

	/**
	 * Ensure every ancestor directory of `path` exists, on whichever authority owns
	 * each segment: an indexed segment goes through the Vault API (so the index and
	 * events stay coherent), a hidden segment through the disk authority. A segment
	 * already on disk but absent from the index is left as-is.
	 */
	private async mkdirRecursive(path: string): Promise<void> {
		if (this.indexed.entry(path) instanceof TFolder) return;

		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const entry = this.indexed.entry(current);
			if (entry instanceof TFile) {
				throw new Error(`Cannot create directory "${path}": "${current}" is a file`);
			}
			if (!entry && !(await this.disk.exists(current))) {
				// Hidden dirs are excluded from the vault index; the indexed
				// createFolder can't reliably create them (same class as createBinary),
				// so use the disk authority — matching how every hidden-path op is routed.
				if (isDotPrefixed(current)) await this.disk.mkdir(current);
				else await this.indexed.createFolder(current);
			}
		}
	}
}
