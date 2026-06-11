import type { App } from "obsidian";
import { getBackendData } from "../backend";
import type { IBackendProvider } from "../backend";
import type { ISecretStore } from "../secret-store";
import type { IFileSystem } from "../interface";
import type { IBackendSettingsRenderer } from "../settings-renderer";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { ErrorClassification } from "../errors";
import type { RemoteVaultResolution } from "../remote-vault-contract";
import { MetadataStore } from "../../store/metadata-store";
import { OneDriveClient } from "./client";
import { OneDriveFs } from "./index";
import { OneDriveAuthProvider, OneDriveAuth } from "./auth";
import type { OneDriveItem } from "./types";
import { classifyOneDriveError } from "./errors";
import { findOrCreateAppRootFolder } from "./remote-vault";
import { OneDriveSettingsRenderer } from "../../ui/onedrive-settings";
import { getBackendSecret, setBackendSecret, hasBackendSecret, clearBackendSecrets } from "../token-store";

const BACKEND_TYPE = "onedrive";

/** OneDrive's slice of the active-backend `backendData` bag (tokens live in SecretStorage). */
export interface OneDriveBackendData {
	/**
	 * Stable driveItem id of the remote vault folder — the SOLE remote address. The
	 * FS addresses everything by this id; a remote move/rename of the folder needs no
	 * migration (the id is the binding).
	 */
	remoteVaultFolderId: string;
	accessTokenExpiry: number;
	pendingCodeVerifier: string;
	pendingAuthState: string;
	/**
	 * A folder name chosen in the in-app folder modal, awaiting bind. On the next
	 * `resolveRemoteVault` it is find-or-created under the App Folder root and bound;
	 * cleared afterward. Empty ⇒ bind the default (`approot:/<vaultName>`).
	 */
	pendingPickedFolderPath: string;
}

const DEFAULT_ONEDRIVE_DATA: OneDriveBackendData = {
	remoteVaultFolderId: "",
	accessTokenExpiry: 0,
	pendingCodeVerifier: "",
	pendingAuthState: "",
	pendingPickedFolderPath: "",
};

/**
 * OneDrive backend provider — in-plugin PKCE (worker-less), App Folder scope,
 * personal Microsoft accounts only. The vault lives at `approot:/<folder>` directly
 * under the special App Folder (the scope already namespaces the app). The delta
 * cursor co-commits with the file-map cache in the backend's IndexedDB store (ADR
 * 0001); refreshed tokens are written back to SecretStorage.
 *
 * Folder binding is an IN-APP modal (no web picker), which writes the chosen name
 * to `pendingPickedFolderPath` then triggers the default-bind action so
 * {@link resolveRemoteVault} runs. So this provider has no `picker` capability.
 */
export class OneDriveProvider implements IBackendProvider {
	readonly type = BACKEND_TYPE;
	readonly displayName = "OneDrive (Preview)";
	readonly auth: OneDriveAuthProvider;

	constructor(private secretStore: ISecretStore) {
		this.auth = new OneDriveAuthProvider(secretStore);
	}

	private getData(settings: AirSyncSettings): OneDriveBackendData {
		return { ...DEFAULT_ONEDRIVE_DATA, ...getBackendData<OneDriveBackendData>(settings) };
	}

	/** Build a token-bearing client from the stored secrets + expiry (shared auth). */
	private makeClient(data: OneDriveBackendData, logger?: Logger): OneDriveClient {
		return this.clientFromAuth(this.auth.getOrCreateAuth(logger), data, logger);
	}

	/** A client on a throwaway auth — for one-off settings reads that must not reset
	 *  the live sync's shared in-memory tokens. */
	private makeDetachedClient(data: OneDriveBackendData, logger?: Logger): OneDriveClient {
		return this.clientFromAuth(this.auth.createDetachedAuth(logger), data, logger);
	}

	private clientFromAuth(auth: OneDriveAuth, data: OneDriveBackendData, logger?: Logger): OneDriveClient {
		auth.setTokens(
			getBackendSecret(this.secretStore, BACKEND_TYPE, "refresh"),
			getBackendSecret(this.secretStore, BACKEND_TYPE, "access"),
			data.accessTokenExpiry,
		);
		return new OneDriveClient((force) => auth.getAccessToken(force), logger);
	}

	/**
	 * A client usable from the settings UI / folder modal. Exposed so the in-app
	 * folder modal can list approot folders without a live FS. Detached so it can't
	 * clobber a concurrently-running sync's tokens.
	 */
	createUiClient(settings: AirSyncSettings, logger?: Logger): OneDriveClient {
		return this.makeDetachedClient(this.getData(settings), logger);
	}

