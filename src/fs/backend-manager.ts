import type { App } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type { IFileSystem } from "./interface";
import type { IBackendProvider } from "./backend";
import type { Logger } from "../logging/logger";
import { getBackendProvider, getAllBackendProviders } from "./registry";
import { AuthError } from "./errors";

export interface BackendManagerDeps {
	getSettings: () => AirSyncSettings;
	saveSettings: () => Promise<void>;
	getApp: () => App;
	getLogger: () => Logger;
	getVaultName: () => string;
	onConnected: (remoteFs: IFileSystem) => void;
	onDisconnected: () => void;
	onIdentityChanged: () => Promise<void>;
	notify: (message: string) => void;
	refreshSettingsDisplay: () => void;
}

export class BackendManager {
	private remoteFs: IFileSystem | null = null;
	private backendProvider: IBackendProvider | null = null;
	private connecting = false;

	constructor(private deps: BackendManagerDeps) {}

	isConnecting(): boolean {
		return this.connecting;
	}

	getRemoteFs(): IFileSystem | null {
		return this.remoteFs;
	}

	getBackendProvider(): IBackendProvider | null {
		return this.backendProvider;
	}

	/** Resolve the backend provider and create the remote IFileSystem */
	async initBackend(): Promise<void> {
		if (this.connecting) return;

		const settings = this.deps.getSettings();
		const provider = getBackendProvider(settings.backendType);
		if (!provider) return;

		this.connecting = true;
		this.backendProvider = provider;

		try {
			// The last-synced identity is persisted in settings (not just in memory),
			// so a backend/target change made across a reload — or a switch that
			// skipped the in-session reset — is still detected here. The sync-state
			// store is keyed by vaultId alone, so without this the new target would
			// reuse the previous one's baselines: every local file "matches" (nothing
			// uploads) and a later cold reconcile could even delete_local against the
			// new, empty remote. getIdentity() is null until a folder is bound, so a
			// transient null neither resets state nor overwrites the stored identity.
			const newIdentity = provider.getIdentity(settings);
			const storedIdentity = settings.lastSyncedIdentity ?? "";
			if (newIdentity && newIdentity !== storedIdentity) {
				// Reset baselines only when there WAS a prior target — a first-ever
				// identity has nothing to reconcile against. Persist the new identity
				// either way so the next change is detected.
				if (storedIdentity) {
					this.deps.getLogger().info("Backend identity changed", {
						from: storedIdentity,
						to: newIdentity,
					});
					provider.resetTargetState?.(settings);
					await this.deps.onIdentityChanged();
				}
				settings.lastSyncedIdentity = newIdentity;
				await this.deps.saveSettings();
			}

			this.remoteFs?.close?.()?.catch((e: unknown) => {
				this.deps.getLogger().warn("Failed to close previous backend", { error: e instanceof Error ? e.message : String(e) });
			});
			if (!provider.isConnected(settings)) {
				this.remoteFs = null;
				this.deps.onDisconnected();
				if (settings.backendData.remoteVaultFolderId) {
					this.deps.notify("Authentication expired. Please reconnect in settings.");
				}
				return;
			}

			// Remote vault resolution
			if (provider.resolveRemoteVault) {
				await this.resolveRemoteVault(provider, settings);
			}

			this.remoteFs = provider.createFs(this.deps.getApp(), settings, this.deps.getLogger());
			if (this.remoteFs) {
				this.deps.onConnected(this.remoteFs);
				this.deps.getLogger().info("Backend initialized", { backend: settings.backendType });
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.deps.getLogger().error("Failed to initialize backend", { message: msg });
			if (e instanceof AuthError) {
				this.deps.notify("Authentication expired. Please reconnect in settings.");
			}
		} finally {
			this.connecting = false;
		}
	}

	private async resolveRemoteVault(
		provider: IBackendProvider,
		settings: AirSyncSettings,
	): Promise<void> {
		const vaultName = this.deps.getVaultName();
		const backendData = settings.backendData;
		const cachedFolderId = backendData.remoteVaultFolderId as string | undefined;
		const lastKnownName = backendData.lastKnownVaultName as string | undefined;

		// Skip network call if already linked and name unchanged
		if (cachedFolderId && lastKnownName === vaultName) {
			return;
		}

		const result = await provider.resolveRemoteVault!(
			this.deps.getApp(), settings, vaultName, this.deps.getLogger()
		);
		settings.backendData = { ...settings.backendData, ...result.backendUpdates };
		await this.deps.saveSettings();
	}

	/** Start the backend's auth/connection flow */
	async startBackendConnect(): Promise<void> {
		const settings = this.deps.getSettings();
		if (!this.backendProvider) {
			this.backendProvider =
				getBackendProvider(settings.backendType) ?? null;
		}
		if (!this.backendProvider) {
			this.deps.notify("No backend configured");
			return;
		}
		try {
			const current = settings.backendData;
			const updates = await this.backendProvider.auth.startAuth(current);
			settings.backendData = { ...current, ...updates };
			await this.deps.saveSettings();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.deps.getLogger().error("Failed to start backend connection", { message: msg });
			this.deps.notify(`Connection failed: ${msg}`);
		}
	}

	/** Complete the auth flow with a code/token from the user */
	async completeBackendConnect(code: string): Promise<void> {
		if (this.connecting) return;
		if (!this.backendProvider) {
			this.deps.notify("Start the connection flow first");
			return;
		}

		const settings = this.deps.getSettings();
		this.connecting = true;

		try {
			const backendData = settings.backendData;
			const updates = await this.backendProvider.auth.completeAuth(
				code,
				backendData,
			);
			settings.backendData = { ...backendData, ...updates };
			await this.deps.saveSettings();

			// Resolve remote vault before creating FS
			if (this.backendProvider.resolveRemoteVault) {
				await this.resolveRemoteVault(this.backendProvider, settings);
			}

			this.remoteFs = this.backendProvider.createFs(
				this.deps.getApp(),
				settings,
				this.deps.getLogger()
			);
			if (this.remoteFs) {
				this.deps.onConnected(this.remoteFs);
				// Record the synced identity now so a later same-session target change
				// (e.g. editing the custom folder id) is detected by the next
				// initBackend, which then resets the stale baselines.
				settings.lastSyncedIdentity = this.backendProvider.getIdentity(settings) ?? "";
				await this.deps.saveSettings();
			}

			this.deps.notify(
				`Connected to ${this.backendProvider.displayName}`
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.deps.getLogger().error("Authorization failed", { message: msg });
			this.deps.notify(`Authorization failed: ${msg}`);
		} finally {
			this.connecting = false;
		}

		this.deps.refreshSettingsDisplay();
	}

	/** Disconnect the current backend */
	async disconnectBackend(): Promise<void> {
		if (!this.backendProvider) return;

		const settings = this.deps.getSettings();
		const resetData = await this.backendProvider.disconnect(settings);
		settings.backendData = resetData;
		// Forget the synced identity so a later reconnect (to any target) starts from
		// a clean baseline rather than reusing the just-cleared state's identity.
		settings.lastSyncedIdentity = "";
		await this.deps.saveSettings();

		await this.deps.onIdentityChanged();

		this.remoteFs = null;
		this.deps.onDisconnected();

		this.deps.refreshSettingsDisplay();
	}

	/**
	 * Switch to a different backend with a full reset. Regardless of the from/to
	 * pair, wipe ALL persisted backend params and sweep every registered backend's
	 * plugin-owned tokens — a leftover token under one backend's key must never be
	 * used by another (it would create files under the wrong OAuth client). The new
	 * backend therefore starts disconnected and must be reconnected.
	 */
	async switchBackend(newType: string): Promise<void> {
		const settings = this.deps.getSettings();
		if (settings.backendType === newType) return;
		// A connect/init/switch already owns the lifecycle — don't race it.
		if (this.connecting) {
			this.deps.notify("Busy — finish connecting, then switch.");
			return;
		}

		// Hold `connecting` across the whole reset so a scheduled sync can't start
		// against the old remoteFs (still live until the close below) while we wipe
		// backendData and the sync-state store — the orchestrator gates on isConnecting().
		this.connecting = true;
		try {
			// Best-effort revoke the old backend's token. Read isConnected/disconnect
			// BEFORE wiping backendData below — they read the bag, which still belongs
			// to the previous backend at this point.
			const prev = getBackendProvider(settings.backendType);
			if (prev?.isConnected(settings)) {
				try {
					await prev.disconnect(settings);
				} catch (e) {
					this.deps.getLogger().warn("Revoke on backend switch failed (continuing)", {
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}

			// Sweep plugin-owned tokens for every registered backend (old, new, and any
			// stray leftovers). Idempotent and network-free.
			for (const p of getAllBackendProviders()) {
				p.clearPluginSecrets?.();
			}

			// Hard-clear persisted params (including any custom OAuth references) and the
			// synced identity, then drop the sync-state baselines.
			settings.backendData = {};
			settings.lastSyncedIdentity = "";
			await this.deps.onIdentityChanged();

			settings.backendType = newType;
			this.remoteFs?.close?.()?.catch((e: unknown) => {
				this.deps.getLogger().warn("Failed to close previous backend", { error: e instanceof Error ? e.message : String(e) });
			});
			this.remoteFs = null;
			this.backendProvider = null;
			await this.deps.saveSettings();
		} finally {
			this.connecting = false;
		}
		// initBackend re-detects the now-disconnected new backend and fires
		// onDisconnected; calling it here too would double-fire.
		await this.initBackend();
		this.deps.refreshSettingsDisplay();
	}

	/** Release resources */
	close(): void {
		this.remoteFs?.close?.()?.catch((e: unknown) => {
			this.deps.getLogger().warn("Failed to close backend on unload", { error: e instanceof Error ? e.message : String(e) });
		});
	}
}
