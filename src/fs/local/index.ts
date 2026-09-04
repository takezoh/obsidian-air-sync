import { TFile, TFolder } from "../../platform/obsidian";
import type { App, Vault } from "../../platform/obsidian";
import type { IFileSystem } from "../interface";
import type { FileEntity } from "../types";
import { sha256 } from "../../utils/hash";
import { normalizeSyncPath, validateRename, isDotPrefixed } from "../../utils/path";
import { DotPathAdapter } from "./dot-path-adapter";

/** IFileSystem implementation backed by an Obsidian Vault */
export class LocalFs implements IFileSystem {
	readonly name = "local";
	private vault: Vault;
	private app: App;
	private dotPath: DotPathAdapter;

	constructor(app: App, getDotPaths: () => string[] = () => []) {
		this.app = app;
		this.vault = app.vault;
		this.dotPath = new DotPathAdapter(
			this.vault,
			(p) => this.mkdirRecursive(p),
			getDotPaths,
		);
	}

	/**
	 * List the vault index. This returns the in-memory `getAllLoadedFiles()` snapshot,
	 * which **can under-report before the workspace layout is ready**. It does NOT gate
	 * on layout-ready itself — that is the CALLER's responsibility, and it is owned by
	 * the sync engine: `SyncOrchestrator.runSync()` (and `shouldSync()`) early-return
	 * until `isLayoutReady`, and the only path here runs through them
	 * (runSync → executeSyncOnce → collectChanges → list). Keeping the gate in the
	 * orchestrator (the timing authority) rather than in this low-level FS adapter
	 * avoids coupling LocalFs to the workspace lifecycle. New callers of `list()` MUST
	 * be in a layout-ready-gated context.
	 */
	async list(): Promise<FileEntity[]> {
		let entities: FileEntity[] = [];
		const allFiles = this.vault.getAllLoadedFiles();

		for (const file of allFiles) {
			// Skip root
			if (file.path === "/" || file.path === "") continue;

			if (file instanceof TFile) {
				entities.push({
					path: file.path,
					pathAuthority: "actual_resolved",
					isDirectory: false,
					size: file.stat.size,
					mtime: file.stat.mtime,
					// hash is "" by design: listing never reads file content. Change detection
					// falls back to mtime+size for list-sourced entries; stat() pays the content
					// read when a hash is needed (ADR 0005). Only casing collisions below add
					// raw-adapter directory listings.
					hash: "",
				});
			} else if (file instanceof TFolder) {
				entities.push({
					path: file.path,
					pathAuthority: "actual_resolved",
					isDirectory: true,
					size: 0,
					mtime: 0,
					hash: "",
				});
			}
		}
		entities = await this.removeStaleCaseAliases(entities);

		// Dot-prefixed paths are excluded from Vault index; scan via adapter
		await this.dotPath.listAll(entities);

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
		const resolved = await this.dotPath.resolveActualPaths(candidatePaths);
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

	async stat(path: string): Promise<FileEntity | null> {
		path = normalizeSyncPath(path);
		// stat() is the authoritative absence/casing check. Obsidian's in-memory
		// index may be missing an entry or retain a stale alias after a case-only
		// rename, so resolve through the raw adapter for every path.
		return this.dotPath.stat(path);
	}

	async read(path: string): Promise<ArrayBuffer> {
		path = normalizeSyncPath(path);
		const file = this.vault.getAbstractFileByPath(path);
		if (!file && isDotPrefixed(path)) {
			return this.dotPath.read(path);
		}
		if (!file) throw new Error(`File not found: ${path}`);
		if (!(file instanceof TFile)) throw new Error(`Not a file (is a directory): ${path}`);
		return this.vault.readBinary(file);
	}

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		if (isDotPrefixed(path)) {
			// Hidden paths can't go through the indexed Vault API: createBinary
			// returns null (no TFile in the index) or throws "File already exists".
			// Write via the adapter, which overwrites and is index-independent.
			return this.dotPath.write(path, content, mtime);
		}
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) {
			throw new Error(`Cannot write file: "${path}" is an existing directory`);
		}
		let written: TFile;
		if (existing instanceof TFile) {
			await this.vault.modifyBinary(existing, content, { mtime });
			written = existing;
		} else {
			// Ensure parent directories exist
			const parentPath = path.substring(0, path.lastIndexOf("/"));
			if (parentPath) {
				await this.mkdirRecursive(parentPath);
			}
			written = await this.vault.createBinary(path, content, { mtime });
		}
		const hash = await sha256(content);
		return {
			path,
			pathAuthority: "requested_echo",
			isDirectory: false,
			size: written.stat.size,
			mtime: written.stat.mtime,
			hash,
		};
	}

	async mkdir(path: string): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		await this.mkdirRecursive(path);
		return { path, pathAuthority: "requested_echo", isDirectory: true, size: 0, mtime: 0, hash: "" };
	}

	async listDir(path: string): Promise<FileEntity[]> {
		path = normalizeSyncPath(path);
		if (isDotPrefixed(path)) {
			return this.dotPath.listDir(path);
		}
		const folder = this.vault.getAbstractFileByPath(path);
		if (!(folder instanceof TFolder)) return [];
		return folder.children.map((child) => {
			if (child instanceof TFile) {
				return {
					path: child.path,
					pathAuthority: "actual_resolved",
					isDirectory: false,
					size: child.stat.size,
					mtime: child.stat.mtime,
					hash: "",
				};
			}
			return { path: child.path, pathAuthority: "actual_resolved", isDirectory: true, size: 0, mtime: 0, hash: "" };
		});
	}

	async delete(path: string): Promise<void> {
		path = normalizeSyncPath(path);
		if (isDotPrefixed(path)) {
			return this.dotPath.delete(path);
		}
		const file = this.vault.getAbstractFileByPath(path);
		if (file) {
			await this.app.fileManager.trashFile(file);
		}
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		oldPath = normalizeSyncPath(oldPath);
		newPath = normalizeSyncPath(newPath);
		validateRename(oldPath, newPath);
		const oldHidden = isDotPrefixed(oldPath);
		const newHidden = isDotPrefixed(newPath);
		if (oldHidden && newHidden) {
			// Both hidden: the adapter moves them natively (index-independent).
			return this.dotPath.rename(oldPath, newPath);
		}
		if (oldHidden !== newHidden) {
			// Cross-regime move (hidden ↔ normal). Routing the whole rename through
			// one API leaves the other side's vault index stale, so decompose into
			// regime-aware read/write/delete (each routes by isDotPrefixed).
			return this.renameAcrossRegime(oldPath, newPath);
		}
		// Both normal: native, index-aware Vault rename.
		const file = this.vault.getAbstractFileByPath(oldPath);
		if (!file) {
			throw new Error(`File not found: ${oldPath}`);
		}
		if (this.vault.getAbstractFileByPath(newPath)) {
			throw new Error(`Destination already exists: ${newPath}`);
		}
		// Ensure parent directories exist for the new path
		const parentPath = newPath.substring(0, newPath.lastIndexOf("/"));
		if (parentPath) {
			await this.mkdirRecursive(parentPath);
		}
		await this.vault.rename(file, newPath);
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

	private async mkdirRecursive(path: string): Promise<void> {
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) return;

		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const entry = this.vault.getAbstractFileByPath(current);
			if (entry instanceof TFile) {
				throw new Error(`Cannot create directory "${path}": "${current}" is a file`);
			}
			if (!entry) {
				// Folder may exist on disk but not in vault index (e.g. dot-prefixed dirs
				// created by other plugins). Check disk before creating.
				if (!(await this.vault.adapter.exists(current))) {
					// Hidden dirs are excluded from the vault index; the indexed
					// createFolder can't reliably create them (same class as createBinary),
					// so use the raw adapter — matching how every hidden-path op is routed.
					if (isDotPrefixed(current)) {
						await this.vault.adapter.mkdir(current);
					} else {
						await this.vault.createFolder(current);
					}
				}
			}
		}
	}
}
