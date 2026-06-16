import { getBackendData } from "../backend";
import type { ISecretStore } from "../secret-store";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import { GoogleAuth } from "./auth";
import type { IGoogleAuth } from "./auth";
import { GoogleDriveProviderBase } from "./provider-base";
import { GoogleDriveAuthProviderBase } from "./auth-provider-base";
import type { IBackendSettingsRenderer } from "../settings-renderer";
import { GoogleDriveSettingsRenderer } from "../../ui/googledrive-settings";

/** Google Drive's slice of the active-backend `backendData` bag (tokens live in SecretStorage) */
export interface GoogleDriveBackendData {
	remoteVaultFolderId: string;
	accessTokenExpiry: number;
	pendingAuthState: string;
	/** CSRF nonce for an in-flight web folder pick (Google Picker); cleared on completion. */
	pendingFolderPickState: string;
}

const DEFAULT_GOOGLE_DRIVE_DATA: GoogleDriveBackendData = {
	remoteVaultFolderId: "",
	accessTokenExpiry: 0,
	pendingAuthState: "",
	pendingFolderPickState: "",
};

/** Type-safe accessor for Google Drive backend data */
function getGoogleDriveData(settings: AirSyncSettings): GoogleDriveBackendData {
	return {
		...DEFAULT_GOOGLE_DRIVE_DATA,
		...getBackendData<GoogleDriveBackendData>(settings),
	};
}

/**
 * Google Drive authentication provider (built-in OAuth via auth server).
 */
export class GoogleDriveAuthProvider extends GoogleDriveAuthProviderBase {
	readonly backendType = "googledrive";

	constructor(secretStore: ISecretStore) {
		super(secretStore);
	}

	protected buildAuth(_data: Record<string, unknown>, logger?: Logger): IGoogleAuth {
		return new GoogleAuth(logger);
	}
}

/**
 * Google Drive backend provider (built-in OAuth).
 */
export class GoogleDriveProvider extends GoogleDriveProviderBase {
	readonly type = "googledrive";
	readonly displayName = "Google Drive";
	readonly auth: GoogleDriveAuthProvider;

	constructor(secretStore: ISecretStore) {
		super(secretStore);
		this.auth = new GoogleDriveAuthProvider(secretStore);
	}

	protected getData(settings: AirSyncSettings): GoogleDriveBackendData {
		return getGoogleDriveData(settings);
	}

	protected getDefaultData(): GoogleDriveBackendData {
		return DEFAULT_GOOGLE_DRIVE_DATA;
	}

	createSettingsRenderer(): IBackendSettingsRenderer {
		return new GoogleDriveSettingsRenderer();
	}
}
