import type { IBackendSettingsRenderer } from "../settings-renderer";
import type { PkceAuthProvider } from "../pkce-auth-provider";
import { DropboxAuthProvider, type DropboxAuth } from "./auth";
import { DropboxProviderBase, DEFAULT_DROPBOX_DATA, type DropboxBackendData } from "./provider-base";
import { DropboxSettingsRenderer } from "../../ui/dropbox-settings";

export { type DropboxBackendData } from "./provider-base";

const BACKEND_TYPE = "dropbox";

/**
 * Dropbox backend provider — App Folder scope. All the sync/client/folder logic lives in
 * {@link DropboxProviderBase}; this supplies only the backend identity, the built-in auth
 * provider, and the settings renderer.
 */
export class DropboxProvider extends DropboxProviderBase {
	// Annotated (not literal) so the custom-app subclass can override them.
	readonly type: string = BACKEND_TYPE;
	readonly displayName: string = "Dropbox";
	readonly auth: PkceAuthProvider<DropboxAuth> = new DropboxAuthProvider(this.secretStore);

	protected readonly defaultData: DropboxBackendData = DEFAULT_DROPBOX_DATA;
	protected readonly dbNamePrefix: string = "air-sync-dropbox";

	createSettingsRenderer(): IBackendSettingsRenderer {
		return new DropboxSettingsRenderer();
	}
}
