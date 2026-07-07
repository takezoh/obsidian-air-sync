import { describe, it, expect } from "vitest";
import ignore from "ignore";
import { mockSettings } from "./__mocks__/sync-test-helpers";
import {
	getConfigSyncIgnorePatterns,
	getEffectiveSyncDotPaths,
	getEffectiveIgnorePatterns,
	isOwnPluginDataPath,
} from "./config-sync";

// A vault's configDir is user-configurable, so tests use a value distinct from
// the (arbitrary) Obsidian default to prove the logic doesn't hardcode it.
const TEST_CONFIG_DIR = "cfg";
const TEST_PLUGIN_ID = "test-plugin";

describe("getEffectiveSyncDotPaths", () => {
	it("leaves syncDotPaths unchanged when config sync is disabled", () => {
		const settings = mockSettings({ enableConfigSync: false, syncDotPaths: [".templates"] });
		expect(getEffectiveSyncDotPaths(settings, TEST_CONFIG_DIR)).toEqual([".templates"]);
	});

	it("appends the config directory when config sync is enabled", () => {
		const settings = mockSettings({ enableConfigSync: true, syncDotPaths: [".templates"] });
		expect(getEffectiveSyncDotPaths(settings, TEST_CONFIG_DIR)).toEqual([
			".templates",
			TEST_CONFIG_DIR,
		]);
	});
});

describe("getEffectiveIgnorePatterns", () => {
	it("leaves ignorePatterns unchanged when config sync is disabled", () => {
		const settings = mockSettings({ enableConfigSync: false, ignorePatterns: ["*.tmp"] });
		expect(getEffectiveIgnorePatterns(settings, TEST_CONFIG_DIR, TEST_PLUGIN_ID)).toEqual(["*.tmp"]);
	});

	it("prepends the built-in patterns when config sync is enabled", () => {
		const settings = mockSettings({ enableConfigSync: true, ignorePatterns: ["*.tmp"] });
		expect(getEffectiveIgnorePatterns(settings, TEST_CONFIG_DIR, TEST_PLUGIN_ID)).toEqual([
			...getConfigSyncIgnorePatterns(TEST_CONFIG_DIR, TEST_PLUGIN_ID),
			"*.tmp",
		]);
	});
});

describe("getConfigSyncIgnorePatterns", () => {
	it("escapes glob-special characters in configDir and pluginId", () => {
		// A configDir starting with "!" or "#" is a legal folder name (Obsidian's
		// config-dir-redirect marker file imposes no character restrictions), but
		// unescaped it would be read as a gitignore negation/comment instead of a
		// literal path, silently disabling every built-in pattern.
		const patterns = getConfigSyncIgnorePatterns("!cfg", "plugin[x]");
		const matcher = ignore().add(patterns);

		expect(matcher.ignores("!cfg/workspace.json")).toBe(true);
		expect(matcher.ignores("!cfg/plugins/plugin[x]/data.json")).toBe(true);
		expect(matcher.ignores("!cfg/plugins/other-plugin/data.json")).toBe(false);
	});
});

describe("isOwnPluginDataPath", () => {
	it("matches only this plugin's own data.json under the config directory", () => {
		expect(isOwnPluginDataPath(`${TEST_CONFIG_DIR}/plugins/${TEST_PLUGIN_ID}/data.json`, TEST_CONFIG_DIR, TEST_PLUGIN_ID)).toBe(true);
		expect(isOwnPluginDataPath(`${TEST_CONFIG_DIR}/plugins/other-plugin/data.json`, TEST_CONFIG_DIR, TEST_PLUGIN_ID)).toBe(false);
		expect(isOwnPluginDataPath(`${TEST_CONFIG_DIR}/workspace.json`, TEST_CONFIG_DIR, TEST_PLUGIN_ID)).toBe(false);
	});
});
