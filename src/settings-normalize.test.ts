import { describe, it, expect } from "vitest";
import { liftActiveBackendData } from "./settings-normalize";
import { mockSettings } from "./__mocks__/sync-test-helpers";

const KNOWN = ["googledrive", "googledrive-custom"];

describe("liftActiveBackendData", () => {
	it("lifts the active backend's entry and drops the others", () => {
		const settings = mockSettings({
			backendType: "googledrive",
			backendData: {
				googledrive: { remoteVaultFolderId: "A" },
				"googledrive-custom": { customClientId: "x" },
			},
		});

		const changed = liftActiveBackendData(settings, KNOWN);

		expect(changed).toBe(true);
		expect(settings.backendData).toEqual({ remoteVaultFolderId: "A" });
	});

	it("resets to {} when the active type is absent from the old map", () => {
		const settings = mockSettings({
			backendType: "googledrive",
			backendData: { "googledrive-custom": { customClientId: "x" } },
		});

		const changed = liftActiveBackendData(settings, KNOWN);

		expect(changed).toBe(true);
		expect(settings.backendData).toEqual({});
	});

	it("leaves an already-flat bag untouched", () => {
		const settings = mockSettings({
			backendType: "googledrive",
			backendData: { remoteVaultFolderId: "A", accessTokenExpiry: 123 },
		});

		const changed = liftActiveBackendData(settings, KNOWN);

		expect(changed).toBe(false);
		expect(settings.backendData).toEqual({ remoteVaultFolderId: "A", accessTokenExpiry: 123 });
	});

	it("treats an empty bag as already-normalized", () => {
		const settings = mockSettings({ backendType: "googledrive", backendData: {} });
		expect(liftActiveBackendData(settings, KNOWN)).toBe(false);
		expect(settings.backendData).toEqual({});
	});
});
