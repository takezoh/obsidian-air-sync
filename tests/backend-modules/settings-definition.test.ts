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
	type: "toggle",
	defaultValue: false,
};

const choice: BackendSettingField = {
	key: "choice",
	label: "Choice",
	type: "select",
	options: [
		{ value: "a", label: "A" },
		{ value: "b", label: "B" },
	],
};

const clientId: BackendSettingField = {
	key: "clientId",
	label: "Client ID",
	type: "text",
	visibleWhen: { field: "authMode", equals: true },
};

const clientSecret: BackendSettingField = {
	key: "clientSecret",
	label: "Client secret",
	type: "secret_reference",
	description: "Name of the SecretStorage entry.",
	visibleWhen: { field: "authMode", equals: true },
};

const definition: BackendSettingsDefinition = {
	fields: [mode, clientId, clientSecret],
};

describe("settings-definition visibility", () => {
	it("shows a field only when its condition currently holds", () => {
		expect(isFieldVisible(mode, {})).toBe(true);
		expect(isFieldVisible(clientId, { authMode: false })).toBe(false);
		expect(isFieldVisible(clientId, { authMode: true })).toBe(true);
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
		expect(visibleFields(definition, { authMode: false }).map((f) => f.key)).toEqual([
			"authMode",
		]);
		expect(visibleFields(definition, { authMode: true }).map((f) => f.key)).toEqual([
			"authMode",
			"clientId",
			"clientSecret",
		]);
	});
});

describe("resolveFieldValue", () => {
	it("prefers the stored value and falls back to the declared default", () => {
		expect(resolveFieldValue(mode, {})).toBe(false);
		expect(resolveFieldValue(mode, { authMode: true })).toBe(true);
		expect(resolveFieldValue(clientId, {})).toBeUndefined();
	});
});

describe("validateSettingField", () => {
	it("accepts an absent value", () => {
		expect(validateSettingField(mode, undefined)).toBeNull();
		expect(validateSettingField(mode, null)).toBeNull();
	});

	it("requires a select value to be declared", () => {
		expect(validateSettingField(choice, "a")).toBeNull();
		expect(validateSettingField(choice, "other")).toMatch(/available options/);
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
		const config: JsonObject = { authMode: false, clientId: 99 };
		expect(validateBackendSettings(definition, config)).toEqual([]);
	});

	it("reports each invalid visible field with its key", () => {
		const config: JsonObject = { authMode: true, clientId: 99, clientSecret: 5 };
		const issues = validateBackendSettings(definition, config);
		expect(issues.map((issue) => issue.key)).toEqual(["clientId", "clientSecret"]);
		expect(issues.every((issue) => /must be text/.test(issue.message))).toBe(true);
	});
});
