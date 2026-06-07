import type { App } from "obsidian";
import type { AirSyncSettings } from "../settings";
import { GoogleDriveSettingsRenderer, GoogleDriveCustomSettingsRenderer } from "./googledrive-settings";
import { DropboxSettingsRenderer } from "./dropbox-settings";

/** Actions that settings renderers can invoke for connection flow UI */
export interface BackendConnectionActions {
	startAuth(): Promise<void>;
	completeAuth(code: string): Promise<void>;
	disconnect(): Promise<void>;
	refreshDisplay(): void;
	/** Open the backend's web folder picker (e.g. the Google Picker or Dropbox Chooser), if it has one. */
	startFolderPick(): Promise<void>;
	/** Bind the backend's default remote folder (Google Drive: obsidian-air-sync/<Vault Name>; Dropbox: /<Vault Name>). */
	bindDefaultFolder(): Promise<void>;
}

/**
 * Renders backend-specific settings UI.
 * Each backend (Google Drive, Dropbox, etc.) implements this interface
 * to provide its configuration fields and connection flow.
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

// --- Registry (same pattern as src/fs/registry.ts) ---

const renderers: IBackendSettingsRenderer[] = [
	new GoogleDriveSettingsRenderer(),
	new GoogleDriveCustomSettingsRenderer(),
	new DropboxSettingsRenderer(),
];

const rendererMap = new Map<string, IBackendSettingsRenderer>();
for (const r of renderers) {
	if (rendererMap.has(r.backendType)) {
		// Defensive: should never happen at runtime with a single renderer
		continue;
	}
	rendererMap.set(r.backendType, r);
}

/** Get a settings renderer by backend type */
export function getBackendSettingsRenderer(
	type: string
): IBackendSettingsRenderer | undefined {
	return rendererMap.get(type);
}

/** Get all registered settings renderers */
export function getAllBackendSettingsRenderers(): readonly IBackendSettingsRenderer[] {
	return [...renderers];
}
