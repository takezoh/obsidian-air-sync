import type { AirSyncSettings } from "../settings";
import type { IFileSystem } from "../fs/interface";
import type { IBackendProvider } from "../fs/backend";
import type { Logger } from "../logging/logger";
import { AsyncMutex } from "../queue/async-queue";
import { isIgnored, isSystemJunkFile } from "../utils/ignore";
import { isDotPathOutOfScope } from "../utils/path";
import { INTERNAL_METADATA_PATH } from "../fs/remote-vault-contract";
import { SyncStateStore } from "./state";
import { LocalChangeTracker } from "./local-tracker";
import { collectChanges } from "./change-detector";
import { planSync } from "./decision-engine";
import { refinePlan } from "./rename-optimizer";
import { executePlan } from "./plan-executor";
import type { ExecutionContext, ExecutionResult } from "./plan-executor";
import { AuthError } from "../fs/errors";
import { getErrorInfo, isRateLimitError, sleep } from "./error";
import type { SyncStatus } from "./types";
import { buildSyncRecord } from "./state-committer";
import { buildNotificationMessage } from "./sync-notification";
import type { SyncCycleResult } from "./sync-notification";

export type { SyncStatus };

export interface SyncOrchestratorDeps {
	getSettings: () => AirSyncSettings;
	saveSettings: () => Promise<void>;
	localFs: () => IFileSystem | null;
	remoteFs: () => IFileSystem | null;
	backendProvider: () => IBackendProvider | null;
	onStatusChange: (status: SyncStatus) => void;
	onProgress: (text: string) => void;
	notify: (message: string, durationMs?: number) => void;
	/** Returns true when running on mobile (used for mobile sync restrictions) */
	isMobile: () => boolean;
	/** Returns true when the backend is in the process of connecting */
	isBackendConnecting?: () => boolean;
	/** Returns true when the Obsidian workspace layout is ready (vault index loaded) */
	isLayoutReady?: () => boolean;
	localTracker: LocalChangeTracker;
	logger?: Logger;
}

const MAX_RETRIES = 3;

export class SyncOrchestrator {
	private syncMutex = new AsyncMutex();
	private stateStore: SyncStateStore;
	private syncPending = false;
	/**
	 * A cycle that ended with failures may have advanced the backend's in-memory
	 * delta cursor past work it never committed (the committed checkpoint is held
	 * back, but the live FS cursor is not re-seeded same-process). Force the next
	 * cycle cold — a full list × baseline join recovers it regardless of cursor.
	 */
	private recoverViaColdScan = false;
	private deps: SyncOrchestratorDeps;

	constructor(deps: SyncOrchestratorDeps) {
		this.deps = deps;
		const vaultId = deps.getSettings().vaultId;
		this.stateStore = new SyncStateStore(vaultId);
	}

	get state(): SyncStateStore {
		return this.stateStore;
	}

	isSyncing(): boolean {
		return this.syncMutex.isLocked;
	}

	get isLocked(): boolean {
		return this.syncMutex.isLocked;
	}

	async close(): Promise<void> {
		await this.stateStore.close();
	}

	async clearSyncState(): Promise<void> {
		this.deps.logger?.info("Clearing sync state");
		await this.stateStore.clear();
	}

	shouldSync(): boolean {
		const hasRemote = !!this.deps.remoteFs();
		const isLocked = this.syncMutex.isLocked;
		const isConnecting = this.deps.isBackendConnecting?.() ?? false;
		const isLayoutReady = this.deps.isLayoutReady?.() ?? true;
		if (!hasRemote || isLocked || isConnecting || !isLayoutReady) {
			this.deps.logger?.debug("shouldSync: skipped", { hasRemote, isLocked, isConnecting, isLayoutReady });
		}
		return hasRemote && !isLocked && !isConnecting && isLayoutReady;
	}

