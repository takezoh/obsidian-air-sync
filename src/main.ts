import { Notice, Platform, Plugin, setIcon, setTooltip } from "obsidian";
import { DEFAULT_SETTINGS, AirSyncSettings } from "./settings";
import { liftActiveBackendData, normalizeConflictStrategy } from "./settings-normalize";
import { AirSyncSettingTab } from "./ui/settings";
import { LocalFs } from "./fs/local/index";
import { BackendManager } from "./fs/backend-manager";
import { initRegistry, getAllBackendProviders } from "./fs/registry";
import type { ISecretStore } from "./fs/secret-store";
import type { SyncStatus } from "./sync/orchestrator";
import { SyncOrchestrator } from "./sync/orchestrator";
import { SyncScheduler } from "./sync/scheduler";
import { ScreenWakeLockManager } from "./sync/wake-lock";
import { LocalChangeTracker } from "./sync/local-tracker";
import { Logger, getDeviceName } from "./logging/logger";
import { ConflictHistory } from "./sync/conflict-history";

export default class AirSyncPlugin extends Plugin {
	settings!: AirSyncSettings;
	private localFs: LocalFs | null = null;
	backendManager!: BackendManager;
	private statusBarEl: HTMLElement | null = null;
	private syncStatus: SyncStatus = "not_connected";
	private orchestrator!: SyncOrchestrator;
	private scheduler!: SyncScheduler;
	private wakeLock!: ScreenWakeLockManager;
	private localTracker!: LocalChangeTracker;
	private settingTab: AirSyncSettingTab | null = null;
	private logger!: Logger;
	private conflictHistory!: ConflictHistory;

