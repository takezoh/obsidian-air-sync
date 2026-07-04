import type { AirSyncSettings } from "../settings";
import type { IFileSystem } from "../fs/interface";
import type { IBackendProvider } from "../fs/backend";
import type { Logger } from "../logging/logger";
import { AsyncMutex } from "../queue/async-queue";
import { isIgnored, isSystemJunkFile } from "../utils/ignore";
import { isDotPathOutOfScope } from "../utils/path";
import { INTERNAL_METADATA_PATH } from "../fs/remote-vault-contract";
import { SyncStateStore } from "./state";
import { LocalChangeTracker, type TrackerSnapshot } from "./local-tracker";
import { collectChanges } from "./change-detector";
import { planSync } from "./decision-engine";
import { refinePlan } from "./rename-optimizer";
import { executePlan, toConflictRecords, DESKTOP_TRANSFER_POOL, MOBILE_TRANSFER_POOL } from "./plan-executor";
import type { ExecutionContext, ExecutionResult, FailedAction } from "./plan-executor";
import { classifyHttpError } from "../fs/errors";
import type { ErrorClassification } from "../fs/errors";
import { decideRetry, sleep } from "./error";
import type { ConflictRecord, SyncAction, SyncActionType, SyncStatus } from "./types";
import { buildSyncRecord } from "./state-committer";
import { CycleSummary } from "./sync-notification";
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
	/** Persist a cycle's resolved conflicts to the audit history (once per cycle). */
	recordConflicts?: (records: ConflictRecord[]) => Promise<void>;
}

const MAX_RETRIES = 3;
// 2 回目の同一 permanent failure で初めて block する。これにより、失敗後の
// cold recovery を 1 回は必ず支払い、3 cycle 目から poison action だけを抑制する。
const FAILED_ACTION_BLOCK_THRESHOLD = 2;
// mobile で同じ poison action を短時間に回し続けないための短い冷却時間。
// 永続化しないので plugin reload / Obsidian restart では解除される。
const FAILED_ACTION_BLOCK_TTL_MS = 5 * 60 * 1000;
const BLOCKABLE_LOCAL_ORIGIN_ACTIONS = new Set<SyncActionType>(["push", "delete_remote", "rename_remote"]);

interface FailedActionEntry {
	key: string;
	actionFingerprint: string;
	consecutiveFailures: number;
	blockedUntil: number;
}

class FailedActionTracker {
	private readonly entries = new Map<string, FailedActionEntry>();

	isBlocked(backendType: string, action: SyncAction, now = Date.now()): string | null {
		if (!isBlockableLocalOriginAction(action)) return null;
		this.expire(now);
		const prefix = this.actionPrefix(backendType, action);
		const fingerprint = actionFingerprint(action);
		for (const entry of this.entries.values()) {
			if (!entry.key.startsWith(prefix)) continue;
			if (entry.actionFingerprint !== fingerprint) {
				this.entries.delete(entry.key);
				continue;
			}
			if (entry.blockedUntil > now) {
				return `blocked after ${entry.consecutiveFailures} repeated failures; retry after ${new Date(entry.blockedUntil).toISOString()}`;
			}
		}
		return null;
	}

	recordSuccess(backendType: string, action: SyncAction): void {
		this.clearAction(backendType, action);
	}

	recordFailure(
		backendType: string,
		failed: FailedAction,
		classification: ErrorClassification,
		now = Date.now(),
	): void {
		if (!isBlockableLocalOriginAction(failed.action)) return;
		this.expire(now);
		const failureCode = quarantineFailureCode(classification);
		if (!failureCode) {
			this.clearAction(backendType, failed.action);
			return;
		}
		const key = this.key(backendType, failed.action, failureCode);
		const fingerprint = actionFingerprint(failed.action);
		const existing = this.entries.get(key);
		const consecutiveFailures = existing?.actionFingerprint === fingerprint
			? existing.consecutiveFailures + 1
			: 1;
		this.clearAction(backendType, failed.action);
		this.entries.set(key, {
			key,
			actionFingerprint: fingerprint,
			consecutiveFailures,
			blockedUntil: consecutiveFailures >= FAILED_ACTION_BLOCK_THRESHOLD
				? now + FAILED_ACTION_BLOCK_TTL_MS
				: 0,
		});
	}

	isBlockingFailure(
		backendType: string,
		failed: FailedAction,
		classification: ErrorClassification,
		now = Date.now(),
	): boolean {
		if (!isBlockableLocalOriginAction(failed.action)) return false;
		const failureCode = quarantineFailureCode(classification);
		if (!failureCode) return false;
		const entry = this.entries.get(this.key(backendType, failed.action, failureCode));
		return !!entry && entry.actionFingerprint === actionFingerprint(failed.action) && entry.blockedUntil > now;
	}

	private expire(now: number): void {
		for (const [key, entry] of this.entries) {
			if (entry.blockedUntil > 0 && entry.blockedUntil <= now) this.entries.delete(key);
		}
	}

	private actionPrefix(backendType: string, action: SyncAction): string {
		return `${backendType}\u0000${action.action}\u0000${action.path}\u0000`;
	}

