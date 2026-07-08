import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type AirSyncPlugin from "../main";
import type { ConflictStrategy } from "../sync/types";
import { getAllBackendProviders, getBackendProvider } from "../fs/registry";
import { getBackendSettingsRenderer } from "./backend-settings";
import { parseLines } from "../utils/parse-lines";
import { isDotPrefixed } from "../utils/path";
import { getConfigSyncIgnorePatterns } from "../config-sync";

export class AirSyncSettingTab extends PluginSettingTab {
	plugin: AirSyncPlugin;

	constructor(app: App, plugin: AirSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Conflict strategy")
			.setDesc(
				"How to resolve conflicts when both local and remote files have changed."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto_merge", "Auto merge (recommended)")
					.addOption("duplicate", "Always create duplicate")
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (value) => {
						this.plugin.settings.conflictStrategy =
							value as ConflictStrategy;
						await this.plugin.saveSettings();
					})
			);

		// Backend selector
		const backends = getAllBackendProviders();
		if (backends.length > 1) {
			new Setting(containerEl)
				.setName("Remote backend")
				.setDesc("The remote storage service to sync with.")
				.addDropdown((dropdown) => {
					for (const b of backends) {
						dropdown.addOption(b.type, b.displayName);
					}
					dropdown
						.setValue(this.plugin.settings.backendType)
						.onChange(async (value) => {
							if (this.plugin.settings.backendType !== value) {
								// Full reset: clears all backend params + sweeps every
								// backend's plugin tokens, so the new one starts clean.
								await this.plugin.backendManager.switchBackend(value);
							}
							this.display();
						});
				});
		}

		// --- Backend-specific settings (config + connection flow) ---
		const provider = getBackendProvider(
			this.plugin.settings.backendType
		);
		const renderer = getBackendSettingsRenderer(
			this.plugin.settings.backendType
		);
		if (renderer) {
			new Setting(containerEl)
				.setName(`${provider?.displayName ?? "Backend"} connection`)
				.setHeading();

			renderer.render(
				containerEl,
				this.plugin.settings,
				async (updates) => {
					this.plugin.settings.backendData = { ...this.plugin.settings.backendData, ...updates };
					await this.plugin.saveSettings();
					await this.plugin.backendManager.initBackend();
				},
				{
					startAuth: () => this.plugin.backendManager.startBackendConnect(),
					completeAuth: (code: string) =>
						this.plugin.backendManager.completeBackendConnect(code),
					disconnect: () => this.plugin.backendManager.disconnectBackend(),
					refreshDisplay: () => this.display(),
					startFolderPick: () => this.plugin.backendManager.startBackendFolderPick(),
					bindDefaultFolder: () => this.plugin.backendManager.bindDefaultRemoteVault(),
				},
				this.app,
			);
		}

		// --- Advanced settings ---
		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Rescan vault")
			.setDesc(
				"Discard the remote sync checkpoint and fully reconcile against the remote on the next sync. Use this if sync seems stuck or incomplete after an interrupted sync. It compares files rather than re-downloading them, and keeps your sync history."
			)
			.addButton((button) =>
				button.setButtonText("Rescan").onClick(() => {
					new Notice("Starting a full rescan");
					void this.plugin.rescan();
				})
			);

		new Setting(containerEl)
			.setName("Dot-prefixed paths to sync")
			.setDesc(
				"Dot-prefixed folders to include in sync, one per line."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder(".templates\nfoo/.bar")
					.setValue(
						this.plugin.settings.syncDotPaths.join("\n")
					)
					.onChange(async (value) => {
						this.plugin.settings.syncDotPaths = parseLines(value, {
							stripTrailingSlash: true,
							dedupe: true,
						}).filter(isDotPrefixed);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ignore patterns")
			.setDesc("Patterns to exclude from sync (gitignore syntax), one per line.")
			.addTextArea((text) =>
				text
					.setValue(
						this.plugin.settings.ignorePatterns.join("\n")
					)
					.onChange(async (value) => {
						// Trailing slashes are meaningful in gitignore (dir-only), so unlike
						// dot paths we deliberately do NOT strip them here.
						this.plugin.settings.ignorePatterns = parseLines(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Mobile max file size (mb)")
			.setDesc(
				"Files larger than this will be skipped on mobile."
			)
			.addText((text) =>
				text
					.setPlaceholder("10")
					.setValue(
						String(this.plugin.settings.mobileMaxFileSizeMB)
					)
					.onChange(async (value) => {
						const num = parseFloat(value);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.mobileMaxFileSizeMB = num;
							await this.plugin.saveSettings();
						}
					})
			);

		if (Platform.isMobile) {
			new Setting(containerEl)
				.setName("Keep screen awake during sync")
				.setDesc(
					"On mobile, prevent the screen from sleeping while a sync is running, so long syncs are not interrupted by the device locking."
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.screenWakeLockOnSync)
						.onChange(async (value) => {
							this.plugin.settings.screenWakeLockOnSync = value;
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl)
			.setName("Show sync notifications")
			.setDesc(
				"Show a brief notice summarizing each completed sync (files uploaded, downloaded, etc.)."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showSyncNotifications)
					.onChange(async (value) => {
						this.plugin.settings.showSyncNotifications = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable logging")
			.setDesc(
				"Write sync logs to .airsync/ in your vault for debugging."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableLogging)
					.onChange(async (value) => {
						this.plugin.settings.enableLogging = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Log level")
			.setDesc(
				"Minimum level of messages to log."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("debug", "Debug")
					.addOption("info", "Info")
					.addOption("warn", "Warn")
					.addOption("error", "Error")
					.setValue(this.plugin.settings.logLevel)
					.onChange(async (value) => {
						this.plugin.settings.logLevel =
							value as "debug" | "info" | "warn" | "error";
						await this.plugin.saveSettings();
					})
			);

		// --- Experimental settings ---
		new Setting(containerEl).setName("Experimental").setHeading();

		const configDir = this.app.vault.configDir;

		new Setting(containerEl)
			.setName("Sync Obsidian config")
			.setDesc(
				`Sync Obsidian's own config directory (${configDir}/) — hotkeys, plugin settings, and other ` +
					"portable settings. Device-specific window layout is deliberately excluded. This is Obsidian's " +
					"internal metadata; syncing it across devices may cause settings loss or plugin malfunction."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableConfigSync)
					.onChange(async (value) => {
						this.plugin.settings.enableConfigSync = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.enableConfigSync) {
			const timingDesc = document.createDocumentFragment();
			timingDesc.createEl("p", {
				text:
					"Config changes aren't synced immediately — they're picked up the next time a sync runs " +
					"(triggered by another vault change, returning to the app, or Sync now).",
			});
			timingDesc.createEl("p", {
				text:
					"After a sync finishes, reload the affected plugins (or restart Obsidian) for the synced " +
					"settings to take effect.",
			});
			new Setting(containerEl).setName("Sync timing").setDesc(timingDesc);

			const desc = document.createDocumentFragment();
			desc.appendText("Added automatically to the top of your Ignore patterns above:");
			desc.createEl("pre", {
				text: getConfigSyncIgnorePatterns(configDir, this.plugin.manifest.id).join("\n"),
			});
			new Setting(containerEl).setName("Injected ignore patterns").setDesc(desc);
		}
	}
}
