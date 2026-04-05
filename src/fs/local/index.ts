import { App, TFile, TFolder, Vault } from "obsidian";
import type { IFileSystem } from "../interface";
import type { FileEntity } from "../types";
import { sha256 } from "../../utils/hash";
import { normalizeSyncPath, validateRename } from "../../utils/path";

/**
 * Recursively enumerate a dot-prefixed directory via the raw vault adapter,
 * which bypasses Obsidian's file index (dot paths are excluded from the index).
 */
async function collectDotPath(vault: Vault, dir: string, entities: FileEntity[]): Promise<void> {
	if (!(await vault.adapter.exists(dir))) return;
	const listed = await vault.adapter.list(dir);
	for (const folder of listed.folders) {
		entities.push({ path: folder, isDirectory: true, size: 0, mtime: 0, hash: "" });
		await collectDotPath(vault, folder, entities);
	}
	for (const file of listed.files) {
		const s = await vault.adapter.stat(file);
		entities.push({
			path: file,
			isDirectory: false,
			size: s?.size ?? 0,
			mtime: s?.mtime ?? 0,
			hash: "",
		});
	}
}

/** IFileSystem implementation backed by an Obsidian Vault */
export class LocalFs implements IFileSystem {
	readonly name = "local";
	private vault: Vault;
	private app: App;
	private getSyncDotPaths: () => string[];

	constructor(app: App, getSyncDotPaths: () => string[] = () => []) {
		this.app = app;
		this.vault = app.vault;
		this.getSyncDotPaths = getSyncDotPaths;
	}

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

		// Enumerate user-configured dot paths (e.g. .templates, .stversions).
		// AIRSYNC_DIR (.airsync) is intentionally absent — it is internal plugin
		// storage and excluded from sync unless the user explicitly adds it here.
		for (const root of this.getSyncDotPaths()) {
			await collectDotPath(this.vault, root, entities);
		}

		return entities;
	}

	async stat(path: string): Promise<FileEntity | null> {
		path = normalizeSyncPath(path);
		const file = this.vault.getAbstractFileByPath(path);
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
			return { path: file.path, isDirectory: true, size: 0, mtime: 0, hash: "" };
		}

		// Not in vault index (e.g. dot-prefixed paths) — fall back to raw adapter
		const s = await this.vault.adapter.stat(path);
		if (!s) return null;
		if (s.type === "folder") return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
		const content = await this.vault.adapter.readBinary(path);
		const hash = await sha256(content);
		return { path, isDirectory: false, size: s.size, mtime: s.mtime, hash };
	}

	async read(path: string): Promise<ArrayBuffer> {
		path = normalizeSyncPath(path);
		const file = this.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) return this.vault.readBinary(file);

		// Not in vault index — fall back to raw adapter
		if (!(await this.vault.adapter.exists(path))) throw new Error(`File not found: ${path}`);
		return this.vault.adapter.readBinary(path);
	}

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) {
			throw new Error(`Cannot write file: "${path}" is an existing directory`);
		}
		if (existing instanceof TFile) {
			await this.vault.modifyBinary(existing, content, { mtime });
			const hash = await sha256(content);
			return {
				path,
				isDirectory: false,
				size: existing.stat.size,
				mtime: existing.stat.mtime,
				hash,
			};
		}

		// Path not in vault index — use raw adapter for dot-prefixed paths.
		// Obsidian never indexes paths starting with ".", so this covers .airsync/,
		// user-configured dot paths (.templates/, etc.), and any other dot roots.
		if (path.startsWith(".")) {
			const parentPath = path.substring(0, path.lastIndexOf("/"));
			if (parentPath && !(await this.vault.adapter.exists(parentPath))) {
				await this.mkdirRecursive(parentPath);
			}
			await this.vault.adapter.writeBinary(path, content, { mtime });
			const hash = await sha256(content);
			return { path, isDirectory: false, size: content.byteLength, mtime, hash };
		}

		// New regular file — create via vault API
		const parentPath = path.substring(0, path.lastIndexOf("/"));
		if (parentPath) {
			await this.mkdirRecursive(parentPath);
		}
		const written = await this.vault.createBinary(path, content, { mtime });
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
		const folder = this.vault.getAbstractFileByPath(path);
		if (folder instanceof TFolder) {
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

		// Not in vault index — fall back to raw adapter
		if (!(await this.vault.adapter.exists(path))) return [];
		const listed = await this.vault.adapter.list(path);
		const entities: FileEntity[] = [];
		for (const f of listed.folders) {
			entities.push({ path: f, isDirectory: true, size: 0, mtime: 0, hash: "" });
		}
		for (const f of listed.files) {
			const s = await this.vault.adapter.stat(f);
			entities.push({ path: f, isDirectory: false, size: s?.size ?? 0, mtime: s?.mtime ?? 0, hash: "" });
		}
		return entities;
	}

	async delete(path: string): Promise<void> {
		path = normalizeSyncPath(path);
		const file = this.vault.getAbstractFileByPath(path);
		if (file) {
			await this.app.fileManager.trashFile(file);
			return;
		}

		// Not in vault index — fall back to raw adapter
		if (await this.vault.adapter.exists(path)) {
			const s = await this.vault.adapter.stat(path);
			if (s?.type === "folder") {
				await this.vault.adapter.rmdir(path, true);
			} else {
				await this.vault.adapter.remove(path);
			}
		}
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		oldPath = normalizeSyncPath(oldPath);
		newPath = normalizeSyncPath(newPath);
		validateRename(oldPath, newPath);

		const file = this.vault.getAbstractFileByPath(oldPath);
		if (file) {
			if (this.vault.getAbstractFileByPath(newPath)) {
				throw new Error(`Destination already exists: ${newPath}`);
			}
			const parentPath = newPath.substring(0, newPath.lastIndexOf("/"));
			if (parentPath) {
				await this.mkdirRecursive(parentPath);
			}
			await this.vault.rename(file, newPath);
			return;
		}

		// Not in vault index — fall back to raw adapter (handles dot-prefixed paths)
		if (!(await this.vault.adapter.exists(oldPath))) {
			throw new Error(`File not found: ${oldPath}`);
		}
		if (await this.vault.adapter.exists(newPath)) {
			throw new Error(`Destination already exists: ${newPath}`);
		}
		const parentPath = newPath.substring(0, newPath.lastIndexOf("/"));
		if (parentPath && !(await this.vault.adapter.exists(parentPath))) {
			await this.mkdirRecursive(parentPath);
		}
		const s = await this.vault.adapter.stat(oldPath);
		if (s?.type === "folder") {
			const listed = await this.vault.adapter.list(oldPath);
			await this.mkdirRecursive(newPath);
			const children: string[] = [...listed.folders, ...listed.files];
			for (const child of children) {
				const childNewPath = newPath + child.substring(oldPath.length);
				await this.rename(child, childNewPath);
			}
			await this.vault.adapter.rmdir(oldPath, false);
		} else {
			const content = await this.vault.adapter.readBinary(oldPath);
			await this.vault.adapter.writeBinary(newPath, content, { mtime: s?.mtime });
			await this.vault.adapter.remove(oldPath);
		}
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
					await this.vault.createFolder(current);
				}
			}
		}
	}
}
