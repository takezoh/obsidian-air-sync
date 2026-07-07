import { describe, it, expect } from "vitest";
import { computeScopeFingerprint } from "./scope-fingerprint";
import { mockSettings } from "../__mocks__/sync-test-helpers";

describe("computeScopeFingerprint", () => {
	it("is deterministic for identical inputs", async () => {
		const settings = mockSettings({ syncDotPaths: [".templates"], ignorePatterns: ["*.tmp"] });
		const a = await computeScopeFingerprint(settings, ".cfg", "air-sync");
		const b = await computeScopeFingerprint(settings, ".cfg", "air-sync");
		expect(a).toBe(b);
	});

	it("is independent of syncDotPaths order (it's a set)", async () => {
		const a = await computeScopeFingerprint(
			mockSettings({ syncDotPaths: [".templates", ".foo"] }),
			".cfg",
			"air-sync",
		);
		const b = await computeScopeFingerprint(
			mockSettings({ syncDotPaths: [".foo", ".templates"] }),
			".cfg",
			"air-sync",
		);
		expect(a).toBe(b);
	});

	it("changes when ignorePatterns order changes (gitignore last-match-wins is order-sensitive)", async () => {
		const a = await computeScopeFingerprint(
			mockSettings({ ignorePatterns: ["*.tmp", "!keep.tmp"] }),
			".cfg",
			"air-sync",
		);
		const b = await computeScopeFingerprint(
			mockSettings({ ignorePatterns: ["!keep.tmp", "*.tmp"] }),
			".cfg",
			"air-sync",
		);
		expect(a).not.toBe(b);
	});

	it("changes when enableConfigSync toggles", async () => {
		const off = await computeScopeFingerprint(
			mockSettings({ enableConfigSync: false }),
			".cfg",
			"air-sync",
		);
		const on = await computeScopeFingerprint(
			mockSettings({ enableConfigSync: true }),
			".cfg",
			"air-sync",
		);
		expect(off).not.toBe(on);
	});

	it("changes when syncDotPaths content changes", async () => {
		const a = await computeScopeFingerprint(mockSettings({ syncDotPaths: [] }), ".cfg", "air-sync");
		const b = await computeScopeFingerprint(
			mockSettings({ syncDotPaths: [".templates"] }),
			".cfg",
			"air-sync",
		);
		expect(a).not.toBe(b);
	});

	it("changes when ignorePatterns content changes", async () => {
		const a = await computeScopeFingerprint(mockSettings({ ignorePatterns: [] }), ".cfg", "air-sync");
		const b = await computeScopeFingerprint(
			mockSettings({ ignorePatterns: ["*.tmp"] }),
			".cfg",
			"air-sync",
		);
		expect(a).not.toBe(b);
	});

	it("changes when configDir changes", async () => {
		const settings = mockSettings();
		const a = await computeScopeFingerprint(settings, ".cfg", "air-sync");
		const b = await computeScopeFingerprint(settings, ".cfg-custom", "air-sync");
		expect(a).not.toBe(b);
	});

	it("changes when pluginId changes", async () => {
		const settings = mockSettings();
		const a = await computeScopeFingerprint(settings, ".cfg", "air-sync");
		const b = await computeScopeFingerprint(settings, ".cfg", "air-sync-2");
		expect(a).not.toBe(b);
	});
});
