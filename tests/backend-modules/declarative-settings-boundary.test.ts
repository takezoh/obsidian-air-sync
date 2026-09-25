import { describe, expect, it } from "vitest";
import coreViewSource from "../../src/ui/backend-module-settings.ts?raw";
import settingsDefinitionSource from "../../src/fs/modules/settings-definition.ts?raw";
import folderPickSource from "../../src/fs/modules/folder-pick-host.ts?raw";
import connectionHostSource from "../../src/fs/modules/connection-host.ts?raw";

/**
 * The declarative settings/auth/binding path is what lets a module avoid
 * Obsidian UI entirely. This guard pins that core renders a module's
 * `BackendSettingsDefinition` without importing any provider-specific renderer,
 * and that the module-side helpers never reach for Obsidian, `App`,
 * `AirSyncSettings`, or `BackendManager` internals.
 */
const PROVIDER_OR_INTERNAL = [
	"/googledrive/",
	"/onedrive/",
	"/dropbox/",
	"backend-manager",
	"settings-renderer",
	"AirSyncSettings",
	"getBackendSettingsRenderer",
];

const MODULE_OWNED = [
	["settings-definition", settingsDefinitionSource],
	["folder-pick-host", folderPickSource],
	["connection-host", connectionHostSource],
] as const;

describe("declarative settings boundary", () => {
	it("renders a module's settings without a provider renderer import", () => {
		for (const forbidden of PROVIDER_OR_INTERNAL) {
			expect(coreViewSource).not.toContain(forbidden);
		}
	});

	it("keeps module-side helper files free of Obsidian/App/settings internals", () => {
		for (const [name, source] of MODULE_OWNED) {
			expect(source, `${name} must not import obsidian`).not.toMatch(/from\s+["']obsidian["']/);
			for (const forbidden of PROVIDER_OR_INTERNAL) {
				expect(source, `${name} must not reference ${forbidden}`).not.toContain(forbidden);
			}
		}
	});
});
