import { Setting } from "obsidian";
import type { SmartSyncSettings } from "../settings";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "./backend-settings";
import type { GoogleDriveBackendData } from "../fs/googledrive/provider";

/**
 * Renders Google Drive-specific settings UI:
 * connection status and auth code flow.
 */
export class GoogleDriveSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = "googledrive";

	render(
		containerEl: HTMLElement,
		settings: SmartSyncSettings,
		_onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions
	): void {
		const data = (settings.backendData["googledrive"] ?? {}) as Partial<GoogleDriveBackendData>;

		const isConnected = !!data.refreshToken;

		let statusDesc: string;
		let statusClass: string;
		if (isConnected) {
			statusDesc = "\u25cf Connected";
			statusClass = "smart-sync-status-connected";
		} else {
			statusDesc = "\u25cf Not connected";
			statusClass = "smart-sync-status-disconnected";
		}
		const statusSetting = new Setting(containerEl)
			.setName("Connection status")
			.setDesc(statusDesc);
		statusSetting.settingEl.addClass(statusClass);
		statusSetting
			.addButton((button) =>
				button
					.setButtonText(
						isConnected ? "Disconnect" : "Connect to Google Drive"
					)
					.onClick(async () => {
						if (isConnected) {
							await actions.disconnect();
						} else {
							await actions.startAuth();
						}
						actions.refreshDisplay();
					})
			);

		// Show remote vault folder ID when connected (read-only)
		if (isConnected && data.remoteVaultFolderId) {
			new Setting(containerEl)
				.setName("Remote vault folder")
				.setDesc("Automatically managed folder in Google Drive")
				.addText((text) =>
					text
						.setValue(data.remoteVaultFolderId ?? "")
						.setDisabled(true)
				);
		}

	}
}
