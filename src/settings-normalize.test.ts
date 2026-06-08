import { describe, it, expect } from "vitest";
import { liftActiveBackendData, normalizeConflictStrategy } from "./settings-normalize";
import { mockSettings } from "./__mocks__/sync-test-helpers";

const KNOWN = ["googledrive", "googledrive-custom"];

describe("normalizeConflictStrategy", () => {
	it("leaves a valid strategy untouched", () => {
		for (const strategy of ["auto_merge", "duplicate"] as const) {
			const settings = mockSettings({ conflictStrategy: strategy });
			expect(normalizeConflictStrategy(settings)).toBe(false);
			expect(settings.conflictStrategy).toBe(strategy);
		}
	});

	it("maps the retired 'ask' to 'duplicate' (what it actually did)", () => {
		const settings = mockSettings({ conflictStrategy: "ask" as never });
		expect(normalizeConflictStrategy(settings)).toBe(true);
		expect(settings.conflictStrategy).toBe("duplicate");
	});

	it("coerces any other unknown value to the default 'auto_merge'", () => {
		const settings = mockSettings({ conflictStrategy: "nonsense" as never });
		expect(normalizeConflictStrategy(settings)).toBe(true);
		expect(settings.conflictStrategy).toBe("auto_merge");
	});
});

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
