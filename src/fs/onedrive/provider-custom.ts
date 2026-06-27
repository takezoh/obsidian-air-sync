import { Notice } from "obsidian";
import { getBackendData } from "../backend";
import type { ISecretStore } from "../secret-store";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import { PkceAuthProvider } from "../pkce-auth-provider";
import { OneDriveAuth, buildOneDriveAuthorizeUrl, DEFAULT_ONEDRIVE_AUTHORITY } from "./auth";
import { OneDriveProviderBase, type OneDriveBackendData } from "./provider-base";
import type { IBackendSettingsRenderer } from "../settings-renderer";
import { OneDriveCustomSettingsRenderer } from "../../ui/onedrive-settings";

const BACKEND_TYPE = "onedrive-custom";

/**
 * Custom-app OneDrive `backendData`: the built-in fields plus the user's own Entra
 * application (client) id and the chosen authority. `customClientId` is a PUBLIC PKCE
 * identifier (no secret), stored in plain settings. `customAuthority` is the host
 * segment that selects the account set — `consumers` (personal), `common` (work/school
 * + personal), `organizations` (work/school), or a tenant GUID — which is exactly what
 * lets a custom app reach work/school accounts the built-in (`consumers`) cannot.
 */
export interface OneDriveCustomData extends OneDriveBackendData {
	customClientId: string;
	customAuthority: string;
}

const DEFAULT_ONEDRIVE_CUSTOM_DATA: OneDriveCustomData = {
	remoteVaultFolderId: "",
	accessTokenExpiry: 0,
	pendingCodeVerifier: "",
	pendingAuthState: "",
	pendingPickedFolderPath: "",
	customClientId: "",
	customAuthority: DEFAULT_ONEDRIVE_AUTHORITY,
};

function getOneDriveCustomData(settings: AirSyncSettings): OneDriveCustomData {
	return { ...DEFAULT_ONEDRIVE_CUSTOM_DATA, ...getBackendData<OneDriveCustomData>(settings) };
}

function resolveAuthority(backendData: Record<string, unknown>): string {
	return (backendData.customAuthority as string | undefined) || DEFAULT_ONEDRIVE_AUTHORITY;
}

/**
 * Auth provider for the custom-app OneDrive backend. Same PKCE flow as the built-in
 * {@link OneDriveAuthProvider}, but the client id AND the authority come from the
 * user-entered `backendData` — so the authorize URL and the token endpoint hit the
 * chosen tenant (`common`/`organizations`/a tenant GUID), not the built-in `consumers`.
 */
export class OneDriveCustomAuthProvider extends PkceAuthProvider<OneDriveAuth> {
	constructor(secretStore: ISecretStore, logger?: Logger) {
		super(secretStore, BACKEND_TYPE, "", logger);
	}

	protected createAuth(clientId: string, backendData: Record<string, unknown>, logger?: Logger): OneDriveAuth {
		return new OneDriveAuth(clientId, resolveAuthority(backendData), logger);
	}

	protected buildAuthorizeUrl(
		opts: { clientId: string; codeChallenge: string; state: string },
		backendData: Record<string, unknown>,
	): string {
		return buildOneDriveAuthorizeUrl({ ...opts, authority: resolveAuthority(backendData) });
	}

	protected resolveClientId(backendData: Record<string, unknown>): string {
		return (backendData.customClientId as string | undefined) ?? "";
	}

	protected hasCredentials(backendData: Record<string, unknown>): boolean {
		// Fail closed on the "tenant selected, GUID not yet entered" sentinel (`""`): otherwise
		// `resolveAuthority` would coerce it to the personal `consumers` tenant and silently
		// authorize against the wrong tenant. `undefined` is the personal default — allowed.
		return !!this.resolveClientId(backendData) && backendData.customAuthority !== "";
	}

	protected onMissingCredentials(): void {
		new Notice("Enter your application (client) ID first");
	}
}

/**
 * Custom-app OneDrive backend — the user supplies their own Entra app client id and
 * account type (authority). All client/FS/folder-binding/error behaviour is inherited
 * from {@link OneDriveProvider} (same App Folder scope); only the auth identity +
 * authority, the settings renderer, and disconnect (which preserves the entered client
 * id and authority) differ.
 */
export class OneDriveCustomProvider extends OneDriveProviderBase {
	readonly type = BACKEND_TYPE;
	readonly displayName = "OneDrive (custom app)";
	readonly auth = new OneDriveCustomAuthProvider(this.secretStore);

	protected readonly defaultData = DEFAULT_ONEDRIVE_CUSTOM_DATA;
	protected readonly dbNamePrefix = "air-sync-onedrive-custom";

	createSettingsRenderer(): IBackendSettingsRenderer {
		return new OneDriveCustomSettingsRenderer();
	}

	async disconnect(settings: AirSyncSettings): Promise<Record<string, unknown>> {
		await this.auth.revokeAuth();
		this.clearPluginSecrets();
		// Keep the user's client id + authority across a disconnect/reconnect cycle.
		const data = getOneDriveCustomData(settings);
		return {
			...DEFAULT_ONEDRIVE_CUSTOM_DATA,
			customClientId: data.customClientId,
			customAuthority: data.customAuthority,
		};
	}
}
