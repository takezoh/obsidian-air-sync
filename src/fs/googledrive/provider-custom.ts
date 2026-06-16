import type { App } from "obsidian";
import { Notice } from "obsidian";
import { getBackendData } from "../backend";
import type { ISecretStore } from "../secret-store";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../remote-vault-contract";
import { GoogleAuthDirect } from "./auth";
import type { IGoogleAuth } from "./auth";
import { GoogleDriveProviderBase } from "./provider-base";
import { GoogleDriveAuthProviderBase } from "./auth-provider-base";
import type { GoogleDriveBackendData } from "./provider";
import type { IBackendSettingsRenderer } from "../settings-renderer";
import { GoogleDriveCustomSettingsRenderer } from "../../ui/googledrive-settings";

/** Backend data for custom OAuth — extends the standard Google Drive data with secret references */
export interface GoogleDriveCustomBackendData extends GoogleDriveBackendData {
	/** SecretStorage secret name for the OAuth client ID */
	customClientId: string;
	/** SecretStorage secret name for the OAuth client secret */
	customClientSecret: string;
	customScope: string;
	customRedirectUri: string;
	customIncludeGrantedScopes: boolean;
}

const DEFAULT_GOOGLE_DRIVE_CUSTOM_DATA: GoogleDriveCustomBackendData = {
	remoteVaultFolderId: "",
	accessTokenExpiry: 0,
	pendingAuthState: "",
	pendingFolderPickState: "",
	customClientId: "",
	customClientSecret: "",
	customScope: "",
	customRedirectUri: "",
	customIncludeGrantedScopes: false,
};

function getGoogleDriveCustomData(settings: AirSyncSettings): GoogleDriveCustomBackendData {
	return {
		...DEFAULT_GOOGLE_DRIVE_CUSTOM_DATA,
		...getBackendData<GoogleDriveCustomBackendData>(settings),
	};
}

/**
 * Auth provider for custom OAuth — uses GoogleAuthDirect to exchange codes
 * and refresh tokens directly with Google using user-provided credentials.
 */
export class GoogleDriveCustomAuthProvider extends GoogleDriveAuthProviderBase {
	readonly backendType = "googledrive-custom";

	constructor(secretStore: ISecretStore) {
		super(secretStore);
	}

	protected buildAuth(data: Record<string, unknown>, logger?: Logger): IGoogleAuth {
		const d = data as Partial<GoogleDriveCustomBackendData>;
		return new GoogleAuthDirect({
			clientId: this.resolveSecret(d.customClientId ?? ""),
			clientSecret: this.resolveSecret(d.customClientSecret ?? ""),
			logger,
			scope: d.customScope || undefined,
			redirectUri: d.customRedirectUri || undefined,
			includeGrantedScopes: d.customIncludeGrantedScopes,
		});
	}

	protected hasCredentials(data: Record<string, unknown>): boolean {
		const d = data as Partial<GoogleDriveCustomBackendData>;
		return !!(this.resolveSecret(d.customClientId ?? "") && this.resolveSecret(d.customClientSecret ?? ""));
	}

	protected onMissingCredentials(): void {
		new Notice("Enter your client ID and client secret first");
	}

	/** Resolve a secret name to its actual value via ISecretStore */
	private resolveSecret(secretName: string): string {
		if (!secretName) return "";
		return this.secretStore.getSecret(secretName) ?? "";
	}
}

/**
 * Custom OAuth Google Drive provider.
 * Uses GoogleAuthDirect for direct token exchange with user-provided credentials.
 */
export class GoogleDriveCustomProvider extends GoogleDriveProviderBase {
	readonly type = "googledrive-custom";
	readonly displayName = "Google Drive (custom OAuth)";
	readonly auth: GoogleDriveCustomAuthProvider;

	constructor(secretStore: ISecretStore) {
		super(secretStore);
		this.auth = new GoogleDriveCustomAuthProvider(secretStore);
	}

	createSettingsRenderer(): IBackendSettingsRenderer {
		return new GoogleDriveCustomSettingsRenderer();
	}

	async resolveRemoteVault(
		app: App,
		settings: AirSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const data = this.getData(settings);
		if (!data.remoteVaultFolderId) {
			throw new Error("Remote vault folder id is required for custom OAuth. Set it in the plugin settings.");
		}
		return super.resolveRemoteVault(app, settings, vaultName, logger);
	}

	async disconnect(settings: AirSyncSettings): Promise<Record<string, unknown>> {
		await this.auth.revokeAuth();
		this.clearPluginSecrets();
		const data = getGoogleDriveCustomData(settings);
		return {
			...DEFAULT_GOOGLE_DRIVE_CUSTOM_DATA,
			customClientId: data.customClientId,
			customClientSecret: data.customClientSecret,
			customScope: data.customScope,
			customRedirectUri: data.customRedirectUri,
			customIncludeGrantedScopes: data.customIncludeGrantedScopes,
			remoteVaultFolderId: data.remoteVaultFolderId,
		};
	}

	protected getData(settings: AirSyncSettings): GoogleDriveBackendData {
		return getGoogleDriveCustomData(settings);
	}

	protected getDefaultData(): GoogleDriveBackendData {
		return DEFAULT_GOOGLE_DRIVE_CUSTOM_DATA;
	}
}
