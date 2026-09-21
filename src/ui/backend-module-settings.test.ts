import { beforeEach, describe, expect, it, vi } from "vitest";
import { __ui } from "../__mocks__/obsidian";
import { renderBackendSettings } from "./backend-module-settings";
import type { BackendSettingsHost } from "./backend-module-settings";
import type { BackendSettingsDefinition, JsonObject, JsonValue } from "../backend-api";

function container(): HTMLElement {
	return { empty: () => undefined } as unknown as HTMLElement;
}

function host(initial: JsonObject) {
	let bag = initial;
	const setValue = vi.fn((key: string, value: JsonValue) => {
		bag = { ...bag, [key]: value };
	});
	const settingsHost: BackendSettingsHost = {
		config: () => bag,
		setValue,
	};
	return { settingsHost, setValue, read: () => bag };
}

const definition: BackendSettingsDefinition = {
	fields: [
		{
			key: "authMode",
			label: "Mode",
			type: "select",
			defaultValue: "default",
			options: [
				{ value: "default", label: "Default" },
				{ value: "custom", label: "Custom" },
			],
		},
		{
			key: "clientId",
			label: "Client ID",
			type: "text",
			description: "The app's public client id.",
			visibleWhen: { field: "authMode", equals: "custom" },
		},
		{
			key: "clientSecret",
			label: "Client secret name",
			type: "secret_reference",
			description: "Name of the SecretStorage entry — not the secret itself.",
			visibleWhen: { field: "authMode", equals: "custom" },
		},
		{
			key: "enabled",
			label: "Enabled",
			type: "toggle",
		},
	],
};

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	__ui.texts = [];
	__ui.dropdowns = [];
	__ui.toggles = [];
});

describe("renderBackendSettings", () => {
	it("renders the visible fields with the Obsidian Setting controls", () => {
		const { settingsHost } = host({ authMode: "custom", enabled: true });
		renderBackendSettings(container(), definition, settingsHost);

		expect(__ui.dropdowns.map((d) => d.name)).toEqual(["Mode"]);
		expect(__ui.dropdowns[0]?.options.map((o) => o.value)).toEqual(["default", "custom"]);
		expect(__ui.dropdowns[0]?.value).toBe("custom");
		expect(__ui.texts.map((t) => t.name)).toEqual(["Client ID", "Client secret name"]);
		expect(__ui.toggles.map((t) => t.name)).toEqual(["Enabled"]);
		expect(__ui.toggles[0]?.value).toBe(true);
	});

	it("hides a field whose visibleWhen condition does not hold", () => {
		const { settingsHost } = host({ authMode: "default" });
		renderBackendSettings(container(), definition, settingsHost);
		expect(__ui.texts).toHaveLength(0);
		expect(__ui.dropdowns).toHaveLength(1);
	});

	it("shows the declared default for an absent select value", () => {
		const { settingsHost } = host({});
		renderBackendSettings(container(), definition, settingsHost);
		expect(__ui.dropdowns[0]?.value).toBe("default");
	});

	it("writes a changed value through the host and re-renders", async () => {
		const { settingsHost, setValue, read } = host({ authMode: "default" });
		renderBackendSettings(container(), definition, settingsHost);

		await __ui.dropdowns[0]?.change("custom");
		await flush();

		expect(setValue).toHaveBeenCalledWith("authMode", "custom");
		expect(read().authMode).toBe("custom");
		// Re-render now reveals the custom-mode fields.
		expect(__ui.texts.at(-2)?.name).toBe("Client ID");
		expect(__ui.texts.at(-1)?.name).toBe("Client secret name");
	});

	it("renders a secret reference as a non-secret text field", () => {
		const { settingsHost } = host({ authMode: "custom", clientSecret: "my-ref" });
		renderBackendSettings(container(), definition, settingsHost);
		const secretField = __ui.texts.find((t) => t.name === "Client secret name");
		expect(secretField?.value).toBe("my-ref");
		expect(secretField?.description).toContain("not the secret itself");
	});

	it("appends a validation issue to the field description", () => {
		const { settingsHost } = host({ enabled: "not-a-boolean" });
		renderBackendSettings(container(), definition, settingsHost);
		const toggle = __ui.toggles[0];
		expect(toggle?.description).toContain("must be on or off");
	});
});
