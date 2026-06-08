import type { App } from "obsidian";
import { Setting } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "../fs/settings-renderer";
import type { PCloudBackendData } from "../fs/pcloud/provider";
import { getBackendProvider } from "../fs/registry";

/**
 * Renders pCloud-specific settings UI: connection status and the OAuth code flow.
 *
 * Note: the pCloud OAuth scope grants access to the whole account (its `diff`
 * feed is account-wide and filtered to the vault subtree client-side).
 */
export class PCloudSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = "pcloud";

	render(
		containerEl: HTMLElement,
		settings: AirSyncSettings,
		_onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions,
		_app: App,
	): void {
		// backendData is a single flat bag for the active backend (not a per-type map).
		const data = (settings.backendData ?? {}) as Partial<PCloudBackendData>;

		const provider = getBackendProvider("pcloud");
		const isConnected = provider?.isConnected(settings) ?? false;

		const statusDesc = isConnected ? "● Connected" : "● Not connected";
		const statusClass = isConnected ? "air-sync-status-connected" : "air-sync-status-disconnected";
		const statusSetting = new Setting(containerEl)
			.setName("Connection status")
			.setDesc(statusDesc);
		statusSetting.settingEl.addClass(statusClass);
		statusSetting.addButton((button) =>
			button
				.setButtonText(isConnected ? "Disconnect" : "Connect to pCloud")
				.onClick(async () => {
					if (isConnected) {
						await actions.disconnect();
					} else {
						await actions.startAuth();
					}
					actions.refreshDisplay();
				}),
		);

		// Show the remote vault folder ID when connected (read-only).
		if (isConnected && data.remoteVaultFolderId) {
			new Setting(containerEl)
				.setName("Remote vault folder")
				.setDesc("Automatically managed remote folder")
				.addText((text) =>
					text.setValue(data.remoteVaultFolderId ?? "").setDisabled(true),
				);
		}
	}
}
