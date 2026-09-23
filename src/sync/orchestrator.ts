import type { AirSyncSettings } from "../settings";
import type { IFileSystem } from "../fs/interface";
import type { ChecksumRegistry } from "../fs/modules/checksum-registry";
import type { IBackendProvider } from "../fs/backend";
import type { Logger } from "../logging/logger";
import { AsyncMutex } from "../backend-api/async-queue";
import { captureScopePolicy, isExcludedFromScope } from "./scope-projection";
import { SyncStateStore } from "./state";
import { LocalChangeTracker, type TrackerSnapshot } from "./local-tracker";
import { collectChanges, type ChangeSet } from "./change-detector";
import { computeScopeFingerprint } from "./scope-fingerprint";
import { executePlan, toConflictRecords, DESKTOP_TRANSFER_POOL, MOBILE_TRANSFER_POOL } from "./plan-executor";
import type { ExecutionContext } from "./plan-executor";
import type { ExecutionResult } from "./execution-result";
import { classifyHttpError, errorMessage, toError } from "../backend-api/error-classification";
import { decideRetry, sleep } from "./error";
import type { ConflictRecord, ConflictStrategy, SyncStatus } from "./types";
import {
	CycleSummary,
	type SyncCycleOutcome,
	type SyncCycleResult,
} from "./sync-notification";
import { logChangeDetection } from "./sync-cycle-diagnostics";
import {
	captureBatchObservation,
	logSyncCyclePlan,
	prepareSyncCycleSnapshotForExecution,
} from "./sync-cycle-planning";
import { runSyncCycleAttempt, WorkingViewAbortError } from "./sync-cycle-finalization";
import { admitBatchObservation } from "./plan-admission";
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
	/** The single checksum resolver shared by change detection, planning, and execution. */
	checksumRegistry: ChecksumRegistry;
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

