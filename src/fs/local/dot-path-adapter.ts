import type { Vault } from "obsidian";
import type { FileEntity } from "../types";
import { sha256 } from "../../utils/hash";

/**
 * Handles filesystem operations for dot-prefixed paths (e.g. `.smartsync/`)
 * that are excluded from Obsidian's Vault index. Uses the raw adapter API.
 */
export class DotPathAdapter {
	constructor(
		private vault: Vault,
		private mkdirFn: (path: string) => Promise<void>,
	) {}

	isDotPath(path: string): boolean {
		return path === ".smartsync" || path.startsWith(".smartsync/");
	}

	async list(dir: string, entities: FileEntity[]): Promise<void> {
		if (!(await this.vault.adapter.exists(dir))) return;
		const listed = await this.vault.adapter.list(dir);
		for (const folder of listed.folders) {
			entities.push({ path: folder, isDirectory: true, size: 0, mtime: 0, hash: "" });
			await this.list(folder, entities);
		}
		for (const file of listed.files) {
			const s = await this.vault.adapter.stat(file);
			entities.push({
				path: file,
				isDirectory: false,
				size: s?.size ?? 0,
				mtime: s?.mtime ?? 0,
				hash: "",
			});
		}
	}

	async stat(path: string): Promise<FileEntity | null> {
		const s = await this.vault.adapter.stat(path);
		if (!s) return null;
		if (s.type === "folder") {
			return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
		}
		const content = await this.vault.adapter.readBinary(path);
		const hash = await sha256(content);
		return { path, isDirectory: false, size: s.size, mtime: s.mtime, hash };
	}

	async read(path: string): Promise<ArrayBuffer> {
		if (!(await this.vault.adapter.exists(path))) {
			throw new Error(`File not found: ${path}`);
		}
		return this.vault.adapter.readBinary(path);
	}

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		const parentPath = path.substring(0, path.lastIndexOf("/"));
		if (parentPath && !(await this.vault.adapter.exists(parentPath))) {
			await this.mkdirFn(parentPath);
		}
		await this.vault.adapter.writeBinary(path, content, { mtime });
		const hash = await sha256(content);
		return { path, isDirectory: false, size: content.byteLength, mtime, hash };
	}

	async delete(path: string): Promise<void> {
		if (await this.vault.adapter.exists(path)) {
			const s = await this.vault.adapter.stat(path);
			if (s?.type === "folder") {
				await this.vault.adapter.rmdir(path, true);
			} else {
				await this.vault.adapter.remove(path);
			}
		}
	}
}
