import type { App } from "obsidian";
import { getBackendData } from "../backend";
import type { IBackendProvider } from "../backend";
import type { ISecretStore } from "../secret-store";
import type { IFileSystem } from "../interface";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../../sync/remote-vault";
import { REMOTE_VAULT_ROOT } from "../../sync/remote-vault";
import { MetadataStore } from "../../store/metadata-store";
import { PCloudClient } from "./client";
import { PCloudFs } from "./index";
import { PCloudAuthProvider } from "./auth";
import type { PCloudEntry } from "./types";
import { folderIdOf } from "./types";
import { getBackendSecret, hasBackendSecret, clearBackendSecrets } from "../token-store";

const BACKEND_TYPE = "pcloud";
const DEFAULT_API_HOST = "api.pcloud.com";

/** All data stored in backendData["pcloud"] (the access token lives in SecretStorage). */
export interface PCloudBackendData {
	remoteVaultFolderId: string;
	lastKnownVaultName: string;
	/** Region-pinned API host (api.pcloud.com / eapi.pcloud.com), from the auth callback. */
	apiHost: string;
	/** Incremental `diff` cursor. */
	diffId: string;
	pendingAuthState: string;
}

const DEFAULT_PCLOUD_DATA: PCloudBackendData = {
	remoteVaultFolderId: "",
	lastKnownVaultName: "",
	apiHost: "",
	diffId: "",
	pendingAuthState: "",
};

/**
 * pCloud backend provider (OAuth code flow via the auth worker).
 *
 * Addressing is folder-id based: the remote vault is `/obsidian-air-sync/<vault>`
 * resolved to a `folderid` that roots the FS. The `diff` cursor is committed only
 * on a fully-successful sync; the access token is immutable so it is never re-saved.
 */
export class PCloudProvider implements IBackendProvider {
	readonly type = BACKEND_TYPE;
	readonly displayName = "pCloud";
	readonly auth: PCloudAuthProvider;

	constructor(private secretStore: ISecretStore) {
		this.auth = new PCloudAuthProvider(secretStore);
	}

	private getData(settings: AirSyncSettings): PCloudBackendData {
		return { ...DEFAULT_PCLOUD_DATA, ...getBackendData<PCloudBackendData>(settings, BACKEND_TYPE) };
	}

	private makeClient(data: PCloudBackendData, logger?: Logger): PCloudClient {
		return new PCloudClient(
			() => getBackendSecret(this.secretStore, BACKEND_TYPE, "access"),
			() => data.apiHost || DEFAULT_API_HOST,
			logger,
		);
	}

	createFs(_app: App, settings: AirSyncSettings, logger?: Logger): IFileSystem | null {
		const data = this.getData(settings);
		const token = getBackendSecret(this.secretStore, BACKEND_TYPE, "access");
		if (!token || !data.remoteVaultFolderId) return null;

		const client = this.makeClient(data, logger);
		const metadataStore = new MetadataStore<PCloudEntry>(`${settings.vaultId}-${data.remoteVaultFolderId}`, {
			dbNamePrefix: "air-sync-pcloud",
			version: 1,
		});
		const fs = new PCloudFs(client, data.remoteVaultFolderId, logger, metadataStore);
		if (data.diffId) fs.diffId = data.diffId;
		return fs;
	}

	isConnected(settings: AirSyncSettings): boolean {
		return hasBackendSecret(this.secretStore, BACKEND_TYPE, "access") && !!this.getData(settings).remoteVaultFolderId;
	}

	getIdentity(settings: AirSyncSettings): string | null {
		const id = this.getData(settings).remoteVaultFolderId;
		return id ? `${BACKEND_TYPE}:${id}` : null;
	}

	resetTargetState(settings: AirSyncSettings): void {
		const data = settings.backendData[BACKEND_TYPE];
		if (data) delete data.diffId;
	}

	hasCheckpoint(settings: AirSyncSettings): boolean {
		return !!this.getData(settings).diffId;
	}

	readBackendState(fs: IFileSystem, commitCheckpoint: boolean): Record<string, unknown> {
		if (!(fs instanceof PCloudFs)) return {};
		const result: Record<string, unknown> = {};
		// Advance the persisted cursor only on full success; the access token is
		// long-lived and immutable, so there is nothing else to persist.
		if (commitCheckpoint && fs.diffId) result.diffId = fs.diffId;
		return result;
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

	disconnect(_settings: AirSyncSettings): Promise<Record<string, unknown>> {
		clearBackendSecrets(this.secretStore, BACKEND_TYPE, ["access"]);
		return Promise.resolve({ ...DEFAULT_PCLOUD_DATA });
	}
}
