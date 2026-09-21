import { describe, expect, it } from "vitest";
import { mockSettings } from "../../src/__mocks__/sync-test-helpers";
import { liftActiveBackendData, normalizeBackendModuleSettings } from "../../src/settings-normalize";
import type { AirSyncSettings } from "../../src/settings";

const SIX_TYPES = [
	"googledrive",
	"googledrive-custom",
	"onedrive",
	"onedrive-custom",
	"dropbox",
	"dropbox-custom",
];

function withBag(
	backendType: string,
	backendData: Record<string, unknown> = {},
	lastSyncedIdentity = "",
): AirSyncSettings {
	return mockSettings({ backendType, backendData, lastSyncedIdentity });
}

describe("normalizeBackendModuleSettings — six legacy selections", () => {
	const cases: readonly [string, string, "default" | "custom"][] = [
		["googledrive", "googledrive", "default"],
		["googledrive-custom", "googledrive", "custom"],
		["onedrive", "onedrive", "default"],
		["onedrive-custom", "onedrive", "custom"],
		["dropbox", "dropbox", "default"],
		["dropbox-custom", "dropbox", "custom"],
	];

	for (const [legacy, canonical, authMode] of cases) {
		it(`maps ${legacy} -> ${canonical}/${authMode}`, () => {
			const settings = withBag(legacy, { remoteVaultFolderId: "id:abc" });
			// Every legacy selection arrives without an authMode, so filling it (and
			// canonicalizing the id for aliases) always reports a change.
			expect(normalizeBackendModuleSettings(settings)).toBe(true);
			expect(settings.backendType).toBe(canonical);
			expect(settings.backendData.authMode).toBe(authMode);
			// Unrelated fields are preserved.
			expect(settings.backendData.remoteVaultFolderId).toBe("id:abc");
		});
	}

	it("is idempotent — a second run reports no change for every case", () => {
		for (const [legacy] of cases) {
			const settings = withBag(legacy, { remoteVaultFolderId: "id:abc" });
			normalizeBackendModuleSettings(settings);
			expect(normalizeBackendModuleSettings(settings)).toBe(false);
		}
	});

	it("never hides a stored authMode contradiction", () => {
		// A canonical id whose bag already says custom keeps custom.
		const canonicalCustom = withBag("dropbox", { authMode: "custom" });
		expect(normalizeBackendModuleSettings(canonicalCustom)).toBe(false);
		expect(canonicalCustom.backendData.authMode).toBe("custom");

		// A legacy alias whose bag already says default keeps default (the
		// contradiction is surfaced, not silently rewritten).
		const aliasDefault = withBag("dropbox-custom", { authMode: "default" });
		expect(normalizeBackendModuleSettings(aliasDefault)).toBe(true);
		expect(aliasDefault.backendType).toBe("dropbox");
		expect(aliasDefault.backendData.authMode).toBe("default");
	});

	it("preserves user-managed secret references and other fields", () => {
		const settings = withBag("googledrive-custom", {
			customClientId: "my-client-secret-name",
			customClientSecret: "my-secret-name",
			customScope: "drive.file",
			customRedirectUri: "obsidian://air-sync-auth",
			accessTokenExpiry: 123,
		});
		normalizeBackendModuleSettings(settings);
		expect(settings.backendData).toMatchObject({
			authMode: "custom",
			customClientId: "my-client-secret-name",
			customClientSecret: "my-secret-name",
			customScope: "drive.file",
			customRedirectUri: "obsidian://air-sync-auth",
			accessTokenExpiry: 123,
		});
	});
});

describe("normalizeBackendModuleSettings — legacy nested bag", () => {
	it("lifts the active alias bag, then canonicalizes it", () => {
		const settings = mockSettings({
			backendType: "dropbox-custom",
			backendData: {
				"dropbox-custom": { customClientId: "APPKEY", remoteVaultFolderId: "id:abc" },
				googledrive: { remoteVaultFolderId: "other" },
			},
		});
		expect(liftActiveBackendData(settings, SIX_TYPES)).toBe(true);
		expect(settings.backendData).toEqual({
			customClientId: "APPKEY",
			remoteVaultFolderId: "id:abc",
		});
		expect(normalizeBackendModuleSettings(settings)).toBe(true);
		expect(settings.backendType).toBe("dropbox");
		expect(settings.backendData).toMatchObject({ authMode: "custom", customClientId: "APPKEY" });
	});
});

describe("normalizeBackendModuleSettings — lastSyncedIdentity", () => {
	it("canonicalizes the prefix for the SAME connection (alias-only change)", () => {
		const settings = withBag(
			"dropbox-custom",
			{ remoteVaultFolderId: "id:abc" },
			"dropbox-custom:id:abc",
		);
		expect(normalizeBackendModuleSettings(settings)).toBe(true);
		expect(settings.lastSyncedIdentity).toBe("dropbox:id:abc");
	});

	it("leaves a different root untouched so the ordinary reset still runs", () => {
		const settings = withBag(
			"dropbox-custom",
			{ remoteVaultFolderId: "id:abc" },
			"dropbox-custom:id:xyz",
		);
		normalizeBackendModuleSettings(settings);
		expect(settings.lastSyncedIdentity).toBe("dropbox-custom:id:xyz");
	});

	it("leaves a different service's identity untouched", () => {
		const settings = withBag(
			"dropbox-custom",
			{ remoteVaultFolderId: "id:abc" },
			"googledrive-custom:id:abc",
		);
		normalizeBackendModuleSettings(settings);
		expect(settings.lastSyncedIdentity).toBe("googledrive-custom:id:abc");
	});

	it("does not rewrite an already-canonical identity", () => {
		const settings = withBag("dropbox", { authMode: "default", remoteVaultFolderId: "id:abc" }, "dropbox:id:abc");
		expect(normalizeBackendModuleSettings(settings)).toBe(false);
		expect(settings.lastSyncedIdentity).toBe("dropbox:id:abc");
	});

	it("never clears an identity when there is no bound target", () => {
		const settings = withBag("dropbox-custom", {}, "dropbox-custom:id:abc");
		normalizeBackendModuleSettings(settings);
		expect(settings.lastSyncedIdentity).toBe("dropbox-custom:id:abc");
	});
});
