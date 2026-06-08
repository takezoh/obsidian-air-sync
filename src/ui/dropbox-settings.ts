import type { App, TextComponent } from "obsidian";
import { Notice, Setting } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "../fs/settings-renderer";
import type { DropboxBackendData } from "../fs/dropbox/provider";
import { getBackendProvider } from "../fs/registry";

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
		const provider = getBackendProvider("dropbox");
		// Gate on auth alone (not isConnected): after auth but before a folder is bound,
		// the user still needs the connected UI to choose a remote folder.
		const authed = provider?.auth.isAuthenticated(settings.backendData ?? {}) ?? false;
		const data = (settings.backendData ?? {}) as Partial<DropboxBackendData>;

		// PREVIEW-ONLY: Air Sync's official Dropbox app key isn't embedded yet, so testers
		// supply their own app's key here. Disabled once connected (changing it would
		// invalidate the live tokens). Remove this whole field at official release (see auth.ts).
		new Setting(containerEl)
			.setName("App key")
			.setDesc(
				"Your Dropbox app's key (app folder permission). Required while Dropbox support is in preview, until a built-in key ships.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Dropbox app key")
					.setValue(data.appKey ?? "")
					.setDisabled(authed)
					.onChange(async (value) => {
						await onSave({ appKey: value.trim() });
					}),
			);

		const statusDesc = authed ? "● Connected" : "● Not connected";
		const statusClass = authed ? "air-sync-status-connected" : "air-sync-status-disconnected";
		const statusSetting = new Setting(containerEl)
			.setName("Connection status")
			.setDesc(statusDesc);
		statusSetting.settingEl.addClass(statusClass);
		statusSetting.addButton((button) =>
			button
				.setButtonText(authed ? "Disconnect" : "Connect to Dropbox")
				.onClick(async () => {
					if (authed) {
						await actions.disconnect();
					} else {
						// PREVIEW: a key is required to connect; remove this guard with the field.
						// Read it live — the App key onChange above replaces settings.backendData,
						// so the `data` captured at render time is stale.
						const appKey = ((settings.backendData ?? {}) as Partial<DropboxBackendData>).appKey ?? "";
						if (!appKey.trim()) {
							new Notice("Enter your Dropbox app key first");
							return;
						}
						await actions.startAuth();
					}
					actions.refreshDisplay();
				}),
		);

		if (!authed) return;

		const folderSetting = new Setting(containerEl).setName("Remote vault folder");

		if (data.remoteVaultFolderId) {
			// Bound: show the folder id IMMEDIATELY (never block the field on a network
			// call — mirrors the Google Drive renderer), then best-effort upgrade to the
			// id-resolved path. A slow/failed/never-settling lookup just leaves the id
			// shown — it must never stick on a "Resolving…" placeholder. No "Choose folder"
			// once bound — same gate as the default-folder button below.
			folderSetting.setDesc(
				"The folder this vault syncs into, inside the app folder.",
			);
			let pathField: TextComponent | undefined;
			folderSetting
				.addText((text) => {
					pathField = text.setValue(data.remoteVaultFolderId ?? "").setDisabled(true);
				});
			void provider?.getRemoteVaultDisplayPath?.(settings)
				.then((path) => { if (path) pathField?.setValue(path); })
				.catch(() => { /* keep the id shown */ });
		} else {
			// Not bound yet: use the default folder (/<Vault Name> under the app folder),
			// or pick an existing one. Binding only happens on an explicit choice here.
			const defaultPath = `/${app.vault.getName()}`;
			folderSetting.setDesc(
				"Choose where this vault syncs: use the default folder, or pick an existing one inside the app folder.",
			);
			folderSetting
				.addButton((button) =>
					button
						.setButtonText(defaultPath)
						.setCta()
						.onClick(async () => {
							await actions.bindDefaultFolder();
						}),
				)
				.addButton((button) =>
					button
						.setButtonText("Choose folder")
						.onClick(async () => {
							await actions.startFolderPick();
						}),
				);
		}
	}
}
