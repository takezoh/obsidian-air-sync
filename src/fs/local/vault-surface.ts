import { TFile, TFolder } from "../../platform/obsidian";
import type { App, TAbstractFile, Vault } from "../../platform/obsidian";
import type { FileEntity } from "../types";
import { sha256 } from "../../utils/hash";

/**
 * The index authority for the local vault: Obsidian's `Vault` / `FileManager` API.
 *
 * It is the authority for mutating a path the index can represent, because an
 * indexed mutation keeps the vault's in-memory index and its change events
 * coherent; and for the normal-path half of the vault's discovery snapshot. It is
 * deliberately not the authority for current existence, casing, or occupancy —
 * the index under-reports (it excludes dot-prefixed paths and can lag) — those
 * belong to the disk surface, and `LocalFs` composes the two.
 */
export class VaultSurface {
	private readonly vault: Vault;
	private readonly fileManager: App["fileManager"];

	constructor(app: App) {
		this.vault = app.vault;
		this.fileManager = app.fileManager;
	}

	/**
	 * The in-memory `getAllLoadedFiles()` snapshot, projected to `FileEntity`.
	 *
	 * It **can under-report before the workspace layout is ready**, so callers must
	 * be in a layout-ready-gated context (owned by the sync engine, not here). Only
	 * representable paths appear; dot-prefixed paths are absent from the index.
	 */
	snapshot(): FileEntity[] {
		const entities: FileEntity[] = [];
		for (const file of this.vault.getAllLoadedFiles()) {
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
					// read when a hash is needed (ADR 0005).
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
		return entities;
	}

	/** The index entry for a path, or `null` when the index does not hold one. */
	entry(path: string): TAbstractFile | null {
		return this.vault.getAbstractFileByPath(path);
	}

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		return this.vault.readBinary(file);
	}

	/** Overwrite an existing indexed file and return its post-write entity. */
	async overwrite(file: TFile, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		await this.vault.modifyBinary(file, content, { mtime });
		return this.toEntity(file.path, file.stat, content);
	}

	/** Create an indexed file whose parent already exists, and return its entity. */
	async create(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		const written = await this.vault.createBinary(path, content, { mtime });
		return this.toEntity(path, written.stat, content);
	}

	private async toEntity(
		path: string,
		stat: { size: number; mtime: number },
		content: ArrayBuffer,
	): Promise<FileEntity> {
		return {
			path,
			pathAuthority: "requested_echo",
			isDirectory: false,
			size: stat.size,
			mtime: stat.mtime,
			hash: await sha256(content),
		};
	}

	async createFolder(path: string): Promise<void> {
		await this.vault.createFolder(path);
	}

	async trash(file: TAbstractFile): Promise<void> {
		await this.fileManager.trashFile(file);
	}

	async rename(file: TAbstractFile, newPath: string): Promise<void> {
		await this.vault.rename(file, newPath);
	}
}
