import type { App } from "../platform/obsidian";
import { Notice, Setting } from "../platform/obsidian";
import type { AirSyncSettings } from "../settings";
import type { JsonObject } from "../backend-api";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "../fs/settings-renderer";
import type { BackendModuleProvider } from "../fs/modules/backend-module-provider";
import { renderBackendSettings } from "./backend-module-settings";
import {
	renderBoundFolderField,
	renderConnectionStatus,
	renderUnboundAppFolderField,
} from "./backend-settings-ui";

/** App-Folder-scoped modules use the in-app folder picker, not a web Picker. */
const APP_FOLDER_MODULES: ReadonlySet<string> = new Set(["dropbox", "onedrive"]);

/**
 * Core-owned settings renderer for a backend module. It draws the module's
 * declarative {@link BackendSettingsDefinition} through the core renderer and
 * routes every auth/binding action through the `BackendModuleProvider` connection
 * host — a module never sees this UI.
 *
 * This is the production renderer; the retired per-backend renderers
 * (`ui/googledrive-settings.ts`, `ui/dropbox-settings.ts`, `ui/onedrive-settings.ts`)
 * were removed with the legacy provider layer.
 */
export class BackendModuleSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType: string;

	constructor(private readonly provider: BackendModuleProvider) {
		this.backendType = provider.type;
	}

	render(
		containerEl: HTMLElement,
		settings: AirSyncSettings,
		onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions,
		app: App,
	): void {
		const module = this.provider.getModule();

		if (module.settings && module.settings.fields.length > 0) {
			new Setting(containerEl).setName(`${module.displayName} settings`).setHeading();
			// A dedicated child container: `renderBackendSettings` empties what it is
			// given on every re-render, so handing it the tab would erase the global
			// sections drawn above it (conflict strategy, backend selector).
			const fieldsEl = containerEl.createDiv();
			renderBackendSettings(fieldsEl, module.settings, {
				config: () => settings.backendData as JsonObject,
				setValue: (key, value) => onSave({ [key]: value }),
			});
		}

		// A token gate (not isConnected): after auth but before a folder is bound the
		// user still needs the folder controls, exactly as the legacy renderers did.
		const authed = this.provider.hasCredentials();
		renderConnectionStatus(containerEl, {
			connected: authed,
			connectLabel: `Connect to ${module.displayName}`,
			actions,
			onConnect: () => this.guardCustomConnect(settings, actions),
		});

		if (!authed) return;
		this.renderBinding(containerEl, settings, actions, onSave, app);
	}

	private renderBinding(
		containerEl: HTMLElement,
		settings: AirSyncSettings,
		actions: BackendConnectionActions,
		onSave: (updates: Record<string, unknown>) => Promise<void>,
		app: App,
	): void {
		const module = this.provider.getModule();
		const folderSetting = new Setting(containerEl).setName("Remote vault folder");
		const target = module.getTarget(settings.backendData as JsonObject);

		if (target) {
			renderBoundFolderField(folderSetting, {
				desc: "The remote folder this vault syncs into.",
				folderId: target.id,
				resolvePath: () => this.provider.getRemoteVaultDisplayPath(settings),
			});
			return;
		}

		// App-Folder-scoped modules keep their in-app picker: it lists the folders that
		// already exist under the app root (the only namespace the scope exposes) and
		// binds the chosen name through the default-bind action.
		if (APP_FOLDER_MODULES.has(module.id)) {
			renderUnboundAppFolderField(folderSetting, {
				app,
				settings,
				provider: this.provider,
				defaultLabel: `/${app.vault.getName()}`,
				modalTitle: `Choose a ${module.displayName} folder`,
				onSave,
				actions,
			});
			return;
		}

		folderSetting.setDesc("Choose where this vault syncs.");
		folderSetting.addButton((button) =>
			button
				.setButtonText("Use default folder")
				.setCta()
				.onClick(() => void actions.bindDefaultFolder()),
		);
		if (this.provider.picker) {
			folderSetting.addButton((button) =>
				button.setButtonText("Choose folder").onClick(() => void actions.startFolderPick()),
			);
		}
	}

	/**
	 * The module's own auth path reads its custom credentials from config; a missing
	 * required custom field must be surfaced before the browser is opened with an
	 * empty client id. Restores the legacy renderers' pre-connect guard.
	 */
	private guardCustomConnect(
		settings: AirSyncSettings,
		actions: BackendConnectionActions,
	): false | void {
		const module = this.provider.getModule();
		const config = settings.backendData as JsonObject;
		if (config.authMode !== "custom") {
			void actions.startAuth();
			return;
		}
		const requiredKeys = new Set(["customClientId", "customClientSecret"]);
		const required = (module.settings?.fields ?? []).find(
			(field) => requiredKeys.has(field.key) && !config[field.key],
		);
		if (required) {
			new Notice(`${required.label} is required`);
			return false;
		}
		void actions.startAuth();
	}
}