	isExcluded(path: string): boolean {
		const settings = this.deps.getSettings();
		// The backend's own metadata file is reserved: never sync it from either
		// side, even when `.airsync` is opted into syncDotPaths. The remote FS also
		// hides it; excluding it here keeps the exclusion symmetric (otherwise a
		// local copy would be pushed, then deleted as a phantom remote deletion).
		if (path === INTERNAL_METADATA_PATH) return true;
		// OS-generated junk (desktop.ini, thumbs.db, .DS_Store) is never synced on any
		// backend — treated as non-existent like the reserved metadata path. Beyond
		// being noise, some backends (Dropbox) reject these outright, which would
		// otherwise fail every cycle and block the delta checkpoint.
		if (isSystemJunkFile(path)) return true;
		// A path syncs only if it passes BOTH gates: the dot-path scope
		// (hidden paths are in scope only when opted into syncDotPaths) AND
		// the user's ignore patterns.
		if (isDotPathOutOfScope(path, settings.syncDotPaths)) return true;
		return isIgnored(path, settings.ignorePatterns);
	}

	/**
	 * Discard the committed remote checkpoint and run a sync, forcing one cold
	 * reconcile (full list × baseline). The reset runs UNDER syncMutex so it can't
	 * clear the live FS cache/cursor mid-cycle and corrupt an in-flight sync; the
	 * subsequent runSync then sees no checkpoint and goes cold.
	 */
	async rescan(): Promise<void> {
		await this.syncMutex.run(() => this.deps.remoteFs()?.resetCheckpoint?.());
		await this.runSync();
	}

	async runSync(): Promise<void> {
		const remoteFs = this.deps.remoteFs();
		if (!remoteFs) {
			this.deps.onStatusChange("not_connected");
			this.deps.logger?.debug("runSync: skipped — no remote backend");
			return;
		}

		if (this.deps.isBackendConnecting?.()) {
			this.deps.logger?.debug("runSync: skipped — backend connecting");
			return;
		}

		if (!(this.deps.isLayoutReady?.() ?? true)) {
			this.deps.logger?.debug("runSync: skipped — layout not ready");
			return;
		}

		if (this.syncMutex.isLocked) {
			this.syncPending = true;
			return;
		}

		await this.syncMutex.run(async () => {
			do {
				this.syncPending = false;
				this.deps.onStatusChange("syncing");

				// Force a full cold reconcile when delta-based detection can't be
				// trusted: no committed remote checkpoint (last sync never completed
				// or was reset), or the previous cycle failed (its in-memory cursor
				// may have advanced past un-committed work). Cold recovers either via
				// a full list × baseline join. The checkpoint (delta cursor) lives in
				// the backend's own store now, so this is an async FS query.
				const noCheckpoint = remoteFs.hasCheckpoint
					? !(await remoteFs.hasCheckpoint())
					: false;
				const forceFullScan = noCheckpoint || this.recoverViaColdScan;
				this.deps.logger?.info("Sync started", { forceFullScan });

				const result = await this.executeWithRetry(forceFullScan);
				if (!result) return; // Fatal error already handled

				const { succeeded, failed, conflicts } = result;
				// A failed cycle leaves the cursor possibly ahead of committed state →
				// next cycle must cold-reconcile; a clean cycle clears the flag.
				this.recoverViaColdScan = failed > 0;
				if (failed > 0) {
					this.deps.onStatusChange("partial_error");
					this.deps.logger?.warn("Sync completed with errors", { succeeded, conflicts, failed });
				} else {
					this.deps.onStatusChange("idle");
					this.deps.logger?.info("Sync completed", { succeeded, conflicts, failed });
				}

				if (this.deps.getSettings().enableLogging) {
					this.deps.notify(buildNotificationMessage(result));
				}
				await this.deps.logger?.flush();

				const allPaths = this.deps.localTracker.getDirtyPaths();
				this.deps.localTracker.acknowledge(allPaths);
			} while (this.syncPending);
		});
	}

