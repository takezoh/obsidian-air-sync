import type { App } from "obsidian";
import { Modal, Notice, Setting } from "obsidian";
import type { OneDriveProvider } from "../fs/onedrive/provider";
import type { AirSyncSettings } from "../settings";

/**
 * In-app folder picker for OneDrive (App Folder scope). Lists the folders directly
 * under the special App Folder root and lets the user pick an existing one or type a
 * new name. On confirm it writes the chosen name to `pendingPickedFolderPath` via the
 * renderer-provided `onSave`, then runs `bindDefault` (the default-bind action), so
 * the provider's `resolveRemoteVault` find-or-creates and binds it.
 *
 * This replaces the web folder picker: App Folder scope means the app only ever sees
 * folders under `approot`, so a full Drive picker would be misleading. No
 * BackendManager changes are needed — binding reuses the existing default-folder path.
 */
export class OneDriveFolderModal extends Modal {
	private selected = "";
	private newName = "";

	constructor(
		app: App,
		private provider: OneDriveProvider,
		private settings: AirSyncSettings,
		private onSave: (updates: Record<string, unknown>) => Promise<void>,
		private bindDefault: () => Promise<void>,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		this.setTitle("Choose a OneDrive folder");
		contentEl.createEl("p", {
			text: "Pick an existing folder in the app folder, or create a new one. This vault syncs into the chosen folder.",
		});

		let folders: { id: string; name: string }[] = [];
		try {
			const client = this.provider.createUiClient(this.settings);
			folders = (await client.listAppRootFolders()).map((f) => ({ id: f.id, name: f.name }));
		} catch {
			contentEl.createEl("p", { text: "Could not list existing folders. You can still create a new one below." });
		}

		if (folders.length > 0) {
			new Setting(contentEl)
				.setName("Existing folder")
				.setDesc("Sync into a folder that already exists.")
				.addDropdown((dd) => {
					dd.addOption("", "Select a folder…");
					for (const f of folders) dd.addOption(f.name, f.name);
					dd.onChange((value) => { this.selected = value; });
				});
		}

		new Setting(contentEl)
			.setName("New folder")
			.setDesc("Or create a new folder by name.")
			.addText((text) =>
				text.setPlaceholder("My vault").onChange((value) => { this.newName = value.trim(); }),
			);

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Use this folder")
				.setCta()
				.onClick(() => void this.confirm()),
		);
	}

	private async confirm(): Promise<void> {
		const name = this.newName || this.selected;
		if (!name) {
			new Notice("Pick an existing folder or enter a new name.");
			return;
		}
		this.close();
		// Queue the chosen name, then trigger the default-bind action — the provider's
		// resolveRemoteVault find-or-creates approot:/<name> and binds its id.
		await this.onSave({ pendingPickedFolderPath: name });
		await this.bindDefault();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