export class SyncOrchestrator {
	private syncMutex = new AsyncMutex();
	private stateStore: SyncStateStore;
	private syncPending = false;
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
		// Serialize target teardown with execution.
		await this.syncMutex.run(async () => {
			this.deps.logger?.info("Clearing sync state");
			await this.stateStore.clear();
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
		return isExcludedFromScope(path, captureScopePolicy(
			this.deps.getSettings(), this.deps.configDir(), this.deps.pluginId(),
		));
	}

	/**
	 * The keeper decision handed to the remote filesystem's namespace reconciliation:
	 * the claimant holding a committed SyncRecord at the contended address, or
	 * undefined to leave the choice to the arbiter. Read per call from the record
	 * store; the filesystem stores nothing.
	 */
	private async namespaceKeeper(path: string, claimantIds: readonly string[]): Promise<string | undefined> {
		const record = await this.stateStore.get(path);
		return record && claimantIds.includes(record.remoteIdentityKey)
			? record.remoteIdentityKey : undefined;
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
				const settings = this.deps.getSettings();
				const conflictStrategy = settings.conflictStrategy;

				const scopeFingerprint = await computeScopeFingerprint(
					settings,
					this.deps.configDir(),
					this.deps.pluginId(),
				);
				const noCheckpoint = remoteFs.checkpoint
					? !(await remoteFs.checkpoint.hasCheckpoint())
					: false;
				const scopeChanged = remoteFs.checkpoint?.getScopeFingerprint
					? (await remoteFs.checkpoint.getScopeFingerprint()) !== scopeFingerprint
					: false;
				const forceFullScan = noCheckpoint || scopeChanged;
				const result = await this.executeWithRetry(
					forceFullScan, scopeChanged, snapshot, scopeFingerprint, conflictStrategy,
				);
				if (!result) return; // Fatal error already handled

				const { succeeded, failed, blocked, conflicts } = result;
				if (result.outcome.completion.kind === "follow_up") {
					// Nothing failed; convergence needs one more cycle. Queue it the way any
					// sync request is queued — one slot, consumed by this loop — and leave the
					// status at syncing, because that cycle starts next.
					this.requestNormalLifecycle();
					this.deps.logger?.info("Sync cycle queued a follow-up", {
						succeeded, conflicts, failed, blocked,
					});
				} else if (result.outcome.completion.kind === "incomplete") {
					this.deps.onStatusChange("partial_error");
					this.deps.logger?.warn("Sync completed with errors", {
						succeeded, conflicts, failed, blocked,
					});
				} else {
					this.deps.onStatusChange("idle");
					this.deps.logger?.info("Sync completed", {
						succeeded, conflicts, failed, blocked,
					});
				}

				summary.add(result.outcome);

				// Record this cycle's resolved conflicts to the audit history — once per
				// cycle, and only when there were any. Writing stays separate from
				// resolution: the resolver produced the outcomes, this just persists them.
				// Best-effort: the audit write is supplementary, so a failure here must not
				// turn an otherwise-clean cycle into a reported error nor skip the dirty-path
				// acknowledgment below — log it and carry on.
				const conflictRecords = result.outcome.execution.conflicts;
				if (conflictRecords.length > 0) {
					await this.deps.recordConflicts?.(toConflictRecords(conflictRecords,
						this.sessionId, new Date().toISOString()))
						?.catch((err) => this.deps.logger?.warn("Failed to record conflict history", { message: err instanceof Error ? err.message : String(err) }));
				}
				await this.deps.logger?.flush();

				// Checkpoint and tracker inputs have separate closeout rules. A clean
				// cycle consumes every captured producer input. A terminal partial cycle
				// abandons captured relation reports so stale rename claims cannot replay,
				// but retains dirty paths so failed same-metadata content writes stay HOT.
				if (result.outcome.completion.kind === "clean") {
					this.deps.localTracker.acknowledge(snapshot);
				} else {
					this.deps.localTracker.acknowledgeRelations(snapshot);
				}
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
		scopeChanged: boolean,
		snapshot: TrackerSnapshot,
		scopeFingerprint: string,
		conflictStrategy: ConflictStrategy,
	): Promise<SyncCycleResult | null> {
		let lastError: unknown = null;
		let lastOutcome: SyncCycleOutcome | null = null;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				this.deps.logger?.info("Sync started", { forceFullScan, scopeChanged, attempt });
				lastOutcome = await this.executeSyncOnce(
					forceFullScan, snapshot, scopeFingerprint, conflictStrategy,
				);
				const { execution, admissionFailures } = lastOutcome;
				return {
					outcome: lastOutcome,
					succeeded: execution.succeeded.length + execution.superseded.length,
					failed: execution.failed.length + admissionFailures.length,
					blocked: execution.blocked.length,
					conflicts: execution.conflicts.length,
				};
			} catch (err) {
				if (err instanceof WorkingViewAbortError) throw toError(err.original);
				// Normalize once so classification, logging, the retained last error,
				// and the final notice all carry the safe diagnostic message even when
				// a module threw a plain BackendErrorShape object.
				const original = toError(err);
				lastError = original;
				// Classification is the backend's job (it knows its own error shapes,
				// e.g. that Google 403 can mean rate-limit); the retry POLICY is the
				// engine's and stays backend-neutral. Fall back to the generic HTTP
				// classifier for backends that don't override it.
				const provider = this.deps.backendProvider();
				const classification = provider?.classifyError?.(original) ?? classifyHttpError(original);
				this.deps.logger?.error(
					`Sync error (attempt ${attempt}/${MAX_RETRIES})`,
					{ kind: classification.kind, message: original.message },
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
		const msg = lastError === null ? "Unknown error" : errorMessage(lastError);
		this.deps.notify(`Sync error: ${msg}`);
		this.deps.logger?.error("Sync failed after retries", { message: msg });
		await this.deps.logger?.flush();
		return null;
	}

	async pullSingle(path: string): Promise<"untracked" | undefined> {
		if (this.isExcluded(path)) {
			this.deps.logger?.debug("pullSingle: skipped — out of sync scope", { path });
			return;
		}
		return this.priorityCoordinator.enqueue(path, async () => {
			const localFs = this.deps.localFs();
			const remoteFs = this.deps.remoteFs();
			if (!localFs || !remoteFs) {
				this.deps.logger?.warn("pullSingle: skipped — no local or remote fs", { path });
				return undefined;
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
				supersede: (action, record) => activeBatch?.supersede(action, record) ?? false,
				invalidate: (action) => activeBatch?.invalidate(action) ?? false,
				invalidateCycle: () => activeBatch?.blockCheckpoint(),
				requestNormalLifecycle: () => this.requestNormalLifecycle(),
				logger: this.deps.logger,
			});
			this.deps.logger?.info("file-open priority completed", { path, outcome });
			return outcome === "untracked" ? outcome : undefined;
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

	private async executeSyncOnce(
		forceFullScan: boolean,
		snapshot: TrackerSnapshot,
		scopeFingerprint: string,
		conflictStrategy: ConflictStrategy,
	) {
		const localFs = this.deps.localFs();
		const remoteFs = this.deps.remoteFs();
		if (!localFs || !remoteFs) {
			throw new Error("Cannot sync: local or remote filesystem is not available");
		}
		try {
			const closed = await runSyncCycleAttempt(remoteFs.checkpoint, async () => {
		const preparationPermit = await this.priorityCoordinator.acquireNormalPermit();
		const prepared = await (async () => {
		try {
		const settings = this.deps.getSettings();
		const provider = this.deps.backendProvider();
		const namespace = (provider?.getIdentity?.(settings) ?? settings.lastSyncedIdentity) ||
			`${settings.backendType}:${settings.vaultId}`;

		// The remote filesystem owns the path↔identity bijection, and it settles every
		// provider-resolved contention BEFORE the engine consumes any view. It builds its
		// working view, renames the non-keeper on the backend, and reports whether the
		// namespace changed. The engine never observes a collision — it supplies the
		// keeper decision (committed SyncRecords) and the scope filter, and retries when
		// the namespace changed. A cycle that reconciled does not plan or publish
		// anything: it closes as a follow-up and re-observes settled facts next cycle.
		const reconciliation = remoteFs.namespaceReconciliation
			? await remoteFs.namespaceReconciliation.reconcileNamespace({
				isInScope: (path) => !this.isExcluded(path),
				keeper: (path, claimantIds) => this.namespaceKeeper(path, claimantIds),
			})
			: { kind: "settled" as const };
		if (reconciliation.kind === "failed") {
			// A refused repair is not a follow-up loop: rethrowing the provider's own error
			// routes it through the attempt's classification, backoff and MAX_RETRIES, so a
			// permanent refusal surfaces as an error instead of endless `syncing`.
			this.deps.logger?.warn("Namespace reconciliation could not repair a contended address", {
				failures: reconciliation.failures,
			});
			throw toError(reconciliation.failures[0]?.error ?? new Error("Namespace reconciliation failed"));
		}
		if (reconciliation.kind === "changed") {
			const empty = admitBatchObservation(
				captureBatchObservation([], [], [], {
					byEndpoint: new Map(), isConfiguredScopeCompatible: () => true,
				}, namespace),
				conflictStrategy,
			);
			this.activeBatch = new PriorityBatchState(empty);
			this.activeBatch.blockCheckpoint();
			// Move priority to the abort state BEFORE the preparation permit is released,
			// so a queued file-open pull sees `defer` rather than `independent` and cannot
			// publish a local write or a SyncRecord in this reconciled, non-publishing cycle.
			this.activeBatch.abort();
			// Signal the cycle out of the normal executor entirely: it plans nothing and
			// publishes nothing. `executePlan` must not run on it, because its first act is
			// to move the batch back to the transfer phase.
			return { settings, provider, admission: empty, namespaceReconciled: true };
		}

		// The namespace is settled, so the engine consumes a 1:1 view. The filesystem's
		// working delta is reused here rather than re-fetched, so no incomplete view is
		// ever exposed and no change is consumed twice.
		const changeSet: ChangeSet = await collectChanges({
				localFs,
				remoteFs,
				stateStore: this.stateStore,
				checksumRegistry: this.deps.checksumRegistry,
				changes: snapshot,
				remoteDelta: reconciliation.delta,
			}, {
				forceFullScan,
			});

		const { renamePairs } = snapshot;

		const planning = await prepareSyncCycleSnapshotForExecution(
			changeSet,
			namespace,
			captureScopePolicy(settings, this.deps.configDir(), this.deps.pluginId(), this.deps.isMobile()),
			conflictStrategy,
			localFs,
			remoteFs,
			this.deps.checksumRegistry,
			this.deps.logger,
		);
		const visiblePaths = new Set(planning.snapshot.scope.byEndpoint.keys());
		logChangeDetection(changeSet, renamePairs, this.deps.logger, visiblePaths);

		// This call is the authorization cut point. Exceptions from this line onward
		// are not reclassified as evidence-acquisition recovery. Namespace collisions
		// were already settled below the boundary, so Admission sees a 1:1 view.
		const admission = admitBatchObservation(planning.snapshot, conflictStrategy);
		logSyncCyclePlan(this.deps.logger, admission);
		const { folderRenamePairs } = snapshot;

		if (folderRenamePairs.size > 0) {
			this.deps.logger?.info("Folder rename pairs detected", {
				count: folderRenamePairs.size,
				pairs: [...folderRenamePairs.entries()].map(([n, o]) => `${o} → ${n}`),
			});
		}
		this.activeBatch = new PriorityBatchState(admission);
		return { settings, provider, admission, namespaceReconciled: false };
		} finally {
			preparationPermit.release();
		}
		})();
		const { settings, provider, admission, namespaceReconciled } = prepared;
		if (namespaceReconciled) {
			// The reconciled cycle never reaches the executor. Its batch stays in the abort
			// state for the rest of the cycle, so a queued file-open priority keeps
			// deferring and cannot publish a local write or a SyncRecord.
			const empty: ExecutionResult = {
				succeeded: [], superseded: [], failed: [], blocked: [], conflicts: [],
			};
			return { settings, provider, admission, execution: empty };
		}
		const total = admission.executable.actions.length;

		const classifyError = (err: unknown) => provider?.classifyError?.(err) ?? classifyHttpError(err);
		const ctx: ExecutionContext = {
			localFs,
			remoteFs,
			checksumRegistry: this.deps.checksumRegistry,
			committer: {
				stateStore: this.stateStore,
				enableThreeWayMerge: settings.enableThreeWayMerge,
				localFs,
				logger: this.deps.logger,
			},
			onProgress: (completed: number) => {
				if (total > 0) this.deps.onProgress(`Syncing ${completed}/${total}...`);
			},
			logger: this.deps.logger,
			classifyError,
			transferPool: this.deps.isMobile() ? MOBILE_TRANSFER_POOL : DESKTOP_TRANSFER_POOL,
			acquireActionPermit: () => this.priorityCoordinator.acquireNormalPermit(),
			beginAction: (action) => this.activeBatch?.beginAction(action) ?? "invalidated",
			onActionFatal: () => this.activeBatch?.abort(),
			mutationBarrier: this.localMutationBarrier,
			onPhaseChange: (phase) => this.activeBatch?.setPhase(phase),
		};

				const execution = await executePlan(admission.executable, ctx);
				return { settings, provider, admission, execution };
			}, (close) => this.priorityCoordinator.finalize(close), ({ admission, execution }) => {
				this.activeBatch?.setPhase("finalizing");
				return { admission, result: execution, scopeFingerprint,
					checkpointBlocked: this.activeBatch?.isCheckpointBlocked };
			});
			const { settings, provider, admission, execution } = closed.value;
			// Settings are supplementary, after the attempt's working view is closed.
			if (provider?.readBackendState) {
				settings.backendData = { ...settings.backendData, ...provider.readBackendState() };
			}
			await this.deps.saveSettings();
			return { execution, admissionFailures: admission.failures, completion: closed.completion };
		} finally {
			this.activeBatch = null;
		}
	}
}
