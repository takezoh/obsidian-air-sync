import type { App } from "obsidian";
import { Setting } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "../fs/settings-renderer";
import type { OneDriveBackendData, OneDriveProvider } from "../fs/onedrive/provider";
import { getBackendProvider } from "../fs/registry";
import { AppFolderPickerModal } from "./app-folder-picker";
import { renderBoundFolderField, renderConnectionStatus } from "./backend-settings-ui";

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
			// Not bound yet: use the default folder (the vault name under the app folder),
			// or pick an existing one via the in-app modal. Binding happens on an explicit choice.
			const defaultName = app.vault.getName();
			folderSetting.setDesc(
				"Choose where this vault syncs: use the default folder, or pick an existing one inside the app folder.",
			);
			folderSetting
				.addButton((button) =>
					button
						.setButtonText(defaultName)
						.setCta()
						.onClick(async () => {
							// Clear any folder name queued by the modal first: the default
							// button always binds the vault name. Otherwise a pick whose bind
							// failed (bindDefaultFolder swallows errors) would leave a stale
							// pendingPickedFolderPath that this button would silently reuse.
							await onSave({ pendingPickedFolderPath: "" });
							await actions.bindDefaultFolder();
						}),
				)
				.addButton((button) =>
					button
						.setButtonText("Choose folder")
						.onClick(() => {
							if (!provider) return;
							new AppFolderPickerModal(
								app,
								"Choose a OneDrive folder",
								provider,
								settings,
								onSave,
								() => actions.bindDefaultFolder(),
							).open();
						}),
				);
		}
	}
}
