import { App, TFile, TFolder, Vault } from "obsidian";
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
		const entities: FileEntity[] = [];
		const allFiles = this.vault.getAllLoadedFiles();

		for (const file of allFiles) {
			// Skip root
			if (file.path === "/" || file.path === "") continue;

			if (file instanceof TFile) {
				entities.push({
					path: file.path,
					isDirectory: false,
					size: file.stat.size,
					mtime: file.stat.mtime,
					hash: "",
				});
			} else if (file instanceof TFolder) {
				entities.push({
					path: file.path,
					isDirectory: true,
					size: 0,
					mtime: 0,
					hash: "",
				});
			}
		}

		// Dot-prefixed paths are excluded from Vault index; scan via adapter
		await this.dotPath.listAll(entities);

		return entities;
	}

	async stat(path: string): Promise<FileEntity | null> {
		path = normalizeSyncPath(path);
		const file = this.vault.getAbstractFileByPath(path);
		if (!file && isDotPrefixed(path)) {
			// Hidden paths are never in the vault index — read via the adapter.
			return this.dotPath.stat(path);
		}
		if (!file) {
			// A normal path may simply not be loaded into the index yet, so confirm
			// against the raw adapter (absence is what drives deletions). The adapter
			// stat is regime-independent, so the dot-path adapter's identical impl
			// serves both routes — no separate non-dot helper needed.
			return this.dotPath.stat(path);
		}

		if (file instanceof TFile) {
			const content = await this.vault.readBinary(file);
			const hash = await sha256(content);
			return {
				path: file.path,
				isDirectory: false,
				size: file.stat.size,
				mtime: file.stat.mtime,
				hash,
			};
		} else if (file instanceof TFolder) {
			return {
				path: file.path,
				isDirectory: true,
				size: 0,
				mtime: 0,
				hash: "",
			};
		}

		return null;
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
			isDirectory: false,
			size: written.stat.size,
			mtime: written.stat.mtime,
			hash,
		};
	}

	async mkdir(path: string): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		await this.mkdirRecursive(path);
		return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
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
					isDirectory: false,
					size: child.stat.size,
					mtime: child.stat.mtime,
					hash: "",
				};
			}
			return { path: child.path, isDirectory: true, size: 0, mtime: 0, hash: "" };
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
