import { describe, it, expect, beforeAll } from "vitest";
import { initRegistry, getAllBackendProviders } from "../fs/registry";
import { getBackendSettingsRenderer } from "./backend-settings";
import type { ISecretStore } from "../fs/secret-store";

// A provider that lands in the registry with no settings renderer shows an EMPTY
// settings panel — a silent UX drift. Since B2 the renderer is resolved straight
// from the provider (provider.createSettingsRenderer), so this pins that every
// registered backend actually implements it — adding a backend without wiring its
// UI fails the gate.

const mockSecretStore: ISecretStore = {
	getSecret: () => null,
	setSecret: () => {},
};

describe("backend registry ↔ settings-renderer integrity", () => {
	beforeAll(() => {
		initRegistry(mockSecretStore);
	});

	it("every registered backend provider has a matching settings renderer", () => {
		const providers = getAllBackendProviders();
		expect(providers.length).toBeGreaterThan(0);

		for (const provider of providers) {
			const renderer = getBackendSettingsRenderer(provider.type);
			expect(
				renderer,
				`No settings renderer registered for backend "${provider.type}" ` +
					`(${provider.displayName}) — it would render an empty settings panel. ` +
					`Register one in ui/backend-settings.ts.`,
			).toBeDefined();
			expect(renderer?.backendType).toBe(provider.type);
		}
	});
});
