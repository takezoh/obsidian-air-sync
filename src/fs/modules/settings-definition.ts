import type {
	BackendSettingField,
	BackendSettingsDefinition,
	JsonObject,
	JsonValue,
} from "../../backend-api";
import { isJsonObject } from "../../backend-api";

/**
 * Pure helpers behind the core settings renderer. Keeping visibility, default
 * resolution, and validation here lets them be verified without a DOM, and keeps
 * `ui/backend-module-settings.ts` a thin Obsidian-only view.
 */

function jsonDeepEqual(a: JsonValue | undefined, b: JsonValue): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => jsonDeepEqual(item, b[index] as JsonValue));
	}
	if (isJsonObject(a) && isJsonObject(b)) {
		const keys = Object.keys(a);
		if (keys.length !== Object.keys(b).length) return false;
		return keys.every((key) => jsonDeepEqual(a[key], b[key] as JsonValue));
	}
	return false;
}

/** Whether a field's `visibleWhen` condition currently holds. */
export function isFieldVisible(field: BackendSettingField, config: Readonly<JsonObject>): boolean {
	const condition = field.visibleWhen;
	if (!condition) return true;
	return jsonDeepEqual(config[condition.field], condition.equals);
}

/** The visibly-applicable fields for `config`, in declaration order. */
export function visibleFields(
	definition: BackendSettingsDefinition,
	config: Readonly<JsonObject>,
): readonly BackendSettingField[] {
	return definition.fields.filter((field) => isFieldVisible(field, config));
}

/** The effective value of a field: its stored value, else its declared default. */
export function resolveFieldValue(
	field: BackendSettingField,
	config: Readonly<JsonObject>,
): JsonValue | undefined {
	const current = config[field.key];
	return current === undefined ? field.defaultValue : current;
}

/**
 * Validate one field's effective value. Returns a user-facing message or `null`.
 * An absent value is valid (the renderer shows the default or empty input); a
 * select value must be one of its declared options.
 */
export function validateSettingField(
	field: BackendSettingField,
	value: JsonValue | undefined,
): string | null {
	if (value === undefined || value === null) return null;
	switch (field.type) {
		case "toggle":
			return typeof value === "boolean" ? null : `${field.label} must be on or off.`;
		case "select": {
			const allowed = (field.options ?? []).map((option) => option.value);
			return typeof value === "string" && allowed.includes(value)
				? null
				: `${field.label} must be one of the available options.`;
		}
		default:
			return typeof value === "string" ? null : `${field.label} must be text.`;
	}
}

export interface SettingValueIssue {
	readonly key: string;
	readonly message: string;
}

/**
 * Validate every visible field against `config`. Invisible fields are skipped so
 * a stale value behind a hidden branch never blocks the connection.
 */
export function validateBackendSettings(
	definition: BackendSettingsDefinition,
	config: Readonly<JsonObject>,
): readonly SettingValueIssue[] {
	const issues: SettingValueIssue[] = [];
	for (const field of visibleFields(definition, config)) {
		const message = validateSettingField(field, resolveFieldValue(field, config));
		if (message) issues.push({ key: field.key, message });
	}
	return issues;
}
