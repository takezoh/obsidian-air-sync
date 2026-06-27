import { Notice } from "obsidian";
import { getBackendData } from "../backend";
import type { ISecretStore } from "../secret-store";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import { PkceAuthProvider } from "../pkce-auth-provider";
import { DropboxAuth, buildDropboxAuthorizeUrl } from "./auth";
import { DropboxProviderBase, type DropboxBackendData } from "./provider-base";
import type { IBackendSettingsRenderer } from "../settings-renderer";
import { DropboxCustomSettingsRenderer } from "../../ui/dropbox-settings";

const BACKEND_TYPE = "dropbox-custom";

/**
 * Custom-app Dropbox `backendData`: the built-in fields plus the user's own app key.
 * The app key is a PUBLIC PKCE client id (no secret exists — same as the built-in id
 * embedded in `auth-config.ts`), so it is stored in plain settings, not SecretStorage.
 */
export interface DropboxCustomData extends DropboxBackendData {
	/** The user's Dropbox app key (public PKCE client id), entered in settings. */
	customClientId: string;
}

const DEFAULT_DROPBOX_CUSTOM_DATA: DropboxCustomData = {
	remoteVaultFolderId: "",
	accessTokenExpiry: 0,
	pendingCodeVerifier: "",
	pendingAuthState: "",
	pendingPickedFolderPath: "",
	customClientId: "",
};

function getDropboxCustomData(settings: AirSyncSettings): DropboxCustomData {
	return { ...DEFAULT_DROPBOX_CUSTOM_DATA, ...getBackendData<DropboxCustomData>(settings) };
}

/**
 * Auth provider for the custom-app Dropbox backend. Identical PKCE flow to the built-in
 * {@link DropboxAuthProvider}, but the client id comes from the user-entered
 * `backendData.customClientId` instead of the bundled app key.
 */
export class DropboxCustomAuthProvider extends PkceAuthProvider<DropboxAuth> {
	constructor(secretStore: ISecretStore, logger?: Logger) {
		super(secretStore, BACKEND_TYPE, "", logger);
	}

	protected createAuth(clientId: string, _backendData: Record<string, unknown>, logger?: Logger): DropboxAuth {
		return new DropboxAuth(clientId, logger);
	}

	protected buildAuthorizeUrl(
		opts: { clientId: string; codeChallenge: string; state: string },
		_backendData: Record<string, unknown>,
	): string {
		return buildDropboxAuthorizeUrl(opts);
	}

	protected resolveClientId(backendData: Record<string, unknown>): string {
		return (backendData.customClientId as string | undefined) ?? "";
	}

	protected hasCredentials(backendData: Record<string, unknown>): boolean {
		return !!this.resolveClientId(backendData);
	}

	protected onMissingCredentials(): void {
		new Notice("Enter your Dropbox app key first");
	}
}

/**
 * Custom-app Dropbox backend — the user supplies their own Dropbox app key. All
 * client/FS/folder-binding behaviour is inherited from {@link DropboxProvider} (same
 * App Folder scope); only the auth identity, the settings renderer, and disconnect
 * (which preserves the entered app key) differ.
 */
export class DropboxCustomProvider extends DropboxProviderBase {
	readonly type = BACKEND_TYPE;
	readonly displayName = "Dropbox (custom app)";
	readonly auth = new DropboxCustomAuthProvider(this.secretStore);

	protected readonly defaultData = DEFAULT_DROPBOX_CUSTOM_DATA;
	protected readonly dbNamePrefix = "air-sync-dropbox-custom";

	createSettingsRenderer(): IBackendSettingsRenderer {
		return new DropboxCustomSettingsRenderer();
	}

	async disconnect(settings: AirSyncSettings): Promise<Record<string, unknown>> {
		await this.auth.revokeAuth();
		this.clearPluginSecrets();
		// Keep the user's app key so a disconnect/reconnect cycle doesn't force a re-entry.
		return { ...DEFAULT_DROPBOX_CUSTOM_DATA, customClientId: getDropboxCustomData(settings).customClientId };
	}
}
