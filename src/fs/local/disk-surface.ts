import type { Vault } from "../../platform/obsidian";
import type { FileEntity } from "../types";
import { sha256 } from "../../utils/hash";

/**
 * The disk authority for the local vault: a thin wrapper over Obsidian's raw
 * `DataAdapter`.
 *
 * It sees the filesystem as it actually is — every child including dot-prefixed
 * entries the Vault index excludes — and is therefore the authority for current
 * existence, actual casing, direct-child occupancy, and for mutating a path the
 * Vault index cannot represent. It is deliberately not the authority for an
 * indexed-path mutation, which must keep Obsidian's index and events coherent;
 * that belongs to the Vault surface, and `LocalFs` composes the two.
 *
 * `mkdirFn` is the composition's parent-ensuring hook: creating an ancestor can
 * cross into the indexed surface, so `LocalFs` owns it and supplies it here rather
 * than the disk surface guessing a regime per segment.
 */
export class DiskSurface {
	constructor(
		private vault: Vault,
		private mkdirFn: (path: string) => Promise<void>,
		private getDotRoots: () => string[],
	) {}

	async exists(path: string): Promise<boolean> {
		return this.vault.adapter.exists(path);
	}

	async mkdir(path: string): Promise<void> {
		await this.vault.adapter.mkdir(path);
	}

	/** Recursively scan every configured dot root into `entities` (index-invisible). */
	async scanRoots(entities: FileEntity[]): Promise<void> {
		for (const root of this.getDotRoots()) {
			await this.list(root, entities);
		}
	}

	private async list(dir: string, entities: FileEntity[]): Promise<void> {
		if (!(await this.vault.adapter.exists(dir))) return;
		const listed = await this.vault.adapter.list(dir);
		for (const folder of listed.folders) {
			entities.push({ path: folder, pathAuthority: "actual_resolved", isDirectory: true, size: 0, mtime: 0, hash: "" });
			await this.list(folder, entities);
		}
		for (const file of listed.files) {
			const s = await this.vault.adapter.stat(file);
			entities.push({
				path: file,
				pathAuthority: "actual_resolved",
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
		const actualPath = (await this.resolveActualPaths([path])).get(path) ?? null;
		const pathAuthority = actualPath ? "actual_resolved" : "requested_echo";
		const resolvedPath = actualPath ?? path;
		if (s.type === "folder") {
			return { path: resolvedPath, pathAuthority, isDirectory: true, size: 0, mtime: 0, hash: "" };
		}
		const content = await this.vault.adapter.readBinary(path);
		const hash = await sha256(content);
		return { path: resolvedPath, pathAuthority, isDirectory: false, size: s.size, mtime: s.mtime, hash };
	}

	/**
	 * Authoritative direct-child occupancy, names only. Dot-prefixed and otherwise
	 * index-invisible children count, so an empty-parent prune never mistakes an
	 * occupied directory for an empty one.
	 */
	async hasChildren(path: string): Promise<boolean> {
		if (!(await this.vault.adapter.exists(path))) return false;
		const listed = await this.vault.adapter.list(path);
		return listed.files.length > 0 || listed.folders.length > 0;
	}

	/** Resolve display casing from the raw adapter, sharing directory reads within one call. */
	async resolveActualPaths(paths: readonly string[]): Promise<Map<string, string>> {
		const listingCache = new Map<string, Promise<string[]>>();
		const resolved = new Map<string, string>();
		await Promise.all(paths.map(async (path) => {
			let parent = "";
			for (const segment of path.split("/")) {
				const candidates = await this.listCandidates(parent, listingCache);
				const exact = candidates.filter((candidate) => basename(candidate) === segment);
				const matches = exact.length > 0 ? exact : candidates.filter((candidate) =>
					basename(candidate).toLowerCase() === segment.toLowerCase());
				if (matches.length !== 1) return;
				parent = matches[0]!;
			}
			resolved.set(path, parent);
		}));
		return resolved;
	}

	private listCandidates(
		parent: string,
		cache: Map<string, Promise<string[]>>,
	): Promise<string[]> {
		let pending = cache.get(parent);
		if (!pending) {
			pending = this.vault.adapter.list(parent).then((listed) => [
				...listed.folders,
				...listed.files,
			]);
			cache.set(parent, pending);
		}
		return pending;
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
		return { path, pathAuthority: "requested_echo", isDirectory: false, size: content.byteLength, mtime, hash };
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

	async rename(oldPath: string, newPath: string): Promise<void> {
		if (!(await this.vault.adapter.exists(oldPath))) {
			throw new Error(`File not found: ${oldPath}`);
		}
		if (await this.vault.adapter.exists(newPath)) {
			throw new Error(`Destination already exists: ${newPath}`);
		}
		const parentPath = newPath.substring(0, newPath.lastIndexOf("/"));
		if (parentPath && !(await this.vault.adapter.exists(parentPath))) {
			await this.mkdirFn(parentPath);
		}
		const s = await this.vault.adapter.stat(oldPath);
		if (s?.type === "folder") {
			// Rename folder: move all children then remove old folder
			const listed = await this.vault.adapter.list(oldPath);
			await this.mkdirFn(newPath);
			for (const child of [...listed.folders, ...listed.files]) {
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
}

function basename(path: string): string {
	const separator = path.lastIndexOf("/");
	return separator === -1 ? path : path.substring(separator + 1);
}