	/**
	 * Execute sync with retry logic. Returns null on fatal error (already reported).
	 */
	private async executeWithRetry(forceFullScan: boolean): Promise<SyncCycleResult | null> {
		let lastError: unknown = null;
		let lastResult: ExecutionResult | null = null;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				lastResult = await this.executeSyncOnce(forceFullScan);
				return {
					result: lastResult,
					succeeded: lastResult.succeeded.length,
					failed: lastResult.failed.length,
					conflicts: lastResult.conflicts.length,
				};
			} catch (err) {
				lastError = err;
				const { status, retryAfter } = getErrorInfo(err);
				this.deps.logger?.error(
					`Sync error (attempt ${attempt}/${MAX_RETRIES})`,
					{ status, message: err instanceof Error ? err.message : String(err) },
				);

				if (err instanceof AuthError) {
					this.deps.onStatusChange("error");
					this.deps.notify("Authentication error. Please reconnect in settings.");
					return null;
				}
				if (status === 403 && !isRateLimitError(err)) {
					this.deps.onStatusChange("error");
					// Name the active backend via provider.displayName rather than
					// hardcoding one backend's name into this agnostic layer.
					this.deps.notify(`Permission denied. Please check your ${this.deps.backendProvider()?.displayName ?? "the remote backend"} permissions.`);
					return null;
				}
				if (status === 404) break;
				if (attempt === MAX_RETRIES) break;

				let delay: number;
				if ((status === 429 || status === 403) && retryAfter !== null) {
					delay = retryAfter * 1000;
				} else {
					const base = Math.pow(2, attempt - 1) * 1000;
					delay = base * (0.5 + Math.random());
				}
				await sleep(delay);
			}
		}

		this.deps.onStatusChange("error");
		const msg = lastError instanceof Error ? lastError.message : "Unknown error";
		this.deps.notify(`Sync error: ${msg}`);
		this.deps.logger?.error("Sync failed after retries", { message: msg });
		await this.deps.logger?.flush();
		return null;
	}

	async pullSingle(path: string): Promise<void> {
		if (this.isExcluded(path)) {
			this.deps.logger?.debug("pullSingle: skipped — out of sync scope", { path });
			return;
		}
		await this.syncMutex.run(async () => {
			const localFs = this.deps.localFs();
			const remoteFs = this.deps.remoteFs();
			if (!localFs || !remoteFs) {
				this.deps.logger?.warn("pullSingle: skipped — no local or remote fs", { path });
				return;
			}

			try {
				const remote = await remoteFs.stat(path);
				if (!remote || remote.isDirectory) {
					this.deps.logger?.warn("pullSingle: remote file not found or is a directory", { path });
					return;
				}

				const content = await remoteFs.read(path);
				const localEntity = await localFs.write(path, content, remote.mtime);
				const remoteEntity = remote;

				const record = buildSyncRecord(localEntity, remoteEntity, path);
				await this.stateStore.put(record);

				this.deps.logger?.info("pullSingle: completed", { path });
			} catch (err) {
				this.deps.logger?.error("pullSingle: failed", {
					path,
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				this.deps.localTracker.acknowledge([path]);
			}
		});
	}

	getStatus(): SyncStatus {
		return this.syncMutex.isLocked ? "syncing" : "idle";
	}

	private async executeSyncOnce(forceFullScan: boolean) {
		const localFs = this.deps.localFs();
		const remoteFs = this.deps.remoteFs();
		if (!localFs || !remoteFs) {
			throw new Error("Cannot sync: local or remote filesystem is not available");
		}
		const settings = this.deps.getSettings();

		const changeSet = await collectChanges({
			localFs,
			remoteFs,
			stateStore: this.stateStore,
			localTracker: this.deps.localTracker,
		}, { forceFullScan });

		const renamePairs = this.deps.localTracker.getRenamePairs();
		const remoteOnlyPaths = changeSet.entries.filter((e) => !e.local && e.remote).map((e) => e.path);
		this.deps.logger?.info("Change detection completed", {
			temperature: changeSet.temperature,
			entries: changeSet.entries.length,
			localOnly: changeSet.entries.filter((e) => e.local && !e.remote).length,
			remoteOnly: remoteOnlyPaths.length,
			both: changeSet.entries.filter((e) => e.local && e.remote).length,
			enriched: changeSet.entries.filter((e) => e.local?.hash && !e.prevSync).length,
			renamePairs: renamePairs.size,
		});
		if (remoteOnlyPaths.length > 0) {
			this.deps.logger?.debug("Remote-only paths", { paths: remoteOnlyPaths });
		}
		if (renamePairs.size > 0) {
			const rpPaths = new Set([...renamePairs.keys(), ...renamePairs.values()]);
			const rpEntries = changeSet.entries
				.filter((e) => rpPaths.has(e.path))
				.map((e) => ({
					path: e.path,
					local: !!e.local,
					remote: !!e.remote,
					prevSync: !!e.prevSync,
					hash: (e.local?.hash || e.prevSync?.hash || "").substring(0, 8) || undefined,
				}));
			this.deps.logger?.debug("Rename entry details", { entries: rpEntries });
		}

		const isMobile = this.deps.isMobile();
		const maxBytes = settings.mobileMaxFileSizeMB * 1024 * 1024;
		const filtered = changeSet.entries.filter((e) => {
			if (this.isExcluded(e.path)) return false;
			if (isMobile) {
				const size = Math.max(e.local?.size ?? 0, e.remote?.size ?? 0);
				if (size > maxBytes) return false;
			}
			return true;
		});

		if (filtered.length !== changeSet.entries.length) {
			this.deps.logger?.debug("Files filtered", {
				total: changeSet.entries.length,
				afterFilter: filtered.length,
				excluded: changeSet.entries.length - filtered.length,
			});
		}

		const folderRenamePairs = this.deps.localTracker.getFolderRenamePairs();
		if (folderRenamePairs.size > 0) {
			this.deps.logger?.info("Folder rename pairs detected", {
				count: folderRenamePairs.size,
				pairs: [...folderRenamePairs.entries()].map(([n, o]) => `${o} → ${n}`),
			});
		}
		const plan = refinePlan(
			planSync(filtered),
			renamePairs,
			folderRenamePairs,
			changeSet.remoteRenamePairs,
			this.deps.logger,
		);

		const actionBreakdown: Record<string, number> = {};
		for (const a of plan.actions) {
			actionBreakdown[a.action] = (actionBreakdown[a.action] ?? 0) + 1;
		}
		this.deps.logger?.info("Sync plan created", {
			total: plan.actions.length,
			...actionBreakdown,
		});

		const total = plan.actions.length;

		const ctx: ExecutionContext = {
			localFs,
			remoteFs,
			committer: {
				stateStore: this.stateStore,
				enableThreeWayMerge: settings.enableThreeWayMerge,
				localFs,
				logger: this.deps.logger,
			},
			conflictStrategy: settings.conflictStrategy,
			onProgress: (completed: number) => {
				if (total > 0) {
					this.deps.onProgress(`Syncing ${completed}/${total}...`);
				}
			},
			logger: this.deps.logger,
		};

		const result = await executePlan(plan, ctx);

		// Persist backend state. The delta cursor advances only on a fully clean
		// cycle (failed === 0): commitCheckpoint flushes the file map AND the cursor
		// to the backend store atomically, so a partial/interrupted sync keeps the
		// prior committed cursor and the next run re-detects the un-synced work.
		const provider = this.deps.backendProvider();
		const cleanCycle = result.failed.length === 0;
		if (cleanCycle && provider?.commitCheckpoint && remoteFs) {
			await provider.commitCheckpoint(remoteFs);
		}
		// readBackendState now persists only non-secret token state (the cursor lives
		// in the backend store, committed above) — safe to run every cycle.
		if (provider?.readBackendState && remoteFs) {
			settings.backendData = {
				...settings.backendData,
				...provider.readBackendState(remoteFs),
			};
		}
		await this.deps.saveSettings();

		return result;
	}
}
