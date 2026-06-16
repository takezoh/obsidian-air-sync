import { Setting } from "obsidian";
import type { App, TextComponent } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type { BackendConnectionActions } from "../fs/settings-renderer";
import { AppFolderPickerModal, type AppFolderPickerProvider } from "./app-folder-picker";

/**
 * Render the shared "Connection status" row: a ●-prefixed status line (colored via
 * the `air-sync-status-connected`/`-disconnected` classes) plus a Connect/Disconnect
 * button. Used by every backend renderer.
 *
 * `onConnect` overrides the default `startAuth` for backends that must guard first
 * (e.g. Google Drive custom requires a folder id) — return `false` from it to abort
 * without refreshing the display.
 */
export function renderConnectionStatus(
	containerEl: HTMLElement,
	opts: {
		connected: boolean;
		connectLabel: string;
		actions: BackendConnectionActions;
		onConnect?: () => Promise<boolean | void> | boolean | void;
	},
): void {
	const { connected, connectLabel, actions } = opts;
	const setting = new Setting(containerEl)
		.setName("Connection status")
		.setDesc(connected ? "● Connected" : "● Not connected");
	setting.settingEl.addClass(connected ? "air-sync-status-connected" : "air-sync-status-disconnected");
	setting.addButton((button) =>
		button
			.setButtonText(connected ? "Disconnect" : connectLabel)
			.onClick(async () => {
				if (connected) {
					await actions.disconnect();
				} else if (opts.onConnect) {
					if ((await opts.onConnect()) === false) return;
				} else {
					await actions.startAuth();
				}
				actions.refreshDisplay();
			}),
	);
}

/**
 * Render the bound remote-folder field: a disabled text field showing the folder id
 * IMMEDIATELY (never block on a network call), then best-effort upgraded to the
 * id-resolved display path. A slow/failed/never-settling lookup just leaves the id
 * shown — it must never stick on a "Resolving…" placeholder.
 */
export function renderBoundFolderField(
	folderSetting: Setting,
	opts: {
		desc: string;
		folderId: string;
		resolvePath?: () => Promise<string | null | undefined> | undefined;
	},
): void {
	folderSetting.setDesc(opts.desc);
	let pathField: TextComponent | undefined;
	folderSetting.addText((text) => {
		pathField = text.setValue(opts.folderId).setDisabled(true);
	});
	void opts.resolvePath?.()
		?.then((path) => { if (path) pathField?.setValue(path); })
		.catch(() => { /* keep the id shown */ });
}

/**
 * Render the unbound remote-folder field for an App-Folder-scoped PKCE backend
 * (Dropbox, OneDrive): a default-folder CTA button and a "Choose folder" button that
 * opens the shared {@link AppFolderPickerModal}. The two backends differ only in the
 * default label and the modal title.
 */
export function renderUnboundAppFolderField(
	folderSetting: Setting,
	opts: {
		app: App;
		settings: AirSyncSettings;
		provider: AppFolderPickerProvider | undefined;
		defaultLabel: string;
		modalTitle: string;
		onSave: (updates: Record<string, unknown>) => Promise<void>;
		actions: BackendConnectionActions;
	},
): void {
	const { app, settings, provider, defaultLabel, modalTitle, onSave, actions } = opts;
	folderSetting.setDesc(
		"Choose where this vault syncs: use the default folder, or pick an existing one inside the app folder.",
	);
	folderSetting
		.addButton((button) =>
			button
				.setButtonText(defaultLabel)
				.setCta()
				.onClick(async () => {
					// Clear any folder name queued by the modal first: the default button
					// always binds the vault name. Otherwise a pick whose bind failed would
					// leave a stale pendingPickedFolderPath this button would silently reuse.
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
						modalTitle,
						provider,
						settings,
						onSave,
						() => actions.bindDefaultFolder(),
					).open();
				}),
		);
}
