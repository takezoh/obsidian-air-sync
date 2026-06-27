import type { IBackendSettingsRenderer } from "../settings-renderer";
import type { PkceAuthProvider } from "../pkce-auth-provider";
import { OneDriveAuthProvider, type OneDriveAuth } from "./auth";
import { OneDriveProviderBase, DEFAULT_ONEDRIVE_DATA, type OneDriveBackendData } from "./provider-base";
import { OneDriveSettingsRenderer } from "../../ui/onedrive-settings";

export { type OneDriveBackendData } from "./provider-base";

const BACKEND_TYPE = "onedrive";

/**
 * OneDrive backend provider — App Folder scope, personal Microsoft accounts only (the
 * `consumers` authority). All the sync/client/folder logic lives in
 * {@link OneDriveProviderBase}; this supplies only the backend identity, the built-in
 * auth provider, and the settings renderer.
 */
export class OneDriveProvider extends OneDriveProviderBase {
	// Annotated (not literal) so the custom-app subclass can override them.
	readonly type: string = BACKEND_TYPE;
	readonly displayName: string = "OneDrive";
	readonly auth: PkceAuthProvider<OneDriveAuth> = new OneDriveAuthProvider(this.secretStore);

	protected readonly defaultData: OneDriveBackendData = DEFAULT_ONEDRIVE_DATA;
	protected readonly dbNamePrefix: string = "air-sync-onedrive";

	createSettingsRenderer(): IBackendSettingsRenderer {
		return new OneDriveSettingsRenderer();
	}
}