	private clearAction(backendType: string, action: SyncAction): void {
		const prefix = this.actionPrefix(backendType, action);
		for (const key of [...this.entries.keys()]) {
			if (key.startsWith(prefix)) this.entries.delete(key);
		}
	}

	private key(backendType: string, action: SyncAction, failureCode: string): string {
		return `${this.actionPrefix(backendType, action)}permanent\u0000${failureCode}`;
	}
}

function isBlockableLocalOriginAction(action: SyncAction): boolean {
	return BLOCKABLE_LOCAL_ORIGIN_ACTIONS.has(action.action);
}

function quarantineFailureCode(classification: ErrorClassification): string | null {
	return classification.kind === "permanent" && classification.permanentCode
		? classification.permanentCode
		: null;
}

function actionFingerprint(action: SyncAction): string {
	return JSON.stringify({
		action: action.action,
		path: action.path,
		oldPath: "oldPath" in action ? action.oldPath : undefined,
		local: entityFingerprint(action.local),
		remote: entityFingerprint(action.remote),
		baseline: action.baseline
			? {
				hash: action.baseline.hash,
				localMtime: action.baseline.localMtime,
				remoteMtime: action.baseline.remoteMtime,
				localSize: action.baseline.localSize,
				remoteSize: action.baseline.remoteSize,
			}
			: undefined,
	});
}

