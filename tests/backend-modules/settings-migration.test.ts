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
	const cases: readonly [string, string, boolean][] = [
		["googledrive", "googledrive", false],
		["googledrive-custom", "googledrive", true],
		["onedrive", "onedrive", false],
		["onedrive-custom", "onedrive", true],
		["dropbox", "dropbox", false],
		["dropbox-custom", "dropbox", true],
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
		// A canonical id whose bag already says custom keeps custom (the string is
		// converted, so the run reports a change).
		const canonicalCustom = withBag("dropbox", { authMode: "custom" });
		expect(normalizeBackendModuleSettings(canonicalCustom)).toBe(true);
		expect(canonicalCustom.backendData.authMode).toBe(true);

		// A legacy alias whose bag already says default keeps default (the
		// contradiction is surfaced, not silently rewritten).
		const aliasDefault = withBag("dropbox-custom", { authMode: "default" });
		expect(normalizeBackendModuleSettings(aliasDefault)).toBe(true);
		expect(aliasDefault.backendType).toBe("dropbox");
		expect(aliasDefault.backendData.authMode).toBe(false);
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
			authMode: true,
			customClientId: "my-client-secret-name",
			customClientSecret: "my-secret-name",
			customScope: "drive.file",
			customRedirectUri: "obsidian://air-sync-auth",
			accessTokenExpiry: 123,
		});
	});
});

describe("normalizeBackendModuleSettings — main-branch compatibility", () => {
	// `main` stores `backendData.authMode` as the STRING "default" | "custom" and may
	// still carry a legacy `*-custom` backendType. Both must reshape to the canonical
	// id + boolean, leaving every other field intact, and be idempotent.
	const cases: readonly [string, "custom" | "default", boolean][] = [
		["dropbox-custom", "custom", true],
		["dropbox-custom", "default", false],
		["dropbox", "custom", true],
		["dropbox", "default", false],
	];

	for (const [backendType, stored, expected] of cases) {
		it(`${backendType} + authMode:${stored} -> dropbox/${expected}, idempotently`, () => {
			const settings = withBag(backendType, {
				authMode: stored,
				remoteVaultFolderId: "id:abc",
				customClientId: "APPKEY",
			});
			expect(normalizeBackendModuleSettings(settings)).toBe(true);
			expect(settings.backendType).toBe("dropbox");
			expect(settings.backendData.authMode).toBe(expected);
			expect(settings.backendData).toMatchObject({
				remoteVaultFolderId: "id:abc",
				customClientId: "APPKEY",
			});
			expect(normalizeBackendModuleSettings(settings)).toBe(false);
		});
	}

	it("leaves an already-boolean authMode unchanged", () => {
		const settings = withBag("dropbox", { authMode: true, remoteVaultFolderId: "id:abc" });
		expect(normalizeBackendModuleSettings(settings)).toBe(false);
		expect(settings.backendData.authMode).toBe(true);
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
		expect(settings.backendData).toMatchObject({ authMode: true, customClientId: "APPKEY" });
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
		const settings = withBag("dropbox", { authMode: false, remoteVaultFolderId: "id:abc" }, "dropbox:id:abc");
		expect(normalizeBackendModuleSettings(settings)).toBe(false);
		expect(settings.lastSyncedIdentity).toBe("dropbox:id:abc");
	});

	it("never clears an identity when there is no bound target", () => {
		const settings = withBag("dropbox-custom", {}, "dropbox-custom:id:abc");
		normalizeBackendModuleSettings(settings);
		expect(settings.lastSyncedIdentity).toBe("dropbox-custom:id:abc");
	});
});
