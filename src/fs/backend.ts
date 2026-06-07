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
	 * Called when the backend identity changes (e.g. user switches to a different folder).
	 * The provider should reset any stale cursors/tokens in backendData that are
	 * scoped to the previous remote target.
	 */
	resetTargetState?(settings: AirSyncSettings): void;

	/**
	 * Whether a committed incremental checkpoint (delta cursor) exists for the
	 * current target. When false, the sync engine cannot trust delta-based remote
	 * detection — the last sync never completed, or was reset — so it forces a
	 * full cold reconcile. Backends without incremental sync may omit this.
	 */
	hasCheckpoint?(settings: AirSyncSettings): boolean;

	/**
	 * Read updated internal state from the FS to persist in settings.backendData.
	 * Called after each sync cycle so backends can save tokens, cursors, etc.
	 * Returns an opaque record — the sync layer does not inspect its contents.
	 * Tokens are stored in SecretStorage rather than returned in the record.
	 *
	 * `commitCheckpoint` is true only when the whole pipeline succeeded
	 * (failed === 0). When false, the backend must NOT advance its persisted
	 * delta cursor — the spread in the caller preserves the prior committed value
	 * — so an interrupted/partial sync re-detects the un-synced work next time.
	 */
	readBackendState?(fs: IFileSystem, commitCheckpoint: boolean): Record<string, unknown>;

	/**
	 * Flush the backend's durable cache (e.g. the IndexedDB file-metadata map) to
	 * its store. Called ONLY after a fully-successful cycle (failed === 0) and
	 * BEFORE {@link readBackendState} commits the delta cursor — so the persisted
	 * cache never runs ahead of the committed cursor. On a failed cycle this is NOT
	 * called: the cache stays at the last committed state, so the next run's replay
	 * from the committed cursor re-detects the un-synced work (a remote deletion in
	 * particular, which a replay against an already-absorbed cache would silently
	 * drop). Optional: backends without such a cache omit it.
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
