import type { App } from "obsidian";
import type { IFileSystem } from "./interface";
import type { IAuthProvider } from "./auth";
import type { AirSyncSettings } from "../settings";
import type { Logger } from "../logging/logger";
import type { RemoteVaultResolution } from "../sync/remote-vault";

/**
 * Abstraction for a remote storage backend.
 * Each backend (Google Drive, Dropbox, etc.) implements this interface.
 * main.ts and sync/ never import backend-specific modules directly.
 */
export interface IBackendProvider {
	/** Unique identifier (e.g. "googledrive", "dropbox") */
	readonly type: string;
	/** Human-readable name (e.g. "Google Drive") */
	readonly displayName: string;
	/** Authentication provider for this backend */
	readonly auth: IAuthProvider;

	/**
	 * Create an IFileSystem from current settings.
	 * Returns null if the backend is not fully configured.
	 */
	createFs(app: App, settings: AirSyncSettings, logger?: Logger): IFileSystem | null;

	/** Whether credentials are present and the backend is ready to sync */
	isConnected(settings: AirSyncSettings): boolean;

	/** Return a string uniquely identifying the current remote target (e.g. folder ID) */
	getIdentity(settings: AirSyncSettings): string | null;

	/**
	 * Read updated internal state from the FS to persist in settings.backendData.
	 * Called after each sync cycle so backends can save non-secret state (e.g. token
	 * expiry). Returns an opaque record — the sync layer does not inspect its
	 * contents. Tokens are stored in SecretStorage rather than returned in the record.
	 *
	 * The delta cursor is NOT persisted here — it is committed atomically with the
	 * file-metadata cache in the backend's own store (see {@link commitCheckpoint}
	 * and ADR 0001), so there is no separate settings write to gate on cycle success.
	 */
	readBackendState?(fs: IFileSystem): Record<string, unknown>;

	/**
	 * Flush the backend's durable checkpoint — the file-metadata cache AND the delta
	 * cursor — to its store, atomically (one transaction; see ADR 0001). Called ONLY
	 * after a fully-successful cycle (failed === 0). On a failed cycle this is NOT
	 * called: the cache and cursor stay at the last committed state, so the next run's
	 * replay re-detects the un-synced work (a remote deletion in particular, which a
	 * replay against an already-absorbed cache would silently drop). Optional:
	 * backends without such a cache omit it.
	 */
	commitCheckpoint?(fs: IFileSystem): Promise<void>;

	/**
	 * Find or create this vault's default remote folder for the given vault name.
	 * Invoked explicitly when the user binds the default folder (BackendManager
	 * .bindDefaultRemoteVault) — NOT automatically on connect. Returns backend-specific
	 * data to persist in settings.backendData.
	 */
	resolveRemoteVault?(
		app: App,
		settings: AirSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution>;

	/**
	 * Open a web-hosted folder picker (e.g. the Google Picker on the OAuth relay)
	 * in the browser. The selection returns asynchronously via an `obsidian://`
	 * deep link and is bound by {@link completeWebFolderPick}. Returns backendData
	 * to persist (e.g. a CSRF nonce). Optional: only backends with a web picker
	 * implement it.
	 */
	startWebFolderPick?(settings: AirSyncSettings): Promise<Record<string, unknown>>;

	/**
	 * Bind the vault to the folder selected by {@link startWebFolderPick}, given the
	 * deep-link params. Validates the selection (CSRF state, reachability with the
	 * current token) and returns the backend data to persist. Throws on an invalid
	 * or inaccessible selection.
	 */
	completeWebFolderPick?(
		params: Record<string, string | undefined>,
		settings: AirSyncSettings,
		logger?: Logger,
	): Promise<RemoteVaultResolution>;

	/**
	 * Resolve the bound remote vault's current path for display, from its stored id
	 * (the path itself is not persisted). Optional: backends that don't address by
	 * id, or that display the id directly, omit it. May make a network call.
	 */
	getRemoteVaultDisplayPath?(settings: AirSyncSettings, logger?: Logger): Promise<string | null>;

	/**
	 * Clear this backend's per-target durable checkpoint store (the IndexedDB
	 * file-map + delta cursor) by its settings-derived key, WITHOUT needing a live
	 * filesystem. Used by the disconnect path when no live FS exists (e.g. the
	 * backend was in an error/expired state) so a stale checkpoint can't survive a
	 * disconnect and mislead a later reconnect. Best-effort. Optional: backends
	 * without such a store omit it.
	 */
	clearCheckpointStore?(settings: AirSyncSettings): Promise<void>;

	/**
	 * Disconnect the backend: revoke auth and reset all backend state.
	 * Returns the reset backendData to persist.
	 */
	disconnect(settings: AirSyncSettings): Promise<Record<string, unknown>>;

	/**
	 * Clear this backend's plugin-owned secrets (its `air-sync-<type>-*-token`
	 * keys) from SecretStorage, without any network call or settings mutation.
	 * Used by the backend-switch hard reset to sweep leftover tokens for every
	 * registered backend — `ISecretStore` cannot be enumerated, so each backend
	 * declares its own clear. New backends with plugin-owned secrets must implement
	 * this; backends with none may omit it.
	 */
	clearPluginSecrets?(): void;
}

/** Retrieve the active backend's parameters (the single flat bag) from settings. */
export function getBackendData<T>(settings: AirSyncSettings): T | undefined {
	return settings.backendData as T | undefined;
}
