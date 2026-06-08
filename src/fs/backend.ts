import type { App } from "obsidian";
import type { IFileSystem } from "./interface";
import type { IAuthProvider } from "./auth";
import type { AirSyncSettings } from "../settings";
import type { Logger } from "../logging/logger";
import type { RemoteVaultResolution } from "./remote-vault-contract";
import type { ErrorClassification } from "./errors";
import type { IBackendSettingsRenderer } from "./settings-renderer";

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
	 * The backend's own settings-UI renderer. Declared here so the provider registry
	 * is the single source of truth for "what backends exist" — the settings tab
	 * resolves the renderer by type instead of the UI keeping a parallel list.
	 */
	createSettingsRenderer?(): IBackendSettingsRenderer;

	/**
	 * Classify an error thrown by this backend's I/O into a backend-neutral kind the
	 * retry policy can act on (auth / permission / rateLimit / notFound / transient).
	 * Lets the sync engine decide retry-vs-abort without knowing any backend's error
	 * shape (e.g. that Google returns 403 for BOTH permission-denied and rate-limits).
	 * Optional: when omitted the engine falls back to {@link classifyHttpError}.
	 */
	classifyError?(err: unknown): ErrorClassification;

	/**
	 * Read updated internal state from the FS to persist in settings.backendData.
	 * Called after each sync cycle so backends can save non-secret state (e.g. token
	 * expiry). Returns an opaque record — the sync layer does not inspect its
	 * contents. Tokens are stored in SecretStorage rather than returned in the record.
	 *
	 * The delta cursor is NOT persisted here — it is committed atomically with the
	 * file-metadata cache in the backend's own store (via `IFileSystem.commitCheckpoint`
	 * and ADR 0001), so there is no separate settings write to gate on cycle success.
	 * Reads provider/auth state only, so it takes no FS argument.
	 */
	readBackendState?(): Record<string, unknown>;

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
	 * The backend's web-hosted folder-pick flow (e.g. the Google Picker on the OAuth
	 * relay; see {@link WebFolderPicker} for what travels together and why), or
	 * `undefined` for backends without one. Check `provider.picker` once; its presence
	 * guarantees both halves. (Display of the bound folder is the separate
	 * {@link getRemoteVaultDisplayPath} — a folder can be bound without a picker.)
	 */
	picker?: WebFolderPicker;

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

/**
 * A backend's web-hosted folder-pick flow, exposed as one object on
 * {@link IBackendProvider.picker}. The two halves are required together so a backend
 * can't ship a `start` with no `complete` (or vice versa) — the pick would dead-end.
 * Resolving the bound folder's display path is deliberately NOT here: a folder can be
 * bound via the default-folder path without ever opening a picker, so display is an
 * independent optional (`IBackendProvider.getRemoteVaultDisplayPath`).
 */
export interface WebFolderPicker {
	/**
	 * Open the picker (e.g. the Google Picker on the OAuth relay) in the browser. The
	 * selection returns asynchronously via an `obsidian://` deep link and is bound by
	 * {@link completeWebFolderPick}. Returns backendData to persist (e.g. a CSRF nonce).
	 */
	startWebFolderPick(settings: AirSyncSettings): Promise<Record<string, unknown>>;

	/**
	 * Bind the vault to the folder selected by {@link startWebFolderPick}, given the
	 * deep-link params. Validates the selection (CSRF state, reachability with the
	 * current token) and returns the backend data to persist. Throws on an invalid
	 * or inaccessible selection.
	 */
	completeWebFolderPick(
		params: Record<string, string | undefined>,
		settings: AirSyncSettings,
		logger?: Logger,
	): Promise<RemoteVaultResolution>;
}

/** Retrieve the active backend's parameters (the single flat bag) from settings. */
export function getBackendData<T>(settings: AirSyncSettings): T | undefined {
	return settings.backendData as T | undefined;
}
