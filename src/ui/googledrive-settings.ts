import type { App } from "obsidian";
import { Notice, SecretComponent, Setting } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "../fs/settings-renderer";
import type { GoogleDriveBackendData } from "../fs/googledrive/provider";
import type { GoogleDriveCustomBackendData } from "../fs/googledrive/provider-custom";
import { DEFAULT_CUSTOM_SCOPE } from "../fs/googledrive/auth";
import { DEFAULT_CUSTOM_REDIRECT_URI } from "../fs/auth-config";
import { getBackendProvider } from "../fs/registry";
import { REMOTE_VAULT_ROOT } from "../fs/remote-vault-contract";
import { renderBoundFolderField, renderConnectionStatus } from "./backend-settings-ui";

/**
 * Renders Google Drive-specific settings UI:
 * connection status and auth code flow.
 */
export class GoogleDriveSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = "googledrive";

	render(
		containerEl: HTMLElement,
		settings: AirSyncSettings,
		_onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions,
		app: App,
	): void {
		const provider = getBackendProvider("googledrive");
		// Gate on auth alone (not isConnected): after auth but before a folder is bound,
		// the user still needs the connected UI to choose a remote folder.
		const authed = provider?.auth.isAuthenticated(settings.backendData ?? {}) ?? false;

		renderConnectionStatus(containerEl, {
			connected: authed,
			connectLabel: "Connect to Google Drive",
			actions,
		});

		if (!authed) return;

		const data = (settings.backendData ?? {}) as Partial<GoogleDriveBackendData>;
		const folderSetting = new Setting(containerEl).setName("Remote vault folder");

		if (data.remoteVaultFolderId) {
			// No "Choose folder" once bound — same gate as the default-folder button below.
			renderBoundFolderField(folderSetting, {
				desc: "The Google Drive folder this vault syncs into.",
				folderId: data.remoteVaultFolderId,
				resolvePath: () => provider?.getRemoteVaultDisplayPath?.(settings),
			});
		} else {
			// Not bound yet: use the default folder (obsidian-air-sync/<Vault Name>), or
			// pick an existing one. Binding only happens on an explicit choice here.
			const defaultPath = `${REMOTE_VAULT_ROOT}/${app.vault.getName()}`;
			folderSetting.setDesc(
				"Choose where this vault syncs: use the default folder, or pick an existing one.",
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

/**
 * Renders Google Drive (custom OAuth) settings UI:
 * client credentials, connection status, and auth flow.
 */
export class GoogleDriveCustomSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = "googledrive-custom";

	render(
		containerEl: HTMLElement,
		settings: AirSyncSettings,
		onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions,
		app: App,
	): void {
		const data = (settings.backendData ?? {}) as Partial<GoogleDriveCustomBackendData>;
		const provider = getBackendProvider("googledrive-custom");
		const isConnected = provider?.isConnected(settings) ?? false;

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("Select a secret containing your client ID")
			.addComponent(el => new SecretComponent(app, el)
				.setValue(data.customClientId ?? "")
				.onChange(async (value) => {
					await onSave({ customClientId: value });
				}));

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("Select a secret containing your client secret")
			.addComponent(el => new SecretComponent(app, el)
				.setValue(data.customClientSecret ?? "")
				.onChange(async (value) => {
					await onSave({ customClientSecret: value });
				}));

		new Setting(containerEl)
			.setName("Scope")
			.setDesc("Scope for Google Drive access")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_CUSTOM_SCOPE)
					.setValue(data.customScope ?? "")
					.setDisabled(isConnected)
					.onChange(async (value) => {
						await onSave({ customScope: value });
					})
			);

		new Setting(containerEl)
			.setName("Include granted scopes")
			.setDesc("Include previously granted scopes in new tokens (incremental authorization)")
			.addToggle((toggle) =>
				toggle
					.setValue(data.customIncludeGrantedScopes ?? false)
					.setDisabled(isConnected)
					.onChange(async (value) => {
						await onSave({ customIncludeGrantedScopes: value });
					})
			);

		new Setting(containerEl)
			.setName("Redirect uri")
			.setDesc("Set this as the authorized redirect uri")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_CUSTOM_REDIRECT_URI)
					.setValue(data.customRedirectUri ?? "")
					.setDisabled(isConnected)
					.onChange(async (value) => {
						await onSave({ customRedirectUri: value });
					})
			);

		new Setting(containerEl)
			.setName("Remote vault folder ID")
			.setDesc("Folder ID to sync with")
			.addText((text) =>
				text
					.setPlaceholder("...")
					.setValue(data.remoteVaultFolderId ?? "")
					.setDisabled(isConnected)
					.onChange(async (value) => {
						await onSave({ remoteVaultFolderId: value.trim() });
					})
			);

		renderConnectionStatus(containerEl, {
			connected: isConnected,
			connectLabel: "Connect to Google Drive",
			actions,
			onConnect: async () => {
				const current = (settings.backendData ?? {}) as Partial<GoogleDriveCustomBackendData>;
				if (!current.remoteVaultFolderId) {
					new Notice("Enter a remote vault folder ID first");
					return false;
				}
				await actions.startAuth();
				return true;
			},
		});
	}
}
