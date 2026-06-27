import type { App } from "obsidian";
import { Notice, Setting } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "../fs/settings-renderer";
import type { OneDriveBackendData, OneDriveProvider } from "../fs/onedrive/provider";
import type { OneDriveProviderBase } from "../fs/onedrive/provider-base";
import type { OneDriveCustomData } from "../fs/onedrive/provider-custom";
import { PLUGIN_REDIRECT_URI } from "../fs/auth-config";
import { getBackendProvider } from "../fs/registry";
import { renderBoundFolderField, renderConnectionStatus, renderUnboundAppFolderField } from "./backend-settings-ui";

/** The fixed authority segments offered in the account-type dropdown (a tenant GUID is the 4th, free-form, option). */
const ONEDRIVE_AUTHORITY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "consumers", label: "Personal accounts only" },
	{ value: "common", label: "Work/school + personal" },
	{ value: "organizations", label: "Work/school only" },
];
const KNOWN_AUTHORITIES = ONEDRIVE_AUTHORITY_OPTIONS.map((o) => o.value);
/** Dropdown sentinel for "Specific tenant…" — the actual authority is the typed GUID (stored as ""→GUID). */
const TENANT_OPTION = "tenant";

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

/**
 * Renders the custom-app OneDrive settings UI: the user's own Entra application (client)
 * id, an account-type dropdown, then the same connection + folder UI as the built-in.
 *
 * The account type maps to the OAuth authority host segment — `common`/`organizations`/
 * a tenant GUID are what let a custom app reach work/school accounts the built-in
 * (`consumers`) cannot. The client id is a PUBLIC PKCE identifier, so it is a plain text
 * field (no secret).
 */
export class OneDriveCustomSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = "onedrive-custom";

	render(
		containerEl: HTMLElement,
		settings: AirSyncSettings,
		onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions,
		app: App,
	): void {
		const provider = getBackendProvider("onedrive-custom") as OneDriveProviderBase | undefined;
		const authed = provider?.auth.isAuthenticated(settings.backendData ?? {}) ?? false;
		const data = (settings.backendData ?? {}) as Partial<OneDriveCustomData>;

		// Tenant mode = an authority that isn't one of the fixed segments. "" is the sentinel
		// for "tenant selected, GUID not yet entered" (fresh/personal is undefined → consumers).
		const rawAuthority = data.customAuthority;
		const isTenant = rawAuthority === "" || (rawAuthority !== undefined && !KNOWN_AUTHORITIES.includes(rawAuthority));

		new Setting(containerEl)
			.setName("Application (client) ID")
			.setDesc(`Your Entra app registration's Application (client) ID. Register ${PLUGIN_REDIRECT_URI} as a redirect URI.`)
			.addText((text) =>
				text
					.setPlaceholder("00000000-0000-0000-0000-000000000000")
					.setValue(data.customClientId ?? "")
					.setDisabled(authed)
					.onChange(async (value) => { await onSave({ customClientId: value.trim() }); }),
			);

		new Setting(containerEl)
			.setName("Account type")
			.setDesc("Which account types your app accepts. Must match the supported account types in your app registration.")
			.addDropdown((dd) => {
				for (const o of ONEDRIVE_AUTHORITY_OPTIONS) dd.addOption(o.value, o.label);
				dd.addOption(TENANT_OPTION, "Specific tenant…");
				dd.setValue(isTenant ? TENANT_OPTION : (rawAuthority ?? "consumers"))
					.setDisabled(authed)
					.onChange(async (value) => {
						// Picking the tenant option clears the authority to the "" sentinel so the
						// GUID field appears empty; the three fixed options store their segment.
						await onSave({ customAuthority: value === TENANT_OPTION ? "" : value });
						actions.refreshDisplay();
					});
			});

		if (isTenant) {
			new Setting(containerEl)
				.setName("Tenant ID")
				.setDesc("Your directory (tenant) ID.")
				.addText((text) =>
					text
						.setPlaceholder("00000000-0000-0000-0000-000000000000")
						.setValue(rawAuthority ?? "")
						.setDisabled(authed)
						.onChange(async (value) => { await onSave({ customAuthority: value.trim() }); }),
				);
		}

		renderConnectionStatus(containerEl, {
			connected: authed,
			connectLabel: "Connect to OneDrive",
			actions,
			onConnect: async () => {
				const current = (settings.backendData ?? {}) as Partial<OneDriveCustomData>;
				if (!current.customClientId) {
					new Notice("Enter your application (client) ID first");
					return false;
				}
				if (current.customAuthority === "") {
					new Notice("Enter your tenant ID");
					return false;
				}
				await actions.startAuth();
				return true;
			},
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
			renderUnboundAppFolderField(folderSetting, {
				app, settings, provider, actions, onSave,
				defaultLabel: app.vault.getName(),
				modalTitle: "Choose a OneDrive folder",
			});
		}
	}
}