	/** The per-target checkpoint store (file-map cache + delta cursor), keyed by id. */
	private metadataStoreFor(settings: AirSyncSettings): MetadataStore<OneDriveItem> | null {
		const id = this.getData(settings).remoteVaultFolderId;
		if (!id) return null;
		return new MetadataStore<OneDriveItem>(`${settings.vaultId}-${id}`, { dbNamePrefix: "air-sync-onedrive", version: 1 });
	}

	/** A usable token exists if either secret is present (a refresh OR a live access token). */
	private hasAnyToken(): boolean {
		return (
			hasBackendSecret(this.secretStore, BACKEND_TYPE, "refresh") ||
			hasBackendSecret(this.secretStore, BACKEND_TYPE, "access")
		);
	}

	createFs(_app: App, settings: AirSyncSettings, logger?: Logger): IFileSystem | null {
		const data = this.getData(settings);
		if (!this.hasAnyToken() || !data.remoteVaultFolderId) return null;
		const client = this.makeClient(data, logger);
		return new OneDriveFs(client, data.remoteVaultFolderId, logger, this.metadataStoreFor(settings) ?? undefined);
	}

	isConnected(settings: AirSyncSettings): boolean {
		return this.hasAnyToken() && !!this.getData(settings).remoteVaultFolderId;
	}

	getIdentity(settings: AirSyncSettings): string | null {
		const id = this.getData(settings).remoteVaultFolderId;
		return id ? `${BACKEND_TYPE}:${id}` : null;
	}

	classifyError(err: unknown): ErrorClassification {
		return classifyOneDriveError(err);
	}

	createSettingsRenderer(): IBackendSettingsRenderer {
		return new OneDriveSettingsRenderer();
	}

	readBackendState(): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		// The delta cursor commits atomically with the file map in the metadata store
		// (ADR 0001). Here we only persist refreshed tokens + the non-secret expiry.
		const tokens = this.auth.getTokenState();
		if (tokens && (tokens.refreshToken || tokens.accessToken)) {
			setBackendSecret(this.secretStore, BACKEND_TYPE, "refresh", tokens.refreshToken);
			setBackendSecret(this.secretStore, BACKEND_TYPE, "access", tokens.accessToken);
			result.accessTokenExpiry = tokens.accessTokenExpiry;
		}
		return result;
	}

	/**
	 * Bind the remote vault folder under the App Folder root. If already bound, keep
	 * the id (a local vault rename doesn't move the remote folder). Else find-or-create
	 * `approot:/<pendingPickedFolderPath>` if the modal queued one, otherwise
	 * `approot:/<vaultName>`, and clear the pending field.
	 */
	async resolveRemoteVault(
		_app: App,
		settings: AirSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const data = this.getData(settings);
		let folderId = data.remoteVaultFolderId;

		if (!folderId) {
			const picked = data.pendingPickedFolderPath.trim();
			const name = picked || vaultName;
			if (!name.trim()) {
				throw new Error("Cannot resolve the OneDrive remote vault: the vault name is empty.");
			}
			const client = this.makeClient(data, logger);
			const folder = await findOrCreateAppRootFolder(client, name, logger);
			folderId = folder.id;
		}

		return { backendUpdates: { remoteVaultFolderId: folderId, pendingPickedFolderPath: "" } };
	}

	/**
	 * Resolve the bound folder's current display path from its id, for settings. The
	 * path is not stored — this reflects the folder's live location. Returns the
	 * parent path + name, or just the name, or null if not bound.
	 */
	async getRemoteVaultDisplayPath(settings: AirSyncSettings, logger?: Logger): Promise<string | null> {
		const data = this.getData(settings);
		if (!data.remoteVaultFolderId) return null;
		const client = this.makeDetachedClient(data, logger);
		const item = await client.getItem(data.remoteVaultFolderId);
		const parentPath = item.parentReference?.path;
		if (parentPath) {
			// e.g. "/drive/root:/Apps/Air Sync" → strip the Graph prefix, append the name.
			const after = parentPath.split(":").pop() ?? "";
			return `${after}/${item.name}`;
		}
		return item.name;
	}

	/**
	 * Clear the per-target checkpoint store by its settings key, without a live FS
	 * (used by disconnect when the backend had no live FS — e.g. expired auth — so no
	 * stale checkpoint survives). Best-effort.
	 */
	async clearCheckpointStore(settings: AirSyncSettings): Promise<void> {
		const store = this.metadataStoreFor(settings);
		if (!store) return;
		try {
			await store.open();
			await store.clear();
			await store.close();
		} catch {
			/* non-fatal: an orphaned store is keyed by the old target and never reused */
		}
	}

	async disconnect(_settings: AirSyncSettings): Promise<Record<string, unknown>> {
		await this.auth.revokeAuth();
		this.clearPluginSecrets();
		return { ...DEFAULT_ONEDRIVE_DATA };
	}

	clearPluginSecrets(): void {
		clearBackendSecrets(this.secretStore, BACKEND_TYPE, ["access", "refresh"]);
	}
}
