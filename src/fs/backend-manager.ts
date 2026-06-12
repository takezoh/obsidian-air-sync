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
	/** Clear the per-vault SyncRecord baseline (e.g. on identity change / connect / teardown). */
	clearSyncBaseline: () => Promise<void>;
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
					await this.deps.clearSyncBaseline();
					identityChanged = true;
				}
				settings.lastSyncedIdentity = newIdentity;
				await this.deps.saveSettings();
			}

			this.closeRemoteFs();
			if (!provider.isConnected(settings)) {
				this.remoteFs = null;
				this.deps.onDisconnected();
				// Only nag about expired auth when a target was actually bound. Use the
				// backend-agnostic identity (computed above) instead of a Google Drive-specific
				// settings field, so this layer stays free of any one backend's shape.
				if (newIdentity) {
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
				if (identityChanged) await this.remoteFs.checkpoint?.resetCheckpoint();
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
		if (!provider?.picker) {
			this.deps.notify("This backend has no folder picker.");
			return;
		}
		try {
			const updates = await provider.picker.startWebFolderPick(settings);
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
		if (!provider?.picker) {
			this.deps.notify("This backend has no folder picker.");
			return;
		}

		// Hold `connecting` across the bind so a scheduled sync can't start against the
		// old target mid-rebind (the orchestrator gates on isConnecting()).
		this.connecting = true;
		try {
			const result = await provider.picker.completeWebFolderPick(
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

			// Start cold on connect: a reconnect to a still-bound target (e.g. custom OAuth
			// keeps its folder id across disconnect) must not silently resume against stale
			// state. resetAll runs while the folder id is still in settings (see its doc).
			await this.resetAll(settings);

			// Close any FS from a prior connection before rebuilding — resetAll may have
			// used its open connection, so reassigning without closing would leak it.
			this.closeRemoteFs();

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

		// Refresh once here (runs on both success and error paths after the finally).
		this.deps.refreshSettingsDisplay();
	}

	/** Close the current FS's connections, swallowing errors (best-effort teardown). */
	private closeRemoteFs(): void {
		this.remoteFs?.close?.()?.catch((e: unknown) => {
			this.deps.getLogger().warn("Failed to close backend", { error: e instanceof Error ? e.message : String(e) });
		});
	}

	/**
	 * Discard ALL of the current target's sync state so the next sync starts cold: the
	 * checkpoint store (cursor + cache) AND the SyncRecord baseline. Used at the connect /
	 * disconnect / switch boundaries (Rescan instead keeps the baseline, clearing only the
	 * cursor, so the forced cold reconcile still has something to diff against). Run while
	 * the folder id still keys the store — BEFORE backendData is wiped.
	 *
	 * Checkpoint clear prefers the LIVE FS (its single open connection is mutex-coordinated
	 * with any in-flight cycle); with no live FS — e.g. an expired backend that never built
	 * one — it clears by settings key instead. The checkpoint clear is best-effort (logged,
	 * not thrown); the baseline clear, in contrast, propagates so a failure is surfaced.
	 */
	private async resetAll(settings: AirSyncSettings): Promise<void> {
		if (this.remoteFs) {
			await this.remoteFs.checkpoint?.resetCheckpoint().catch((e: unknown) => {
				this.deps.getLogger().warn("Failed to clear checkpoint store", {
					error: e instanceof Error ? e.message : String(e),
				});
			});
		} else {
			await this.backendProvider?.clearCheckpointStore?.(settings);
		}
		await this.deps.clearSyncBaseline();
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
			// Discard this target's sync state so nothing stale survives a reconnect —
			// before disconnect() resets backendData (resetAll keys the store off it).
			await this.resetAll(settings);

			settings.backendData = await this.backendProvider.disconnect(settings);
			// Forget the synced identity so a later reconnect (to any target) starts clean.
			settings.lastSyncedIdentity = "";
			await this.deps.saveSettings();

			// Close the FS connection before dropping it — resetAll opened the store (via
			// resetCheckpoint) to clear it, so nulling without close leaks it.
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

			// Discard the OLD target's sync state so a switch leaves no orphan — before
			// backendData is wiped below (resetAll keys the store off the folder id).
			await this.resetAll(settings);

			// Hard-clear persisted params (including any custom OAuth references) and the
			// synced identity.
			settings.backendData = {};
			settings.lastSyncedIdentity = "";

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
