import type { AirSyncSettings } from "../settings";
import type { IFileSystem } from "../fs/interface";
import type { IBackendProvider } from "../fs/backend";
import type { Logger } from "../logging/logger";
import { AsyncMutex } from "../queue/async-queue";
import { isIgnored, isSystemJunkFile } from "../utils/ignore";
import { isDotPathOutOfScope } from "../utils/path";
import { getEffectiveIgnorePatterns, getEffectiveSyncDotPaths, isOwnPluginDataPath } from "../config-sync";
import { INTERNAL_METADATA_PATH } from "../fs/remote-vault-contract";
import { SyncStateStore } from "./state";
import { LocalChangeTracker, type TrackerSnapshot } from "./local-tracker";
import { collectChanges, type ChangeSet } from "./change-detector";
import { computeScopeFingerprint } from "./scope-fingerprint";
import { executePlan, toConflictRecords, DESKTOP_TRANSFER_POOL, MOBILE_TRANSFER_POOL } from "./plan-executor";
import type { ExecutionContext, ExecutionResult } from "./plan-executor";
import { classifyHttpError } from "../fs/errors";
import type { ErrorClassification } from "../fs/errors";
import { decideRetry, sleep } from "./error";
import type { ConflictRecord, IdentityEvidence, SyncStatus } from "./types";
import { CycleSummary } from "./sync-notification";
import type { SyncCycleResult } from "./sync-notification";
import { FailedActionTracker } from "./failed-action-tracker";
import { mergeIdentityEvidence, renameDebtEvidence, serializeLocalRenameDebts } from "./rename-debt";
import {
	logChangeDetection,
	logSyncCyclePlan,
	prepareSyncCycleSnapshot,
} from "./sync-cycle-planning";
import { finalizeSyncCycle } from "./sync-cycle-finalization";
import { admitDestructivePlan } from "./plan-admission";
import { PriorityCoordinator } from "./priority-coordinator";
import { LocalMutationBarrier } from "./local-mutation-barrier";
import { PriorityBatchState } from "./priority-batch-state";
import { syncOpenedFilePriority } from "./opened-file-priority";

export type { SyncStatus };

