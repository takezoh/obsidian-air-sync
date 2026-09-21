import { describe, expect, it } from "vitest";
import {
	isFieldVisible,
	resolveFieldValue,
	validateBackendSettings,
	validateSettingField,
	visibleFields,
} from "../../src/fs/modules/settings-definition";
import type {
	BackendSettingField,
	BackendSettingsDefinition,
	JsonObject,
} from "../../src/backend-api";

const mode: BackendSettingField = {
	key: "authMode",
	label: "Mode",
	type: "select",
	defaultValue: "default",
	options: [
		{ value: "default", label: "Default" },
		{ value: "custom", label: "Custom" },
	],
};

const clientId: BackendSettingField = {
	key: "clientId",
	label: "Client ID",
	type: "text",
	visibleWhen: { field: "authMode", equals: "custom" },
};

const clientSecret: BackendSettingField = {
	key: "clientSecret",
	label: "Client secret",
	type: "secret_reference",
	description: "Name of the SecretStorage entry.",
	visibleWhen: { field: "authMode", equals: "custom" },
};

const definition: BackendSettingsDefinition = {
	fields: [mode, clientId, clientSecret],
};

describe("settings-definition visibility", () => {
	it("shows a field only when its condition currently holds", () => {
		expect(isFieldVisible(mode, {})).toBe(true);
		expect(isFieldVisible(clientId, { authMode: "default" })).toBe(false);
		expect(isFieldVisible(clientId, { authMode: "custom" })).toBe(true);
		expect(isFieldVisible(clientId, {})).toBe(false);
	});

	it("matches nested JSON conditions deeply, not by reference", () => {
		const nested: BackendSettingField = {
			key: "x",
			label: "X",
			type: "text",
			visibleWhen: { field: "combo", equals: { a: [1, 2] } },
		};
		expect(isFieldVisible(nested, { combo: { a: [1, 2] } })).toBe(true);
		expect(isFieldVisible(nested, { combo: { a: [2, 1] } })).toBe(false);
		expect(isFieldVisible(nested, {})).toBe(false);
	});

	it("filters to the visibly-applicable fields in declaration order", () => {
		expect(visibleFields(definition, { authMode: "default" }).map((f) => f.key)).toEqual([
			"authMode",
		]);
		expect(visibleFields(definition, { authMode: "custom" }).map((f) => f.key)).toEqual([
			"authMode",
			"clientId",
			"clientSecret",
		]);
	});
});

describe("resolveFieldValue", () => {
	it("prefers the stored value and falls back to the declared default", () => {
		expect(resolveFieldValue(mode, {})).toBe("default");
		expect(resolveFieldValue(mode, { authMode: "custom" })).toBe("custom");
		expect(resolveFieldValue(clientId, {})).toBeUndefined();
	});
});

describe("validateSettingField", () => {
	it("accepts an absent value", () => {
		expect(validateSettingField(mode, undefined)).toBeNull();
		expect(validateSettingField(mode, null)).toBeNull();
	});

	it("requires a select value to be declared", () => {
		expect(validateSettingField(mode, "custom")).toBeNull();
		expect(validateSettingField(mode, "other")).toMatch(/available options/);
	});

	it("requires toggle and text values of the right type", () => {
		const toggle: BackendSettingField = { key: "t", label: "T", type: "toggle" };
		const text: BackendSettingField = { key: "s", label: "S", type: "text" };
		expect(validateSettingField(toggle, true)).toBeNull();
		expect(validateSettingField(toggle, "yes")).toMatch(/on or off/);
		expect(validateSettingField(text, "v")).toBeNull();
		expect(validateSettingField(text, 3)).toMatch(/must be text/);
	});
});

describe("validateBackendSettings", () => {
	it("validates only the visible fields, so a hidden stale value is ignored", () => {
		const config: JsonObject = { authMode: "default", clientId: 99 };
		expect(validateBackendSettings(definition, config)).toEqual([]);
	});

	it("reports each invalid visible field with its key", () => {
		const config: JsonObject = { authMode: "custom", clientId: 99, clientSecret: 5 };
		const issues = validateBackendSettings(definition, config);
		expect(issues.map((issue) => issue.key)).toEqual(["clientId", "clientSecret"]);
		expect(issues.every((issue) => /must be text/.test(issue.message))).toBe(true);
	});
});
