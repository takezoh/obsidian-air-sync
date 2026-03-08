import { TFile, Vault } from "obsidian";
import type { SyncStateStore } from "./state";
import type { LocalFileSnapshot } from "./state";

/**
 * Detects local file changes using snapshot diff (startup) and vault event tracking (runtime).
 *
 * Two phases:
 * 1. Startup: diff saved snapshot vs current vault → startup changes
 * 2. Runtime: track vault events → runtime changes
 *
 * consume() returns accumulated changed paths (or null if no baseline exists).
 */
export class LocalChangeDetector {
	private readonly vault: Vault;
	private readonly stateStore: SyncStateStore;
	private changedPaths = new Set<string>();
	private active = false;

	constructor(vault: Vault, stateStore: SyncStateStore) {
		this.vault = vault;
		this.stateStore = stateStore;
	}

	/**
	 * Load the saved snapshot and diff against current vault to detect startup changes.
	 * Sets this detector active if a snapshot exists.
	 * @returns true if snapshot was found (delta sync possible), false if full scan needed
	 */
	async initialize(): Promise<boolean> {
		const snapshot = await this.stateStore.loadLocalSnapshot();
		if (!snapshot) return false;

		const changes = this.diffWithSnapshot(snapshot);
		for (const p of changes) this.changedPaths.add(p);
		this.active = true;
		return true;
	}

	/** Track a file create/modify/delete event. No-op if not active. */
	trackChange(path: string): void {
		if (this.active) this.changedPaths.add(path);
	}

	/** Track a rename event. No-op if not active. */
	trackRename(oldPath: string, newPath: string): void {
		if (this.active) {
			this.changedPaths.add(oldPath);
			this.changedPaths.add(newPath);
		}
	}

	/**
	 * Get and reset accumulated changes.
	 * @returns Set of changed paths, or null if not active (no snapshot baseline).
	 */
	consume(): Set<string> | null {
		if (!this.active) return null;
		const result = new Set(this.changedPaths);
		this.changedPaths.clear();
		return result;
	}

	/** Restore previously consumed paths (e.g., after sync failure). */
	restore(paths: Set<string>): void {
		if (this.active) {
			for (const p of paths) this.changedPaths.add(p);
		}
	}

	/**
	 * Save current vault state as a snapshot for future startup diffs.
	 * Also activates runtime tracking.
	 */
	async saveSnapshot(): Promise<void> {
		const snapshot: LocalFileSnapshot = { files: {} };
		for (const file of this.vault.getAllLoadedFiles()) {
			if (file instanceof TFile) {
				snapshot.files[file.path] = { m: file.stat.mtime, s: file.stat.size };
			}
		}
		await this.stateStore.saveLocalSnapshot(snapshot);
		this.active = true;
	}

	private diffWithSnapshot(snapshot: LocalFileSnapshot): Set<string> {
		const changes = new Set<string>();
		const currentFiles = new Map<string, { m: number; s: number }>();

		for (const file of this.vault.getAllLoadedFiles()) {
			if (!(file instanceof TFile)) continue;
			const stat = { m: file.stat.mtime, s: file.stat.size };
			currentFiles.set(file.path, stat);

			const prev = snapshot.files[file.path];
			if (!prev || prev.m !== stat.m || prev.s !== stat.s) {
				changes.add(file.path);
			}
		}

		// Detect deleted files
		for (const path of Object.keys(snapshot.files)) {
			if (!currentFiles.has(path)) {
				changes.add(path);
			}
		}

		return changes;
	}
}