export interface SyncOrchestratorDeps {
	getSettings: () => AirSyncSettings;
	saveSettings: () => Promise<void>;
	/** The vault's configured config directory (`Vault#configDir`), for config sync. */
	configDir: () => string;
	/** This plugin's manifest id (`Plugin#manifest.id`), for config sync. */
	pluginId: () => string;
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

class PreAdmissionRecoveryError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "PreAdmissionRecoveryError";
	}
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
	/** Reported edges retained until a clean checkpoint; remote edges are not durable debt. */
	private pendingAdmissionEvidence: IdentityEvidence[] = [];
	private failedActionTracker = new FailedActionTracker();
	private readonly priorityCoordinator = new PriorityCoordinator();
	private readonly localMutationBarrier = new LocalMutationBarrier();
	private activeBatch: PriorityBatchState | null = null;
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
		// Serialize target teardown with execution. Otherwise an old-target cycle can
		// recreate debt after disconnect/switch has cleared its namespace.
		await this.syncMutex.run(async () => {
			this.deps.logger?.info("Clearing sync state");
			await this.stateStore.clear();
			this.pendingAdmissionEvidence = [];
			this.recoverViaColdScan = false;
			this.syncPending = false;
		});
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
		const configDir = this.deps.configDir();
		// This plugin's own data.json (backend credentials/vaultId) is reserved
		// the same way, regardless of enableConfigSync — a user can put configDir
		// into syncDotPaths by hand without the toggle, and this must still hold
		// so a user's own ignorePatterns entry can never override it and leak
		// credentials across devices (see isOwnPluginDataPath's doc comment).
		if (isOwnPluginDataPath(path, configDir, this.deps.pluginId())) return true;
		// A path syncs only if it passes BOTH gates: the dot-path scope
		// (hidden paths are in scope only when opted into syncDotPaths) AND
		// the user's ignore patterns.
		if (isDotPathOutOfScope(path, getEffectiveSyncDotPaths(settings, configDir))) return true;
		return isIgnored(path, getEffectiveIgnorePatterns(settings, configDir, this.deps.pluginId()));
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
				// or was reset), the previous cycle failed (its in-memory cursor
				// may have advanced past un-committed work), or the sync SCOPE
				// changed since the last clean cycle (a settings change widened
				// scope to include remote paths the delta cursor already passed —
				// see scope-fingerprint.ts). Cold recovers all three via a full
				// list × baseline join. The checkpoint (delta cursor + fingerprint)
				// lives in the backend's own store now, so this is an async FS query.
				const noCheckpoint = remoteFs.checkpoint
					? !(await remoteFs.checkpoint.hasCheckpoint())
					: false;
				const scopeFingerprint = await computeScopeFingerprint(
					this.deps.getSettings(),
					this.deps.configDir(),
					this.deps.pluginId(),
				);
				// A checkpoint capability without getScopeFingerprint doesn't track
				// scope at all — skip the check rather than force a spurious cold
				// reconcile every cycle. When it IS present, a committed `null`
				// (checkpoint predates this field, or was never committed) compares
				// unequal to any real fingerprint — this doubles as the one-time
				// back-fill cold reconcile for existing checkpoints.
				const scopeChanged = remoteFs.checkpoint?.getScopeFingerprint
					? (await remoteFs.checkpoint.getScopeFingerprint()) !== scopeFingerprint
					: false;
				const forceFullScan = noCheckpoint || this.recoverViaColdScan || scopeChanged;
				this.deps.logger?.info("Sync started", { forceFullScan, scopeChanged });

				const result = await this.executeWithRetry(forceFullScan, snapshot, scopeFingerprint);
				if (!result) return; // Fatal error already handled

				const { succeeded, failed, blocked, conflicts, deferred } = result;
				// failed cycle では cursor が committed state より先に進んでいる可能性がある。
				// ただし cold recovery を一度支払い済みの local-origin action だけが
				// quarantine 対象なら、次 cycle の cold scan は不要。
				this.recoverViaColdScan = this.needsColdRecovery(result.result);
				if (failed > 0 || blocked > 0 || deferred > 0) {
					this.deps.onStatusChange("partial_error");
					this.deps.logger?.warn("Sync completed with errors", {
						succeeded, conflicts, failed, blocked, deferred,
					});
				} else {
					this.deps.onStatusChange("idle");
					this.deps.logger?.info("Sync completed", {
						succeeded, conflicts, failed, blocked, deferred,
					});
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
	private async executeWithRetry(
		forceFullScan: boolean,
		snapshot: TrackerSnapshot,
		scopeFingerprint: string,
	): Promise<SyncCycleResult | null> {
		let lastError: unknown = null;
		let lastResult: ExecutionResult | null = null;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				lastResult = await this.executeSyncOnce(forceFullScan, snapshot, scopeFingerprint);
				return {
					result: lastResult,
					succeeded: lastResult.succeeded.length + lastResult.superseded.length,
					failed: lastResult.failed.length,
					blocked: lastResult.blocked.length,
					conflicts: lastResult.conflicts.length,
					deferred: lastResult.deferred.length,
				};
			} catch (err) {
				lastError = err;
				if (err instanceof PreAdmissionRecoveryError) {
					this.deps.logger?.error("Sync error before Admission; COLD recovery requested", {
						message: err.message,
					});
					break;
				}
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
		await this.priorityCoordinator.enqueue(path, async () => {
			const localFs = this.deps.localFs();
			const remoteFs = this.deps.remoteFs();
			if (!localFs || !remoteFs) {
				this.deps.logger?.warn("pullSingle: skipped — no local or remote fs", { path });
				return;
			}
			const activeBatch = this.activeBatch;
			const target = activeBatch
				? activeBatch.priorityTarget(path)
				: this.syncMutex.isLocked ? { kind: "defer" as const } : { kind: "independent" as const };
			const outcome = await syncOpenedFilePriority({
				path, localFs, remoteFs, stateStore: this.stateStore,
				localTracker: this.deps.localTracker,
				mutationBarrier: this.localMutationBarrier,
				target,
				supersede: (action) => activeBatch?.supersede(action) ?? false,
				invalidate: (action) => activeBatch?.invalidate(action) ?? false,
				invalidateCycle: () => activeBatch?.blockCheckpoint(),
				requestNormalLifecycle: () => this.requestNormalLifecycle(),
				logger: this.deps.logger,
			});
			this.deps.logger?.info("file-open priority completed", { path, outcome });
		});
	}

	private requestNormalLifecycle(): void {
		if (this.syncMutex.isLocked) {
			this.syncPending = true;
			return;
		}
		void this.runSync();
	}

	getStatus(): SyncStatus {
		return this.syncMutex.isLocked ? "syncing" : "idle";
	}

	private async executeSyncOnce(forceFullScan: boolean, snapshot: TrackerSnapshot, scopeFingerprint: string) {
		const localFs = this.deps.localFs();
		const remoteFs = this.deps.remoteFs();
		if (!localFs || !remoteFs) {
			throw new Error("Cannot sync: local or remote filesystem is not available");
		}
		const preparationPermit = await this.priorityCoordinator.acquireNormalPermit();
		const prepared = await (async () => {
		try {
		const settings = this.deps.getSettings();
		const provider = this.deps.backendProvider();
		const debtNamespace = (provider?.getIdentity?.(settings) ?? settings.lastSyncedIdentity) ||
			`${settings.backendType}:${settings.vaultId}`;
		const persistedDebts = await this.stateStore.getRenameDebts(debtNamespace);
		const carriedEvidence = mergeIdentityEvidence(
			this.pendingAdmissionEvidence,
			persistedDebts.map(renameDebtEvidence),
		);

		let changeSet: ChangeSet;
		let planning: ReturnType<typeof prepareSyncCycleSnapshot>;
		let capturedRemoteEvidence = false;
		const hadPendingEvidence = this.pendingAdmissionEvidence.length > 0;
		try {
			changeSet = await collectChanges({
				localFs,
				remoteFs,
				stateStore: this.stateStore,
				changes: snapshot,
				onRemoteIdentityEvidence: (evidence) => {
					const remoteRenames = evidence.filter((item) => item.kind === "rename");
					capturedRemoteEvidence ||= remoteRenames.length > 0;
					this.pendingAdmissionEvidence = mergeIdentityEvidence(
						this.pendingAdmissionEvidence,
						remoteRenames,
					);
				},
			}, {
				forceFullScan: forceFullScan || persistedDebts.length > 0,
				carriedIdentityEvidence: carriedEvidence,
			});
			const { renamePairs } = snapshot;
			logChangeDetection(changeSet, renamePairs, this.deps.logger);

			const isMobile = this.deps.isMobile();
			const maxBytes = settings.mobileMaxFileSizeMB * 1024 * 1024;
			planning = prepareSyncCycleSnapshot(changeSet, persistedDebts, debtNamespace, {
				classifyPath: (path) => this.isExcluded(path) ? "policy_out" : "included",
				mobileMaxBytes: isMobile ? maxBytes : undefined,
			}, this.deps.logger);
			this.pendingAdmissionEvidence = mergeIdentityEvidence(
				this.pendingAdmissionEvidence,
				changeSet.identityEvidence.filter((item) => item.kind === "rename"),
			);
		} catch (err) {
			if (capturedRemoteEvidence || hadPendingEvidence) {
				this.recoverViaColdScan = true;
				throw new PreAdmissionRecoveryError(err);
			}
			throw err;
		}

		// This call is the authorization cut point. Exceptions from this line onward
		// are not reclassified as evidence-acquisition recovery.
		const admission = admitDestructivePlan(planning.snapshot);
		logSyncCyclePlan(this.deps.logger, admission);
		const localRenameDebts = serializeLocalRenameDebts(debtNamespace,
			admission.localRenameLifecycle.persistBeforeExecution, admission.snapshot.scope);
		const { folderRenamePairs } = snapshot;

		if (folderRenamePairs.size > 0) {
			this.deps.logger?.info("Folder rename pairs detected", {
				count: folderRenamePairs.size,
				pairs: [...folderRenamePairs.entries()].map(([n, o]) => `${o} → ${n}`),
			});
		}
		// Persist Admission-selected constraints before execution so tracker evidence cannot be lost.
		await this.stateStore.upsertRenameDebts(localRenameDebts).catch((cause: unknown) => {
			throw new Error("Local rename constraint persistence failed", { cause });
		});
		this.activeBatch = new PriorityBatchState(admission);
		return { settings, provider, admission, persistedDebts, localRenameDebts };
		} finally {
			preparationPermit.release();
		}
		})();
		const { settings, provider, admission, persistedDebts, localRenameDebts } = prepared;
		const total = admission.executable.actions.length;

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
			acquireActionPermit: () => this.priorityCoordinator.acquireNormalPermit(),
			beginAction: (action) => this.activeBatch?.beginAction(action) ?? "invalidated",
			onActionBlocked: (action) => this.activeBatch?.removeBlocked(action),
			onActionFatal: () => this.activeBatch?.abort(),
			mutationBarrier: this.localMutationBarrier,
			onPhaseChange: (phase) => this.activeBatch?.setPhase(phase),
		};

		try {
			const execution = await executePlan(admission.executable, ctx);
			const result: ExecutionResult = { ...execution, deferred: admission.deferred };
			this.updateFailedActionTracker(settings.backendType, result, classifyError);

			await this.priorityCoordinator.finalize(async () => {
				this.activeBatch?.setPhase("finalizing");
				this.pendingAdmissionEvidence = await finalizeSyncCycle({
					admission,
					result, pendingEvidence: this.pendingAdmissionEvidence, persistedDebts,
					localRenameDebts,
					checkpoint: remoteFs.checkpoint, scopeFingerprint, stateStore: this.stateStore,
					checkpointBlocked: this.activeBatch?.isCheckpointBlocked,
				});
				if (provider?.readBackendState) {
					settings.backendData = {
						...settings.backendData,
						...provider.readBackendState(),
					};
				}
				await this.deps.saveSettings();
			});
			return result;
		} finally {
			this.activeBatch = null;
		}
	}

	private updateFailedActionTracker(
		backendType: string,
		result: ExecutionResult,
		classifyError: (err: unknown) => ErrorClassification,
	): void {
		for (const succeeded of result.succeeded) {
			this.failedActionTracker.recordSuccess(backendType, succeeded.action);
		}
		for (const action of result.superseded) {
			this.failedActionTracker.recordSuccess(backendType, action);
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
		return result.deferred.length > 0 || result.failed.some((failed) =>
			!this.failedActionTracker.isBlockingFailure(
				settings.backendType,
				failed,
				classifyError(failed.error),
			)
		);
	}
}
