import { describe, it, expect, beforeAll } from "vitest";
import { initRegistry, getAllBackendProviders } from "../fs/registry";
import { getBackendSettingsRenderer } from "./backend-settings";
import type { ISecretStore } from "../fs/secret-store";

// A provider that lands in the registry with no matching settings renderer shows
// an EMPTY settings panel — a silent UX drift that nothing else catches today.
// This pins "every registered backend has a renderer" so adding a backend without
// wiring its UI fails the gate. (Groundwork for B2 registry unification.)

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
