import { describe, expect, it } from "vitest";
import {
	createLegacyPhysicalKeyResolver,
	legacyDbNamePrefix,
	legacyStorageType,
} from "../../src/fs/modules/compatibility/legacy-storage-profiles";

describe("legacy storage profiles — physical keys and DB prefixes", () => {
	const cases: readonly [string, "default" | "custom", string, string][] = [
		// [module, authMode, legacy storage type, db prefix]
		["googledrive", "default", "googledrive", "air-sync-googledrive"],
		// Google's built-in and custom apps shared one physical namespace.
		["googledrive", "custom", "googledrive", "air-sync-googledrive"],
		["onedrive", "default", "onedrive", "air-sync-onedrive"],
		["onedrive", "custom", "onedrive-custom", "air-sync-onedrive-custom"],
		["dropbox", "default", "dropbox", "air-sync-dropbox"],
		["dropbox", "custom", "dropbox-custom", "air-sync-dropbox-custom"],
	];

	for (const [moduleId, authMode, storageType, dbPrefix] of cases) {
		it(`${moduleId}/${authMode} keeps ${storageType}`, () => {
			expect(legacyStorageType(moduleId, authMode)).toBe(storageType);
			expect(legacyDbNamePrefix(moduleId, authMode)).toBe(dbPrefix);
		});
	}

	it("resolves logical keys to the exact legacy SecretStorage names", () => {
		const builtIn = createLegacyPhysicalKeyResolver("default");
		expect(builtIn("googledrive", "refresh")).toBe("air-sync-googledrive-refresh-token");
		expect(builtIn("googledrive", "access")).toBe("air-sync-googledrive-access-token");
		expect(builtIn("onedrive", "refresh")).toBe("air-sync-onedrive-refresh-token");
		expect(builtIn("dropbox", "refresh")).toBe("air-sync-dropbox-refresh-token");

		const custom = createLegacyPhysicalKeyResolver("custom");
		// Google custom shares the built-in key (unchanged).
		expect(custom("googledrive", "refresh")).toBe("air-sync-googledrive-refresh-token");
		expect(custom("onedrive", "refresh")).toBe("air-sync-onedrive-custom-refresh-token");
		expect(custom("dropbox", "refresh")).toBe("air-sync-dropbox-custom-refresh-token");
	});

	it("accepts a legacy alias id as the module argument too", () => {
		// The resolver runs during/after alias normalization; a caller may still pass
		// the persisted legacy spelling and must land on the same physical key.
		const custom = createLegacyPhysicalKeyResolver("custom");
		expect(custom("dropbox-custom", "refresh")).toBe("air-sync-dropbox-custom-refresh-token");
	});
});
