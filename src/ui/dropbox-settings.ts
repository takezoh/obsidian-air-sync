import type { App } from "obsidian";
import { Setting } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "../fs/settings-renderer";
import type { DropboxBackendData, DropboxProvider } from "../fs/dropbox/provider";
import { getBackendProvider } from "../fs/registry";
import { renderBoundFolderField, renderConnectionStatus, renderUnboundAppFolderField } from "./backend-settings-ui";

/**
 * Renders Dropbox-specific settings UI: connection status, the in-plugin PKCE
 * OAuth flow, and remote-folder selection.
 *
 * Note: the Dropbox app uses App folder scope, so access is confined to
 * `/Apps/<App>/<vault>` — Air Sync cannot see the rest of the user's Dropbox.
 */
export class DropboxSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = "dropbox";

	render(
		containerEl: HTMLElement,
		settings: AirSyncSettings,
		onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions,
		app: App,
	): void {
		const provider = getBackendProvider("dropbox") as DropboxProvider | undefined;
		// Gate on auth alone (not isConnected): after auth but before a folder is bound,
		// the user still needs the connected UI to choose a remote folder.
		const authed = provider?.auth.isAuthenticated(settings.backendData ?? {}) ?? false;
		const data = (settings.backendData ?? {}) as Partial<DropboxBackendData>;

		renderConnectionStatus(containerEl, {
			connected: authed,
			connectLabel: "Connect to Dropbox",
			actions,
		});

		if (!authed) return;

		const folderSetting = new Setting(containerEl).setName("Remote vault folder");

		if (data.remoteVaultFolderId) {
			// No "Choose folder" once bound — same gate as the default-folder button below.
			renderBoundFolderField(folderSetting, {
				desc: "The folder this vault syncs into, inside the app folder.",
				folderId: data.remoteVaultFolderId,
				resolvePath: () => provider?.getRemoteVaultDisplayPath?.(settings),
			});
		} else {
			// Not bound yet: default folder is /<Vault Name> directly under the app folder.
			renderUnboundAppFolderField(folderSetting, {
				app, settings, provider, actions, onSave,
				defaultLabel: `/${app.vault.getName()}`,
				modalTitle: "Choose a Dropbox folder",
			});
		}
	}
}
