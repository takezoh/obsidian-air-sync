import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, __ui } from "../__mocks__/obsidian";
import { DEFAULT_SETTINGS } from "../settings";
import type AirSyncPlugin from "../main";
import type { App as ObsidianApp } from "../platform/obsidian";
import { AirSyncSettingTab } from "./settings";

function pluginFixture() {
	return {
		app: { vault: { configDir: "config-dir" } },
		manifest: { id: "air-sync" },
		settings: { ...DEFAULT_SETTINGS },
		saveSettings: vi.fn().mockResolvedValue(undefined),
		rescan: vi.fn(),
		backendManager: {},
	};
}

describe("AirSyncSettingTab conflict strategy", () => {
	beforeEach(() => {
		__ui.dropdowns = [];
		vi.stubGlobal("document", {
			createElement: () => ({ empty: () => {} }),
		});
	});

	it("renders the safety explanation and strategies in policy order, then saves Prefer local", async () => {
		const plugin = pluginFixture();
		const tab = new AirSyncSettingTab(
			new App() as unknown as ObsidianApp,
			plugin as unknown as AirSyncPlugin,
		);

		tab.display();
		const dropdown = __ui.dropdowns.find((item) => item.name === "Conflict strategy");

		expect(dropdown?.description).toContain("Prefer local applies only to conflicts");
		expect(dropdown?.description).toContain("proven two-sided edits");
		expect(dropdown?.description).toContain("preserves both versions");
		expect(dropdown?.options.map(({ value }) => value)).toEqual([
			"auto_merge", "prefer_local", "duplicate",
		]);
		await dropdown?.change("prefer_local");
		expect(plugin.settings.conflictStrategy).toBe("prefer_local");
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
	});
});