function entityFingerprint(entity: SyncAction["local"]): unknown {
	if (!entity) return undefined;
	return {
		isDirectory: entity.isDirectory,
		size: entity.size,
		mtime: entity.mtime,
		hash: entity.hash,
	};
}

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
	private failedActionTracker = new FailedActionTracker();
	/** Stable id grouping this plugin session's conflict-history records. */
	private readonly sessionId = crypto.randomUUID();
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
		await this.syncMutex.run(() => this.deps.remoteFs()?.checkpoint?.resetCheckpoint());
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

		// A runSync arriving while locked is a debounce-fired VAULT change (or a
		// rescan): set syncPending so the do/while runs another cycle and the
		// snapshot-surviving dirty path is consumed on HOT. SIGNAL triggers never
		// reach here — triggerSync's isSyncing() guard already dropped them. Do not
		// recast syncPending as "dirty exists": markDirty does not set it, so a
		// dirty-count loop would bypass the 5s debounce and tight-loop during
		// continuous editing (ADR 0004).
		if (this.syncMutex.isLocked) {
			this.syncPending = true;
			return;
		}

		await this.syncMutex.run(async () => {
			// Coalesce every cycle in this burst into ONE end-of-run notice (see
			// CycleSummary): a mobile resume firing focus + visibilitychange
			// back-to-back must not show "Everything up to date" twice.
			const summary = new CycleSummary();
			do {
				this.syncPending = false;
				this.deps.onStatusChange("syncing");

				// One snapshot per cycle, captured above the retry loop, drives both
				// detection and the acknowledge (see TrackerSnapshot for why).
				const snapshot = this.deps.localTracker.snapshot();

				// Force a full cold reconcile when delta-based detection can't be
				// trusted: no committed remote checkpoint (last sync never completed
				// or was reset), or the previous cycle failed (its in-memory cursor
				// may have advanced past un-committed work). Cold recovers either via
				// a full list × baseline join. The checkpoint (delta cursor) lives in
				// the backend's own store now, so this is an async FS query.
				const noCheckpoint = remoteFs.checkpoint
					? !(await remoteFs.checkpoint.hasCheckpoint())
					: false;
				const forceFullScan = noCheckpoint || this.recoverViaColdScan;
				this.deps.logger?.info("Sync started", { forceFullScan });

				const result = await this.executeWithRetry(forceFullScan, snapshot);
				if (!result) return; // Fatal error already handled

				const { succeeded, failed, blocked, conflicts } = result;
				// failed cycle では cursor が committed state より先に進んでいる可能性がある。
				// ただし cold recovery を一度支払い済みの local-origin action だけが
				// quarantine 対象なら、次 cycle の cold scan は不要。
				this.recoverViaColdScan = this.needsColdRecovery(result.result);
				if (failed > 0 || blocked > 0) {
					this.deps.onStatusChange("partial_error");
					this.deps.logger?.warn("Sync completed with errors", { succeeded, conflicts, failed, blocked });
				} else {
					this.deps.onStatusChange("idle");
					this.deps.logger?.info("Sync completed", { succeeded, conflicts, failed, blocked });
				}

				summary.add(result.result);

				// Record this cycle's resolved conflicts to the audit history — once per
				// cycle, and only when there were any. Writing stays separate from
				// resolution: the resolver produced the outcomes, this just persists them.
				// Best-effort: the audit write is supplementary, so a failure here must not
				// turn an otherwise-clean cycle into a reported error nor skip the dirty-path
				// acknowledgment below — log it and carry on.
				const conflictRecords = result.result.conflicts;
				if (conflictRecords.length > 0) {
					await this.deps.recordConflicts?.(toConflictRecords(conflictRecords,
						this.deps.getSettings().conflictStrategy, this.sessionId, new Date().toISOString()))
						?.catch((err) => this.deps.logger?.warn("Failed to record conflict history", { message: err instanceof Error ? err.message : String(err) }));
				}
				await this.deps.logger?.flush();

				this.deps.localTracker.acknowledge(snapshot);
			} while (this.syncPending);

			// One notice per burst, gated on its OWN setting (`enableLogging` controls
			// only whether logs are written — it used to double as this gate).
			if (this.deps.getSettings().showSyncNotifications) {
				this.deps.notify(summary.message);
			}
		});
	}

	/**
	 * Execute sync with retry logic. Returns null on fatal error (already reported).
	 */
	private async executeWithRetry(forceFullScan: boolean, snapshot: TrackerSnapshot): Promise<SyncCycleResult | null> {
		let lastError: unknown = null;
		let lastResult: ExecutionResult | null = null;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				lastResult = await this.executeSyncOnce(forceFullScan, snapshot);
				return {
					result: lastResult,
					succeeded: lastResult.succeeded.length,
					failed: lastResult.failed.length,
					blocked: lastResult.blocked.length,
					conflicts: lastResult.conflicts.length,
				};
			} catch (err) {
				lastError = err;
				// Classification is the backend's job (it knows its own error shapes,
				// e.g. that Google 403 can mean rate-limit); the retry POLICY is the
				// engine's and stays backend-neutral. Fall back to the generic HTTP
				// classifier for backends that don't override it.
				const provider = this.deps.backendProvider();
				const classification = provider?.classifyError?.(err) ?? classifyHttpError(err);
				this.deps.logger?.error(
					`Sync error (attempt ${attempt}/${MAX_RETRIES})`,
					{ kind: classification.kind, message: err instanceof Error ? err.message : String(err) },
				);

				const decision = decideRetry(classification, attempt, MAX_RETRIES, Math.random);
				if (decision.action === "abort") {
					this.deps.onStatusChange("error");
					this.deps.notify(decision.kind === "auth"
						? "Authentication error. Please reconnect in settings."
						: `Permission denied. Please check your ${provider?.displayName ?? "remote backend"} permissions.`);
					return null;
				}
				// "stop" (e.g. 404) and "exhausted" both fall through to the generic
				// failure handler below; only "retry" waits and loops.
				if (decision.action !== "retry") break;
				await sleep(decision.delayMs);
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
				this.deps.localTracker.acknowledgePath(path);
			}
		});
	}

	getStatus(): SyncStatus {
		return this.syncMutex.isLocked ? "syncing" : "idle";
	}

	private async executeSyncOnce(forceFullScan: boolean, snapshot: TrackerSnapshot) {
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
			changes: snapshot,
		}, { forceFullScan });

		const { renamePairs, folderRenamePairs } = snapshot;
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

		const provider = this.deps.backendProvider();
		const classifyError = (err: unknown) => provider?.classifyError?.(err) ?? classifyHttpError(err);
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
				if (total > 0) this.deps.onProgress(`Syncing ${completed}/${total}...`);
			},
			logger: this.deps.logger,
			classifyError,
			isActionBlocked: (action) => this.failedActionTracker.isBlocked(settings.backendType, action),
			transferPool: this.deps.isMobile() ? MOBILE_TRANSFER_POOL : DESKTOP_TRANSFER_POOL,
		};

		const result = await executePlan(plan, ctx);
		this.updateFailedActionTracker(settings.backendType, result, classifyError);

		// Persist backend state. commitCheckpoint advances the delta cursor (+ file map,
		// atomically) only on a fully clean cycle; a partial sync keeps the prior cursor.
		const cleanCycle = result.failed.length === 0;
		// The checkpoint lives on the FS now (no provider downcast): flush it only on a
		// fully clean cycle so a partial sync keeps the prior committed cursor.
		if (cleanCycle && remoteFs?.checkpoint) {
			await remoteFs.checkpoint.commitCheckpoint();
		}
		// readBackendState now persists only non-secret token state (the cursor lives
		// in the backend store, committed above) — safe to run every cycle.
		if (provider?.readBackendState) {
			settings.backendData = {
				...settings.backendData,
				...provider.readBackendState(),
			};
		}
		await this.deps.saveSettings();

		return result;
	}

	private updateFailedActionTracker(
		backendType: string,
		result: ExecutionResult,
		classifyError: (err: unknown) => ErrorClassification,
	): void {
		for (const succeeded of result.succeeded) {
			this.failedActionTracker.recordSuccess(backendType, succeeded.action);
		}
		for (const failed of result.failed) {
			this.failedActionTracker.recordFailure(
				backendType,
				failed,
				classifyError(failed.error),
			);
		}
	}

	private needsColdRecovery(result: ExecutionResult): boolean {
		const settings = this.deps.getSettings();
		const provider = this.deps.backendProvider();
		const classifyError = (err: unknown) => provider?.classifyError?.(err) ?? classifyHttpError(err);
		return result.failed.some((failed) =>
			!this.failedActionTracker.isBlockingFailure(
				settings.backendType,
				failed,
				classifyError(failed.error),
			)
		);
	}
}
