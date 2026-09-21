import type { JsonValue } from "./json";

/**
 * A declarative settings field (API v2). Core renders these with Obsidian
 * `Setting`/modal/Notice; a module must not import DOM, `App`, or a settings tab.
 */
export type BackendSettingFieldType =
	| "text"
	| "secret_reference"
	| "select"
	| "toggle";

export interface BackendSettingOption {
	readonly value: string;
	readonly label: string;
}

/** Show a field only when another field currently equals `equals`. */
export interface BackendSettingVisibility {
	readonly field: string;
	readonly equals: JsonValue;
}

export interface BackendSettingField {
	/** Key within the active backendData bag. */
	readonly key: string;
	readonly label: string;
	readonly type: BackendSettingFieldType;
	/** Non-secret help text. */
	readonly description?: string;
	readonly defaultValue?: JsonValue;
	readonly options?: readonly BackendSettingOption[];
	readonly visibleWhen?: BackendSettingVisibility;
}

export interface BackendSettingsDefinition {
	readonly fields: readonly BackendSettingField[];
}
