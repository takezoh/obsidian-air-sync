import type { App } from "obsidian";
import { getBackendData } from "../backend";
import type { IBackendProvider } from "../backend";
import type { ISecretStore } from "../secret-store";
import type { IFileSystem } from "../interface";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../remote-vault-contract";
import { REMOTE_VAULT_ROOT } from "../remote-vault-contract";
import type { IBackendSettingsRenderer } from "../settings-renderer";
import { MetadataStore } from "../../store/metadata-store";
import { PCloudClient } from "./client";
import { PCloudFs } from "./index";
import { PCloudAuthProvider } from "./auth";
import type { PCloudEntry } from "./types";
import { folderIdOf } from "./types";
import { getBackendSecret, hasBackendSecret, clearBackendSecrets } from "../token-store";
import { PCloudSettingsRenderer } from "../../ui/pcloud-settings";

const BACKEND_TYPE = "pcloud";
const DEFAULT_API_HOST = "api.pcloud.com";

/** Plugin-owned secret names the pCloud backend stores under air-sync-pcloud-<name>-token. */
const PCLOUD_SECRET_NAMES = ["access"];

/** All data stored in `backendData` (the access token lives in SecretStorage). */
export interface PCloudBackendData {
	remoteVaultFolderId: string;
	lastKnownVaultName: string;
	/** Region-pinned API host (api.pcloud.com / eapi.pcloud.com), from the auth callback. */
	apiHost: string;
	pendingAuthState: string;
}

const DEFAULT_PCLOUD_DATA: PCloudBackendData = {
	remoteVaultFolderId: "",
	lastKnownVaultName: "",
	apiHost: "",
	pendingAuthState: "",
};

/**
 * pCloud backend provider (OAuth code flow via the auth worker).
 *
 * Addressing is folder-id based: the remote vault is `/obsidian-air-sync/<vault>`
 * resolved to a `folderid` that roots the FS. The `diff` cursor is no longer kept
 * in settings — it commits atomically with the file-metadata cache in the backend's
 * own store (ADR 0001, via the FS's commitCheckpoint). The access token is immutable
 * (long-lived, no refresh), so there is no per-cycle state to persist.
 */
export class PCloudProvider implements IBackendProvider {
	readonly type = BACKEND_TYPE;
	readonly displayName = "pCloud";
	readonly auth: PCloudAuthProvider;

	constructor(private secretStore: ISecretStore) {
		this.auth = new PCloudAuthProvider(secretStore);
	}

	private getData(settings: AirSyncSettings): PCloudBackendData {
		return { ...DEFAULT_PCLOUD_DATA, ...getBackendData<PCloudBackendData>(settings) };
	}

	private makeClient(data: PCloudBackendData, logger?: Logger): PCloudClient {
		return new PCloudClient(
			() => getBackendSecret(this.secretStore, BACKEND_TYPE, "access"),
			() => data.apiHost || DEFAULT_API_HOST,
			logger,
		);
	}

	/** Open the per-target IndexedDB cache store, or null if no folder is bound. */
	private metadataStoreFor(settings: AirSyncSettings): MetadataStore<PCloudEntry> | null {
		const data = this.getData(settings);
		if (!data.remoteVaultFolderId) return null;
		return new MetadataStore<PCloudEntry>(`${settings.vaultId}-${data.remoteVaultFolderId}`, {
			dbNamePrefix: "air-sync-pcloud",
			version: 1,
		});
	}

	createFs(_app: App, settings: AirSyncSettings, logger?: Logger): IFileSystem | null {
		const data = this.getData(settings);
		const token = getBackendSecret(this.secretStore, BACKEND_TYPE, "access");
		if (!token || !data.remoteVaultFolderId) return null;

		const client = this.makeClient(data, logger);
		// The delta cursor is NOT seeded from settings — it lives in the metadata store
		// alongside the file map and is restored together on init (ADR 0001).
		return new PCloudFs(client, data.remoteVaultFolderId, logger, this.metadataStoreFor(settings) ?? undefined);
	}

	isConnected(settings: AirSyncSettings): boolean {
		return hasBackendSecret(this.secretStore, BACKEND_TYPE, "access") && !!this.getData(settings).remoteVaultFolderId;
	}

	getIdentity(settings: AirSyncSettings): string | null {
		const id = this.getData(settings).remoteVaultFolderId;
		return id ? `${BACKEND_TYPE}:${id}` : null;
	}

	createSettingsRenderer(): IBackendSettingsRenderer {
		return new PCloudSettingsRenderer();
	}

	async resolveRemoteVault(
		_app: App,
		settings: AirSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const data = this.getData(settings);
		const client = this.makeClient(data, logger);
		let folderId = data.remoteVaultFolderId;

		if (folderId && data.lastKnownVaultName && data.lastKnownVaultName !== vaultName) {
			// Vault renamed locally → keep the same remote folder, rename it to match.
			await client.renameFolder(folderId, vaultName);
		} else if (!folderId) {
			const root = await client.createFolderIfNotExists("0", REMOTE_VAULT_ROOT);
			const vault = await client.createFolderIfNotExists(folderIdOf(root), vaultName);
			folderId = folderIdOf(vault);
		}

		return { backendUpdates: { remoteVaultFolderId: folderId, lastKnownVaultName: vaultName } };
	}

	/**
	 * Clear the per-target checkpoint store by its settings key, without a live FS
	 * (used by disconnect when the backend had no live FS — e.g. expired auth — so
	 * no stale checkpoint survives). Best-effort: a failure must not block disconnect.
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

	clearPluginSecrets(): void {
		clearBackendSecrets(this.secretStore, BACKEND_TYPE, PCLOUD_SECRET_NAMES);
	}

	disconnect(_settings: AirSyncSettings): Promise<Record<string, unknown>> {
		// pCloud's access token is immutable and has no revoke endpoint; just drop it.
		// The per-target IndexedDB cache + cursor is cleared by BackendManager via the
		// live FS's resetCheckpoint() (or clearCheckpointStore when no FS exists).
		this.clearPluginSecrets();
		return Promise.resolve({ ...DEFAULT_PCLOUD_DATA });
	}
}
