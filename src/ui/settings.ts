import {
	App,
	Notice,
	Platform,
	PluginSettingTab,
	type SettingDefinitionItem,
	type SettingGroupItem,
} from "obsidian";
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

	// Declarative settings (Obsidian 1.13+): returning definitions here makes the
	// settings searchable and renders them without an imperative display(). The
	// backend-connection section stays imperative — each backend supplies a
	// renderer that draws into a container — so it rides in a `render` definition
	// that paints into the group's list element.
	getSettingDefinitions(): SettingDefinitionItem[] {
		const items: SettingDefinitionItem[] = [];

		items.push({ type: "group", heading: "Sync", items: this.syncItems() });

		const connection = this.backendConnectionItem();
		if (connection) {
			items.push(connection);
		}

		items.push({ type: "group", heading: "Advanced", items: this.advancedItems() });
		items.push({ type: "group", heading: "Experimental", items: this.experimentalItems() });

		return items;
	}

	private syncItems(): SettingGroupItem[] {
		const rows: SettingGroupItem[] = [
			{
				name: "Conflict strategy",
				desc: "How to resolve conflicts when both local and remote files have changed.",
				render: (setting) => {
					setting.addDropdown((dropdown) =>
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
				},
			},
		];

		// Backend selector
		const backends = getAllBackendProviders();
		if (backends.length > 1) {
			rows.push({
				name: "Remote backend",
				desc: "The remote storage service to sync with.",
				render: (setting) => {
					setting.addDropdown((dropdown) => {
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
								this.update();
							});
					});
				},
			});
		}

		return rows;
	}

	// Backend-specific settings (config + connection flow). The renderer draws
	// multiple rows imperatively, so it paints into the group's list element and
	// the definition's own row doubles as the section heading.
	private backendConnectionItem(): SettingDefinitionItem | null {
		const provider = getBackendProvider(this.plugin.settings.backendType);
		const renderer = getBackendSettingsRenderer(this.plugin.settings.backendType);
		if (!renderer) {
			return null;
		}

		return {
			name: `${provider?.displayName ?? "Backend"} connection`,
			render: (setting, group) => {
				setting.setHeading();
				renderer.render(
					group.listEl,
					this.plugin.settings,
					async (updates) => {
						this.plugin.settings.backendData = {
							...this.plugin.settings.backendData,
							...updates,
						};
						await this.plugin.saveSettings();
						await this.plugin.backendManager.initBackend();
					},
					{
						startAuth: () => this.plugin.backendManager.startBackendConnect(),
						completeAuth: (code: string) =>
							this.plugin.backendManager.completeBackendConnect(code),
						disconnect: () => this.plugin.backendManager.disconnectBackend(),
						refreshDisplay: () => this.update(),
						startFolderPick: () => this.plugin.backendManager.startBackendFolderPick(),
						bindDefaultFolder: () => this.plugin.backendManager.bindDefaultRemoteVault(),
					},
					this.app,
				);
			},
		};
	}

	private advancedItems(): SettingGroupItem[] {
		const rows: SettingGroupItem[] = [
			{
				name: "Rescan vault",
				desc: "Discard the remote sync checkpoint and fully reconcile against the remote on the next sync. Use this if sync seems stuck or incomplete after an interrupted sync. It compares files rather than re-downloading them, and keeps your sync history.",
				render: (setting) => {
					setting.addButton((button) =>
						button.setButtonText("Rescan").onClick(() => {
							new Notice("Starting a full rescan");
							void this.plugin.rescan();
						})
					);
				},
			},
			{
				name: "Dot-prefixed paths to sync",
				desc: "Dot-prefixed folders to include in sync, one per line.",
				render: (setting) => {
					setting.addTextArea((text) =>
						text
							.setPlaceholder(".templates\nfoo/.bar")
							.setValue(this.plugin.settings.syncDotPaths.join("\n"))
							.onChange(async (value) => {
								this.plugin.settings.syncDotPaths = parseLines(value, {
									stripTrailingSlash: true,
									dedupe: true,
								}).filter(isDotPrefixed);
								await this.plugin.saveSettings();
							})
					);
				},
			},
			{
				name: "Ignore patterns",
				desc: "Patterns to exclude from sync (gitignore syntax), one per line.",
				render: (setting) => {
					setting.addTextArea((text) =>
						text
							.setValue(this.plugin.settings.ignorePatterns.join("\n"))
							.onChange(async (value) => {
								// Trailing slashes are meaningful in gitignore (dir-only), so unlike
								// dot paths we deliberately do NOT strip them here.
								this.plugin.settings.ignorePatterns = parseLines(value);
								await this.plugin.saveSettings();
							})
					);
				},
			},
			{
				name: "Mobile max file size (mb)",
				desc: "Files larger than this will be skipped on mobile.",
				render: (setting) => {
					setting.addText((text) =>
						text
							.setPlaceholder("10")
							.setValue(String(this.plugin.settings.mobileMaxFileSizeMB))
							.onChange(async (value) => {
								const num = parseFloat(value);
								if (!isNaN(num) && num > 0) {
									this.plugin.settings.mobileMaxFileSizeMB = num;
									await this.plugin.saveSettings();
								}
							})
					);
				},
			},
		];

		if (Platform.isMobile) {
			rows.push({
				name: "Keep screen awake during sync",
				desc: "On mobile, prevent the screen from sleeping while a sync is running, so long syncs are not interrupted by the device locking.",
				render: (setting) => {
					setting.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.screenWakeLockOnSync)
							.onChange(async (value) => {
								this.plugin.settings.screenWakeLockOnSync = value;
								await this.plugin.saveSettings();
							})
					);
				},
			});
		}

		rows.push(
			{
				name: "Show sync notifications",
				desc: "Show a brief notice summarizing each completed sync (files uploaded, downloaded, etc.).",
				render: (setting) => {
					setting.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.showSyncNotifications)
							.onChange(async (value) => {
								this.plugin.settings.showSyncNotifications = value;
								await this.plugin.saveSettings();
							})
					);
				},
			},
			{
				name: "Enable logging",
				desc: "Write sync logs to .airsync/ in your vault for debugging.",
				render: (setting) => {
					setting.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.enableLogging)
							.onChange(async (value) => {
								this.plugin.settings.enableLogging = value;
								await this.plugin.saveSettings();
							})
					);
				},
			},
			{
				name: "Log level",
				desc: "Minimum level of messages to log.",
				render: (setting) => {
					setting.addDropdown((dropdown) =>
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
				},
			}
		);

		return rows;
	}

	private experimentalItems(): SettingGroupItem[] {
		const configDir = this.app.vault.configDir;

		const rows: SettingGroupItem[] = [
			{
				name: "Sync Obsidian config",
				desc:
					`Sync Obsidian's own config directory (${configDir}/) — hotkeys, plugin settings, and other ` +
					"portable settings. Device-specific window layout is deliberately excluded. This is Obsidian's " +
					"internal metadata; syncing it across devices may cause settings loss or plugin malfunction.",
				render: (setting) => {
					setting.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.enableConfigSync)
							.onChange(async (value) => {
								this.plugin.settings.enableConfigSync = value;
								await this.plugin.saveSettings();
								this.update();
							})
					);
				},
			},
		];

		if (this.plugin.settings.enableConfigSync) {
			const timingDesc = createFragment((frag) => {
				frag.createEl("p", {
					text:
						"Config changes aren't synced immediately — they're picked up the next time a sync runs " +
						"(triggered by another vault change, returning to the app, or Sync now).",
				});
				frag.createEl("p", {
					text:
						"After a sync finishes, reload the affected plugins (or restart Obsidian) for the synced " +
						"settings to take effect.",
				});
			});
			rows.push({ name: "Sync timing", desc: timingDesc });

			const injectedDesc = createFragment((frag) => {
				frag.appendText("Added automatically to the top of your Ignore patterns above:");
				frag.createEl("pre", {
					text: getConfigSyncIgnorePatterns(
						configDir,
						this.plugin.manifest.id
					).join("\n"),
				});
			});
			rows.push({ name: "Injected ignore patterns", desc: injectedDesc });
		}

		return rows;
	}
}