	async onload() {
		// Init the registry BEFORE loadSettings: the backendData normalization there
		// needs the set of registered backend types to tell the old per-type-map
		// shape from the new single-bag shape.
		const secretStore: ISecretStore = {
			getSecret: (key) => this.app.secretStorage.getSecret(key),
			setSecret: (key, value) => { this.app.secretStorage.setSecret(key, value); },
		};
		initRegistry(secretStore);

		await this.loadSettings();

		this.localFs = new LocalFs(this.app, () => this.settings.syncDotPaths);

		const deviceName = getDeviceName(Platform.isMobile, this.settings.vaultId);
		// vault.adapter is a structural superset of RawFsAdapter — no cast needed.
		this.logger = new Logger(
			this.app.vault.adapter,
			() => this.settings,
			deviceName,
		);
		this.logger.info("Plugin loaded", { deviceName, vaultId: this.settings.vaultId });

		// Conflict-resolution audit history, written via the same raw adapter + device
		// name as the logger (it persists to .airsync/conflicts/<device>.json).
		this.conflictHistory = new ConflictHistory(this.logger.adapter, this.logger.sanitizedDeviceName);

		this.backendManager = new BackendManager({
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			getApp: () => this.app,
			getLogger: () => this.logger,
			getVaultName: () => this.app.vault.getName(),
			onConnected: () => {
				this.syncStatus = "idle";
				this.updateStatusBar();
			},
			onDisconnected: () => {
				this.syncStatus = "not_connected";
				this.updateStatusBar();
			},
			clearSyncBaseline: async () => {
				await this.orchestrator?.clearSyncState();
			},
			notify: (message) => {
				new Notice(message);
			},
			refreshSettingsDisplay: () => {
				this.settingTab?.display();
			},
		});

		this.localTracker = new LocalChangeTracker();

		this.wakeLock = new ScreenWakeLockManager({
			isEnabled: () => Platform.isMobile && this.settings.screenWakeLockOnSync,
			register: (cb) => this.register(cb),
			// eslint-disable-next-line obsidianmd/prefer-active-doc -- intentional: app-level foreground. The screen wake lock tracks whether the main Obsidian window is visible, not whichever popout is focused (activeDocument).
			registerDocumentEvent: (type, cb) => this.registerDomEvent(document, type, cb),
			logger: this.logger,
		});

		this.orchestrator = new SyncOrchestrator({
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			localFs: () => this.localFs,
			remoteFs: () => this.backendManager.getRemoteFs(),
			backendProvider: () => this.backendManager.getBackendProvider(),
			isMobile: () => Platform.isMobile,
			onStatusChange: (status) => {
				this.syncStatus = status;
				this.updateStatusBar();
				this.wakeLock.setActive(status === "syncing");
			},
			onProgress: (text) => {
				this.statusBarEl?.setText(text);
			},
			notify: (message, durationMs) => {
				new Notice(message, durationMs);
			},
			localTracker: this.localTracker,
			logger: this.logger,
			isBackendConnecting: () => this.backendManager.isConnecting(),
			isLayoutReady: () => this.app.workspace.layoutReady,
			recordConflicts: (records) => this.conflictHistory.append(records),
		});

		this.scheduler = new SyncScheduler({
			workspace: this.app.workspace,
			vault: this.app.vault,
			localFs: () => this.localFs,
			remoteFs: () => this.backendManager.getRemoteFs(),
			stateStore: this.orchestrator.state,
			localTracker: this.localTracker,
			orchestrator: this.orchestrator,
			isExcluded: (path) => this.orchestrator.isExcluded(path),
			registerEvent: (ref) => this.registerEvent(ref),
			registerWindowEvent: (type, cb) => this.registerDomEvent(window, type, cb),
			// eslint-disable-next-line obsidianmd/prefer-active-doc -- intentional: app-level foreground. The scheduler reacts to the main window's visibility (see scheduler.ts wireVisibilityEvent), not a focused popout (activeDocument).
			registerDocumentEvent: (type, cb) => this.registerDomEvent(document, type, cb),
		});

		this.settingTab = new AirSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Handle OAuth callback via obsidian://air-sync-auth?access_token=...&state=... or ?code=...&state=...
		this.registerObsidianProtocolHandler("air-sync-auth", (params) => {
			if (!params.access_token && !params.code) {
				new Notice("Authorization failed: no token or code received");
				return;
			}
			// Synthetic URL to pass tokens/code to completeAuth(), which parses callback URL params
			const url = new URL("https://callback");
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
			void this.backendManager.completeBackendConnect(url.toString());
		});

		// Web folder-picker result via obsidian://air-sync-folder. Backend-agnostic:
		// BackendManager routes to the active backend's completeWebFolderPick. Kept
		// separate from auth — distinct payload, no sniffing dispatch needed.
		this.registerObsidianProtocolHandler("air-sync-folder", (params) => {
			void this.backendManager.completeBackendFolderPick(params);
		});

		// Initialize backend if configured
		await this.backendManager.initBackend();

		// Commands
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				void this.runSync();
			},
		});

		// Status bar: a clickable cloud icon triggers a manual sync, with the
		// sync status shown as text beside it.
		const syncTriggerEl = this.addStatusBarItem();
		syncTriggerEl.addClass("mod-clickable");
		setIcon(syncTriggerEl, "cloud");
		// `top` so the tooltip clears the status bar at the bottom edge.
		setTooltip(syncTriggerEl, "Sync now", { placement: "top" });
		this.registerDomEvent(syncTriggerEl, "click", () => {
			void this.runSync();
		});

		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar();

		this.scheduler.start();

		// Run one sync once the vault index is loaded. The scheduler defers its
		// event wiring until then, and runSync() is gated on layoutReady, so this
		// is the first sync of the session ("caught up on open").
		this.app.workspace.onLayoutReady(() => void this.runSync());
	}

	onunload() {
		void this.logger.flush();
		this.logger.dispose();
		this.backendManager.close();
		this.scheduler.destroy();
		this.orchestrator.close().catch((e) => {
			this.logger.error("Failed to close orchestrator", { message: e instanceof Error ? e.message : String(e) });
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<AirSyncSettings>,
		);

		let needsSave = false;

		// Normalize a legacy per-type backendData map to the single active-backend bag.
		if (liftActiveBackendData(this.settings, getAllBackendProviders().map((p) => p.type))) {
			needsSave = true;
		}

		// Coerce a removed conflictStrategy (e.g. the retired "ask") to a valid one.
		if (normalizeConflictStrategy(this.settings)) {
			needsSave = true;
		}

		// Generate a stable vault ID on first load
		if (!this.settings.vaultId) {
			this.settings.vaultId = crypto.randomUUID();
			needsSave = true;
		}

		if (needsSave) {
			await this.saveData(this.settings);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async runSync(): Promise<void> {
		if (this.orchestrator.isSyncing()) return;
		try {
			if (!this.localFs || !this.backendManager.getRemoteFs()) {
				await this.backendManager.initBackend();
				if (!this.localFs || !this.backendManager.getRemoteFs()) {
					this.syncStatus = "not_connected";
					this.updateStatusBar();
					new Notice("Not connected to a remote backend");
					return;
				}
			}
			await this.orchestrator.runSync();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.syncStatus = "error";
			this.updateStatusBar();
			new Notice(`Sync error: ${msg}`);
			this.logger.error("Unhandled sync error", { error: msg });
		}
	}

	/**
	 * Discard the remote sync checkpoint and run a full reconcile. The next sync
	 * sees no checkpoint (hasCheckpoint === false) and does a cold remote list ×
	 * baseline join, recovering anything a previous interrupted sync left behind.
	 *
	 * Routes through the orchestrator (not runSync's is-syncing early-return) so
	 * that, if a sync is already in flight, the request coalesces via syncPending
	 * and a cold cycle still runs once the current one finishes — rather than
	 * being silently dropped while the in-flight sync re-commits a checkpoint.
	 */
	async rescan(): Promise<void> {
		// Discard the committed checkpoint (delta cursor + cache) and run a cold
		// reconcile. The orchestrator performs the reset inside its sync mutex so it
		// can't race an in-flight sync that holds the live FS cache (ADR 0001).
		await this.orchestrator.rescan();
	}

	private updateStatusBar(): void {
		if (!this.statusBarEl) return;
		switch (this.syncStatus) {
			case "idle":
				this.statusBarEl.setText("Synced");
				break;
			case "syncing":
				this.statusBarEl.setText("Syncing...");
				break;
			case "error":
				this.statusBarEl.setText("Sync error");
				break;
			case "partial_error":
				this.statusBarEl.setText("Synced (with errors)");
				break;
			case "not_connected":
				this.statusBarEl.setText("Not connected");
				break;
		}
	}
}
