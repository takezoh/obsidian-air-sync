import type { App } from "obsidian";
import type { AirSyncSettings } from "../settings";

/** Actions that settings renderers can invoke for connection flow UI */
export interface BackendConnectionActions {
	startAuth(): Promise<void>;
	completeAuth(code: string): Promise<void>;
	disconnect(): Promise<void>;
	refreshDisplay(): void;
	/** Open the backend's web folder picker (e.g. the Google Picker), if it has one. */
	startFolderPick(): Promise<void>;
	/** Bind the backend's default remote folder (obsidian-air-sync/<Vault Name>). */
	bindDefaultFolder(): Promise<void>;
}

/**
 * Renders a backend's settings UI. Each backend declares its renderer via
 * {@link IBackendProvider.createSettingsRenderer}; the generic settings tab resolves
 * it by backend type. The contract lives in `fs/` (not `ui/`) so the registry of
 * backends stays the single source of truth — the UI layer no longer keeps a
 * parallel renderer list that has to be kept in sync by hand.
 */
export interface IBackendSettingsRenderer {
	/** Must match the corresponding IBackendProvider.type */
	readonly backendType: string;

	render(
		containerEl: HTMLElement,
		settings: AirSyncSettings,
		onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions,
		app: App,
	): void;
}
