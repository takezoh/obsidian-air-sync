import type { App } from "obsidian";
import { Setting } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "../fs/settings-renderer";
import type { OneDriveBackendData, OneDriveProvider } from "../fs/onedrive/provider";
import { getBackendProvider } from "../fs/registry";
import { renderBoundFolderField, renderConnectionStatus, renderUnboundAppFolderField } from "./backend-settings-ui";

/**
 * Renders OneDrive-specific settings UI: connection status, the in-plugin PKCE
 * OAuth flow, and remote-folder selection via an in-app modal.
 *
 * The OneDrive app uses the App Folder scope (personal Microsoft accounts only), so
 * access is confined to the app folder — Air Sync cannot see the rest of the user's
 * OneDrive. The folder modal therefore lists only folders under the app folder.
 */
export class OneDriveSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = "onedrive";

	render(
		containerEl: HTMLElement,
		settings: AirSyncSettings,
		onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions,
		app: App,
	): void {
		const provider = getBackendProvider("onedrive") as OneDriveProvider | undefined;
		// Gate on auth alone (not isConnected): after auth but before a folder is bound,
		// the user still needs the connected UI to choose a remote folder.
		const authed = provider?.auth.isAuthenticated(settings.backendData ?? {}) ?? false;
		const data = (settings.backendData ?? {}) as Partial<OneDriveBackendData>;

		renderConnectionStatus(containerEl, {
			connected: authed,
			connectLabel: "Connect to OneDrive",
			actions,
		});

		if (!authed) return;

		const folderSetting = new Setting(containerEl).setName("Remote vault folder");

		if (data.remoteVaultFolderId) {
			renderBoundFolderField(folderSetting, {
				desc: "The folder this vault syncs into, inside the app folder.",
				folderId: data.remoteVaultFolderId,
				resolvePath: () => provider?.getRemoteVaultDisplayPath?.(settings),
			});
		} else {
			// Not bound yet: default folder is the vault name under the app folder (approot).
			renderUnboundAppFolderField(folderSetting, {
				app, settings, provider, actions, onSave,
				defaultLabel: app.vault.getName(),
				modalTitle: "Choose a OneDrive folder",
			});
		}
	}
}
