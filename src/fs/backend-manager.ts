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
			let identityChanged = false;
			if (newIdentity && newIdentity !== storedIdentity) {
				// Reset baselines only when there WAS a prior target — a first-ever
				// identity has nothing to reconcile against. Persist the new identity
				// either way so the next change is detected.
				if (storedIdentity) {
					this.deps.getLogger().info("Backend identity changed", {
						from: storedIdentity,
						to: newIdentity,
					});
					await this.deps.onIdentityChanged();
					identityChanged = true;
				}
				settings.lastSyncedIdentity = newIdentity;
				await this.deps.saveSettings();
			}

			this.closeRemoteFs();
			if (!provider.isConnected(settings)) {
				this.remoteFs = null;
				this.deps.onDisconnected();
				if (settings.backendData.remoteVaultFolderId) {
					this.deps.notify("Authentication expired. Please reconnect in settings.");
				}
				return;
			}

			this.remoteFs = provider.createFs(this.deps.getApp(), settings, this.deps.getLogger());
			if (this.remoteFs) {
				// An identity change cleared the per-file SyncRecord baseline, so the next
				// sync MUST cold-reconcile. Drop any checkpoint the new target's store may
				// still hold from a prior binding (its cursor lives with the cache now,
				// ADR 0001) — otherwise warm/hot detection would run with no baseline.
				if (identityChanged) await this.remoteFs.resetCheckpoint?.();
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

	/**
	 * Bind this vault to its default remote folder (obsidian-air-sync/<Vault Name>),
	 * creating it or migrating a legacy folder as needed, then re-init against it.
	 * The counterpart to {@link completeBackendFolderPick} for the "use default folder"
	 * button — same connecting-guard / reset / re-init shape.
	 */
	async bindDefaultRemoteVault(): Promise<void> {
		if (this.connecting) {
			this.deps.notify("Busy connecting — try again in a moment.");
			return;
		}
		const settings = this.deps.getSettings();
		const provider = this.backendProvider ?? getBackendProvider(settings.backendType) ?? null;
		this.backendProvider = provider;
		if (!provider?.resolveRemoteVault) {
			this.deps.notify("This backend has no default folder.");
			return;
		}

		// Hold `connecting` across the bind so a scheduled sync can't start mid-rebind.
		this.connecting = true;
		try {
			const result = await provider.resolveRemoteVault(
				this.deps.getApp(), settings, this.deps.getVaultName(), this.deps.getLogger(),
			);
			settings.backendData = { ...settings.backendData, ...result.backendUpdates };
			await this.deps.saveSettings();
			// New target's checkpoint reset happens in initBackend() below, when it
			// re-detects the identity change (the cursor lives in the per-target store
			// now, so there is no stale settings cursor to drop here — ADR 0001).
			this.deps.notify("Remote folder updated");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.deps.getLogger().error("Failed to bind default folder", { message: msg });
			this.deps.notify(`Folder selection failed: ${msg}`);
			return;
		} finally {
			this.connecting = false;
		}
		// Re-init detects the new identity, clears sync state, and builds an FS.
		await this.initBackend();
		this.deps.refreshSettingsDisplay();
	}

	/**
	 * Open the backend's web folder picker (e.g. the Google Picker). The selection
	 * returns asynchronously via a deep link → {@link completeBackendFolderPick}.
	 */
	async startBackendFolderPick(): Promise<void> {
		const settings = this.deps.getSettings();
		const provider = this.backendProvider ?? getBackendProvider(settings.backendType) ?? null;
		this.backendProvider = provider;
		if (!provider?.startWebFolderPick) {
			this.deps.notify("This backend has no folder picker.");
			return;
		}
		try {
			const updates = await provider.startWebFolderPick(settings);
			// Re-read settings.backendData AFTER the await (a concurrent sync may have
			// persisted an advanced delta cursor during startWebFolderPick's token fetch);
			// a pre-await snapshot would clobber it. Matches completeBackendFolderPick.
			settings.backendData = { ...settings.backendData, ...updates };
			await this.deps.saveSettings();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.deps.getLogger().error("Failed to start folder pick", { message: msg });
			this.deps.notify(`Folder picker failed: ${msg}`);
		}
	}

	/** Bind the folder selected via the web picker, then re-init against the new target. */
	async completeBackendFolderPick(params: Record<string, string | undefined>): Promise<void> {
		// The deep link is fire-and-forget; if a connect/rebind is in flight, surface
		// that the selection was dropped so the user knows to retry (silent loss reads
		// as "it worked"). pendingFolderPickState stays set, so a retry still validates.
		if (this.connecting) {
			this.deps.notify("Busy connecting — reopen the folder picker in a moment.");
			return;
		}
		const settings = this.deps.getSettings();
		const provider = this.backendProvider ?? getBackendProvider(settings.backendType) ?? null;
		this.backendProvider = provider;
		if (!provider?.completeWebFolderPick) {
			this.deps.notify("This backend has no folder picker.");
			return;
		}

		// Hold `connecting` across the bind so a scheduled sync can't start against the
		// old target mid-rebind (the orchestrator gates on isConnecting()).
		this.connecting = true;
		try {
			const result = await provider.completeWebFolderPick(
				params, settings, this.deps.getLogger(),
			);
			settings.backendData = { ...settings.backendData, ...result.backendUpdates };
			await this.deps.saveSettings();
			// New target's checkpoint reset happens in initBackend() below, when it
			// re-detects the identity change (the cursor lives in the per-target store
			// now — ADR 0001).
			this.deps.notify("Remote folder updated");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.deps.getLogger().error("Failed to bind picked folder", { message: msg });
			this.deps.notify(`Folder selection failed: ${msg}`);
			return;
		} finally {
			this.connecting = false;
		}
		// Re-init detects the new identity, clears sync state, and builds an FS
		// against the chosen folder.
		await this.initBackend();
		this.deps.refreshSettingsDisplay();
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

			// No remote-vault binding here: after auth the user picks the folder
			// explicitly (default-folder button or the Picker). createFs returns null
			// until a folder is bound, so the settings UI shows the folder-choice state.
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

	/** Close the current FS's connections, swallowing errors (best-effort teardown). */
	private closeRemoteFs(): void {
		this.remoteFs?.close?.()?.catch((e: unknown) => {
			this.deps.getLogger().warn("Failed to close backend", { error: e instanceof Error ? e.message : String(e) });
		});
	}

	/**
	 * Drop the current target's checkpoint store (cursor + cache) so no stale
	 * checkpoint survives a disconnect/switch. Prefer the LIVE FS (its single open
	 * connection, no second connection to the same DB); when there is none — e.g. an
	 * expired backend with no FS — clear by settings key. Best-effort; caller must
	 * invoke it BEFORE backendData is wiped (the folder id keys the store).
	 */
	private async dropCheckpointStore(settings: AirSyncSettings): Promise<void> {
		if (this.remoteFs) {
			await this.remoteFs.resetCheckpoint?.()?.catch((e: unknown) => {
				this.deps.getLogger().warn("Failed to clear checkpoint store", {
					error: e instanceof Error ? e.message : String(e),
				});
			});
		} else {
			await this.backendProvider?.clearCheckpointStore?.(settings);
		}
	}

	/** Disconnect the current backend */
	async disconnectBackend(): Promise<void> {
		if (!this.backendProvider) return;
		if (this.connecting) {
			this.deps.notify("Busy connecting — try again in a moment.");
			return;
		}

		const settings = this.deps.getSettings();
		// Hold `connecting` across the teardown so a NEW sync can't start mid-disconnect.
		// (An already-in-flight cycle isn't interrupted — it holds its own remoteFs ref;
		// if it re-commits a checkpoint after the clear, the next reconnect's baseline is
		// empty so collectChanges forces a COLD reconcile that ignores the stale cursor.)
		this.connecting = true;
		try {
			// Drop the per-target checkpoint store so no stale checkpoint survives a
			// reconnect. BEFORE disconnect() resets backendData (the folder id keys it).
			await this.dropCheckpointStore(settings);

			const resetData = await this.backendProvider.disconnect(settings);
			settings.backendData = resetData;
			// Forget the synced identity so a later reconnect (to any target) starts
			// from a clean baseline rather than reusing the just-cleared state's identity.
			settings.lastSyncedIdentity = "";
			await this.deps.saveSettings();

			await this.deps.onIdentityChanged();

			// Close the FS connection before dropping it — dropCheckpointStore opened the
			// store (via resetCheckpoint) to clear it, so nulling without close leaks it.
			this.closeRemoteFs();
			this.remoteFs = null;
			this.deps.onDisconnected();
		} finally {
			this.connecting = false;
		}

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

			// Drop the OLD target's checkpoint store too, so a switch leaves no orphan.
			// BEFORE backendData is wiped below (the folder id keys the store).
			await this.dropCheckpointStore(settings);

			// Hard-clear persisted params (including any custom OAuth references) and the
			// synced identity, then drop the sync-state baselines.
			settings.backendData = {};
			settings.lastSyncedIdentity = "";
			await this.deps.onIdentityChanged();

			settings.backendType = newType;
			this.closeRemoteFs();
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
		this.closeRemoteFs();
	}
}
