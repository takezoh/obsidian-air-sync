import { Setting } from "../platform/obsidian";
import type {
	BackendSettingField,
	BackendSettingsDefinition,
	JsonObject,
	JsonValue,
} from "../backend-api";
import {
	resolveFieldValue,
	validateBackendSettings,
	visibleFields,
} from "../fs/modules/settings-definition";

/**
 * Core-owned view of a module's declarative settings.
 *
 * A module never imports DOM, `App`, or a settings tab: it returns a
 * {@link BackendSettingsDefinition} and core renders it here with Obsidian
 * `Setting`. The host supplies the current config bag and receives typed updates;
 * a secret value is never read into or written from this layer — a
 * `secret_reference` field holds a non-secret reference name only.
 */
export interface BackendSettingsHost {
	/** The latest active config bag (read fresh on every render). */
	config(): Readonly<JsonObject>;
	/** Persist one top-level field of the active config bag. */
	setValue(key: string, value: JsonValue): void | Promise<void>;
}

function renderControl(
	setting: Setting,
	field: BackendSettingField,
	value: JsonValue | undefined,
	commit: (value: JsonValue) => void,
): void {
	switch (field.type) {
		case "toggle":
			setting.addToggle((toggle) =>
				toggle
					.setValue(value === true)
					.onChange((next) => commit(next)),
			);
			return;
		case "select":
			setting.addDropdown((dropdown) => {
				for (const option of field.options ?? []) {
					dropdown.addOption(option.value, option.label);
				}
				if (typeof value === "string") dropdown.setValue(value);
				dropdown.onChange((next) => commit(next));
			});
			return;
		case "secret_reference":
		case "text":
		default:
			setting.addText((text) => {
				if (typeof value === "string") text.setValue(value);
				text.onChange((next) => commit(next));
			});
	}
}

/**
 * Render `definition` into a fresh child of `parent`, re-rendering in place when a
 * value changes. `parent` is never emptied: this owns only the subtree it creates,
 * so a caller can compose it with other sections of the same settings tab.
 */
export function renderBackendSettings(
	parent: HTMLElement,
	definition: BackendSettingsDefinition,
	host: BackendSettingsHost,
): void {
	const root = parent.createDiv();
	const draw = (): void => {
		const config = host.config();
		const issues = new Map(
			validateBackendSettings(definition, config).map((issue) => [issue.key, issue.message]),
		);
		root.empty();
		for (const field of visibleFields(definition, config)) {
			const setting = new Setting(root).setName(field.label);
			const issue = issues.get(field.key);
			const help = field.description ?? "";
			setting.setDesc(issue ? (help ? `${help} — ${issue}` : issue) : help);
			const commit = (next: JsonValue): void => {
				void Promise.resolve(host.setValue(field.key, next)).then(draw);
			};
			renderControl(setting, field, resolveFieldValue(field, config), commit);
		}
	};
	draw();
}
